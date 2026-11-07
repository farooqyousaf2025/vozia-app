import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { many, one, query } from '../config/db';
import { MediaAssetRow } from '../types/db';
import { ApiError } from '../utils/http';

/**
 * Operator-uploaded art, animation and sound.
 *
 * Two rules shape this file. Nothing a client sends is trusted to describe itself: the format,
 * the extension, the content type and the byte cap all come from the bytes, and the file name
 * on disk is generated here. And an upload is only ever *referenced* by URL, exactly like the
 * generated art in `backend/public`, so a gift added today renders on an installed phone with
 * no app update — which is the whole point of letting the operator add gifts at all.
 */

export const MEDIA_KINDS = ['GIFT_ICON', 'GIFT_ANIMATION', 'GIFT_SOUND', 'EFFECT', 'RIDE', 'BANNER', 'BADGE', 'WALLPAPER', 'EMOJI'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

type Format = 'png' | 'gif' | 'webp' | 'jpeg' | 'lottie' | 'svga' | 'mp4' | 'wav' | 'mp3' | 'm4a';

const FORMATS: Record<Format, { contentType: string; ext: string }> = {
  png: { contentType: 'image/png', ext: 'png' },
  gif: { contentType: 'image/gif', ext: 'gif' },
  webp: { contentType: 'image/webp', ext: 'webp' },
  jpeg: { contentType: 'image/jpeg', ext: 'jpg' },
  lottie: { contentType: 'application/json', ext: 'json' },
  // A .svga is a zip of sprite PNGs plus a protobuf scene; nothing in a browser plays it, so it is
  // served as opaque bytes and only the app's SVGA renderer opens it.
  svga: { contentType: 'application/octet-stream', ext: 'svga' },
  mp4: { contentType: 'video/mp4', ext: 'mp4' },
  wav: { contentType: 'audio/wav', ext: 'wav' },
  mp3: { contentType: 'audio/mpeg', ext: 'mp3' },
  m4a: { contentType: 'audio/mp4', ext: 'm4a' },
};

/**
 * What each slot accepts, and how much of it.
 *
 * The key is the format, so a slot can give different budgets to different containers: a gift
 * animation may be a few hundred KB of Lottie JSON or a short MP4 cinematic, and letting the video
 * slot's 8 MB apply to the JSON would remove the guard that keeps a 6 MB scene out of a phone's
 * animation cache. A missing key is a refusal, so there is no separate `formats` list to keep in
 * step with.
 */
const MB = 1024 * 1024;
const POLICY: Record<MediaKind, Partial<Record<Format, number>>> = {
  GIFT_ICON: { png: 2 * MB, gif: 2 * MB, webp: 2 * MB, jpeg: 2 * MB },
  GIFT_ANIMATION: { lottie: 2 * MB, svga: 8 * MB, mp4: 8 * MB },
  GIFT_SOUND: { wav: 2 * MB, mp3: 2 * MB, m4a: 2 * MB },
  EFFECT: { lottie: 3 * MB },
  // A ride is the same kind of art as a gift animation and none of the kind an EFFECT slot accepts:
  // operators cut them as short MP4s, so the Lottie-only EFFECT budget would refuse the files that
  // make a ride worth buying. Same ceilings as GIFT_ANIMATION, because the device cost is the same.
  RIDE: { lottie: 3 * MB, svga: 8 * MB, mp4: 8 * MB },
  // A banner is loaded by every device that opens the app, often before it has anything else to
  // show — a splash image arrives on a cold start, on whatever network a member happens to have.
  // So the budgets sit under the gift slots' for the same pixel count: a scene a member chose to
  // watch may cost more than one they were shown.
  BANNER: { png: 3 * MB, gif: 3 * MB, webp: 3 * MB, jpeg: 3 * MB, lottie: 2 * MB, svga: 6 * MB, mp4: 6 * MB },
  BADGE: { png: 512 * 1024, gif: 512 * 1024, webp: 512 * 1024 },
  WALLPAPER: { png: 3 * MB, gif: 3 * MB, webp: 3 * MB, jpeg: 3 * MB },
  // A picker of 60 tiles loads on a phone keyboard tap, so each glyph stays tiny.
  EMOJI: { png: 256 * 1024, gif: 256 * 1024, webp: 256 * 1024 },
};

const MAX_FILE_NAME_LENGTH = 120;

/** The largest single upload any `POLICY` row allows. */
export const MAX_UPLOAD_BYTES = Math.max(
  ...MEDIA_KINDS.map((kind) => Math.max(0, ...Object.values(POLICY[kind] as Record<string, number>))),
);

/**
 * Uploads arrive as base64 inside a JSON body, so the request is a third larger than the file.
 * The route mounts its own parser with this limit; every other route keeps the 64 kb default.
 * Derived from `MAX_UPLOAD_BYTES` so raising a format budget cannot leave the route silently
 * refusing the files it just started to accept.
 */
export const UPLOAD_JSON_BODY_LIMIT = `${Math.ceil((MAX_UPLOAD_BYTES * 4) / 3 / MB + 1)}mb`;

/** Where the bytes live. Outside `public/` on purpose: that directory is regenerated. */
export const UPLOADS_DIR = path.resolve(__dirname, '..', '..', 'uploads');
/** The URL prefix `app.ts` mounts this directory under; the two must not drift. */
export const URL_PREFIX = '/uploads';

/**
 * Everything that can point at an upload. Deleting an asset still referenced here would leave a
 * gift showing a broken image, so the DELETE is refused until the reference is moved.
 */
const REFERENCE_SITES: ReadonlyArray<{ table: string; column: string; label: string }> = [
  { table: 'gifts', column: 'icon_url', label: 'gift icon' },
  { table: 'gifts', column: 'animation_url', label: 'gift animation' },
  { table: 'gifts', column: 'sound_url', label: 'gift sound' },
  { table: 'visual_effects', column: 'url', label: 'room effect' },
  { table: 'room_themes', column: 'wallpaper_url', label: 'room wallpaper' },
  { table: 'emoji_characters', column: 'url', label: 'chat emoji' },
  { table: 'rank_levels', column: 'badge_url', label: 'level badge' },
  // These three were missing until the banner work put them beside the rest: a ring or a ride whose
  // file was deleted from the library draws a broken circle on every avatar wearing it, and a banner
  // that lost its art is a promotional surface showing nothing at all.
  { table: 'profile_frames', column: 'art_url', label: 'profile ring' },
  { table: 'profile_rides', column: 'url', label: 'entrance ride' },
  { table: 'banners', column: 'url', label: 'banner' },
];

/**
 * Magic bytes only. A `.png` containing a script, an HTML document or a zip is rejected here,
 * and the extension written to disk is the one this function decided — so the stored name can
 * never disagree with the content the browser is told to expect.
 */
function sniff(buffer: Buffer): Format | null {
  const starts = (offset: number, bytes: number[], mask?: number[]) =>
    buffer.length >= offset + bytes.length &&
    bytes.every((byte, i) => (mask ? (buffer[offset + i] & mask[i]) === byte : buffer[offset + i] === byte));

  if (starts(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (starts(0, [0xff, 0xd8, 0xff])) return 'jpeg';
  // "GIF87a" or "GIF89a"
  if (buffer.length >= 6 && starts(0, [0x47, 0x49, 0x46, 0x38]) && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) {
    return 'gif';
  }
  if (starts(0, [0x52, 0x49, 0x46, 0x46]) && starts(8, [0x57, 0x45, 0x42, 0x50])) {
    // `RIFF....WEBP` — VP8 (lossy), VP8L (lossless) and VP8X (extended) are all the same format
    // as far as a decoder and a content type are concerned.
    return 'webp';
  }
  if (starts(0, [0x52, 0x49, 0x46, 0x46]) && starts(8, [0x57, 0x41, 0x56, 0x45])) return 'wav';
  if (starts(0, [0x49, 0x44, 0x33])) return 'mp3';
  // MPEG-1/2 Layer III frame sync: 11 set bits across the first two bytes.
  if (starts(0, [0xff, 0xe0], [0xff, 0xe0])) return 'mp3';
  if (starts(4, [0x66, 0x74, 0x79, 0x70])) return isoBrand(buffer);
  if (isSvga(buffer)) return 'svga';
  if (isLottie(buffer)) return 'lottie';
  return null;
}

const FTYP_BRAND_LENGTH = 4;
/** AAC in an ISO base-media container. The brand is four bytes, trailing space included. */
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ']);
/** The containers the MP4 renderer is documented to play. Anything else in `ftyp` is refused. */
const VIDEO_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'mmp4', 'avc1', 'mp4v', 'M4V ', 'dash']);

/**
 * `ftyp` carries the major brand at offset 8 and the compatible brands after it. Audio and video
 * share this container, so the brand — not the extension — decides whether the bytes belong in a
 * sound slot or an animation slot, and a file naming neither set is refused rather than guessed at.
 */
function isoBrand(buffer: Buffer): Format | null {
  const boxSize = buffer.length >= 8 ? buffer.readUInt32BE(0) : 0;
  // A `ftyp` box is at least 16 bytes and never larger than the file; either way the brand list
  // below is untrustworthy, and an untrustworthy header is a refusal.
  if (boxSize < 16 || boxSize > buffer.length) return null;
  const brands: string[] = [];
  for (let at = 8; at + FTYP_BRAND_LENGTH <= boxSize; at += FTYP_BRAND_LENGTH) {
    brands.push(buffer.toString('ascii', at, at + FTYP_BRAND_LENGTH));
  }
  const major = brands[0];
  if (AUDIO_BRANDS.has(major)) return 'm4a';
  if (VIDEO_BRANDS.has(major)) return 'mp4';
  // An unusual or fragmented writer names neither here in the major slot, so read the compatible
  // list — with audio checked first. That order is not arbitrary: an M4A lists `mp42` for
  // part-14 compatibility, while a real video never claims the audio-only brands.
  if (brands.some((brand) => AUDIO_BRANDS.has(brand))) return 'm4a';
  if (brands.some((brand) => VIDEO_BRANDS.has(brand))) return 'mp4';
  return null;
}

const SVGAFORMAT = Buffer.from('%SVGAFORMAT%', 'ascii');

/**
 * SVGA v2 is a ZIP whose first entry is the protobuf scene, named `svgaprotobuf_2.0`; some tools
 * write that protobuf straight to disk instead. Both start with bytes a real SVGA player can read
 * and nothing else in this app does, so an arbitrary zip — say a renamed PNG sprite sheet — stays
 * rejected by the entry name rather than by the `PK` header alone.
 */
function isSvga(buffer: Buffer): boolean {
  const marker = (at: number) => buffer.length >= at + SVGAFORMAT.length && buffer.subarray(at, at + SVGAFORMAT.length).equals(SVGAFORMAT);
  // Raw scene: protobuf field 1 (`version`, a string) is 0x0a, its length, then the marker.
  if (marker(0)) return true;
  if (buffer.length >= 3 && buffer[0] === 0x0a && buffer[1] === SVGAFORMAT.length && marker(2)) return true;
  // ZIP local file header: signature, then the name length at 26 and the name at 30.
  if (!startsPkLocalHeader(buffer)) return false;
  const nameLength = buffer.readUInt16LE(26);
  if (nameLength === 0 || buffer.length < 30 + nameLength) return false;
  return buffer.toString('utf8', 30, 30 + nameLength).toLowerCase().startsWith('svgaprotobuf');
}

function startsPkLocalHeader(buffer: Buffer): boolean {
  return (
    buffer.length >= 28 &&
    buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
  );
}

/** A Lottie scene is JSON with a version and at least one layer; anything else is just JSON. */
function isLottie(buffer: Buffer): boolean {
  if (buffer.length < 16) return false;
  const first = buffer[0];
  if (first !== 0x7b /* { */ && first !== 0xef) return false;
  try {
    const parsed: unknown = JSON.parse(buffer.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const scene = parsed as Record<string, unknown>;
    return typeof scene.v === 'string' && Array.isArray(scene.layers) && scene.layers.length > 0;
  } catch {
    return false;
  }
}

/** Pixel size for the three formats that carry it in a fixed header; null otherwise. */
function readDimensions(buffer: Buffer, format: Format): { width: number; height: number } | null {
  const u16be = (at: number) => buffer.readUInt16BE(at);
  const u32be = (at: number) => buffer.readUInt32BE(at);
  if (format === 'png' && buffer.length > 24) {
    return { width: u32be(16), height: u32be(20) };
  }
  if (format === 'gif' && buffer.length > 10) {
    return { width: u16be(6), height: u16be(8) };
  }
  if (format === 'webp' && buffer.length > 30) {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buffer.length > 30) {
      // Lossy: the 14-byte frame header starts at 20, and the 14-bit sizes sit at its +6/+8.
      return { width: u16be(26) & 0x3fff, height: u16be(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return {
        width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
        height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
      };
    }
  }
  return null;
}

/** Admin-facing view of one upload. Deliberately not in `serialize.ts`: no phone client reads it. */
export type MediaAssetDto = {
  id: string;
  kind: MediaKind;
  fileName: string;
  contentType: string;
  byteSize: number;
  url: string;
  width: number | null;
  height: number | null;
  uploadedBy: string | null;
  createdAt: string;
};

function toDto(row: MediaAssetRow): MediaAssetDto {
  return {
    id: row.id,
    kind: row.kind as MediaKind,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    url: row.url,
    width: row.width,
    height: row.height,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
  };
}

export async function listUploads(opts: {
  kind?: MediaKind;
  limit: number;
  offset: number;
}): Promise<{ assets: MediaAssetDto[]; total: number }> {
  const where = opts.kind ? 'WHERE kind = $1' : '';
  const params = opts.kind ? [opts.kind, opts.limit, opts.offset] : [opts.limit, opts.offset];
  const [rows, count] = await Promise.all([
    many<MediaAssetRow>(
      `SELECT * FROM media_assets ${where} ORDER BY created_at DESC LIMIT $${opts.kind ? 2 : 1} OFFSET $${opts.kind ? 3 : 2}`,
      params,
    ),
    one<{ n: string }>(`SELECT count(*)::text n FROM media_assets ${opts.kind ? 'WHERE kind = $1' : ''}`, opts.kind ? [opts.kind] : []),
  ]);
  return { assets: rows.map(toDto), total: Number(count?.n ?? 0) };
}

export type UploadResult = { asset: MediaAssetDto; duplicate: boolean };

/**
 * Validate, store and record one upload. The file is written before the row so a rejected
 * insert cannot leave a database entry pointing at bytes that were never committed; the reverse
 * order would leave an orphan file, which is what the unlink below cleans up.
 */
export async function saveUpload(input: {
  kind: MediaKind;
  fileName: string;
  buffer: Buffer;
  adminId: string | null;
}): Promise<UploadResult> {
  const policy = POLICY[input.kind];
  const fileName = input.fileName.trim();
  if (!fileName) throw ApiError.badRequest('fileName is required');
  if (fileName.length > MAX_FILE_NAME_LENGTH) {
    throw ApiError.badRequest(`fileName must be ${MAX_FILE_NAME_LENGTH} characters or fewer`);
  }
  if (input.buffer.length === 0) throw ApiError.badRequest('The uploaded file is empty');

  // The format is read from the bytes before the size is judged, because the budget depends on it:
  // the same slot accepts a 2 MB Lottie scene and an 8 MB MP4, and a cap checked against the slot
  // alone would either reject the video or wave through an oversized scene.
  const format = sniff(input.buffer);
  const maxBytes = format ? policy[format] : undefined;
  if (!format || maxBytes === undefined) {
    throw ApiError.badRequest(
      format
        ? `A ${format.toUpperCase()} file is not accepted for ${input.kind}; this slot takes ${Object.keys(policy).join(', ')}`
        : 'Unrecognised file format — the bytes do not match any image, animation or audio type this app plays',
      'upload_format_unsupported',
    );
  }
  if (input.buffer.length > maxBytes) {
    throw ApiError.badRequest(
      `That ${format.toUpperCase()} file is ${(input.buffer.length / 1024 / 1024).toFixed(1)} MB; ${input.kind} accepts ${format} up to ${(maxBytes / 1024 / 1024).toFixed(maxBytes < MB ? 0 : 1)} MB`,
      'upload_too_large',
    );
  }

  const sha256 = crypto.createHash('sha256').update(input.buffer).digest('hex');
  const existing = await one<MediaAssetRow>(
    'SELECT * FROM media_assets WHERE sha256 = $1 AND kind = $2',
    [sha256, input.kind],
  );
  if (existing) return { asset: toDto(existing), duplicate: true };

  const { contentType, ext } = FORMATS[format];
  const storedName = `${randomUUID()}.${ext}`;
  const url = `${URL_PREFIX}/${storedName}`;
  const dimensions = readDimensions(input.buffer, format);

  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOADS_DIR, storedName), input.buffer, { mode: 0o644 });

  try {
    const row = await one<MediaAssetRow>(
      `INSERT INTO media_assets (kind, file_name, stored_name, content_type, byte_size, sha256, url, width, height, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        input.kind,
        fileName,
        storedName,
        contentType,
        input.buffer.length,
        sha256,
        url,
        dimensions?.width ?? null,
        dimensions?.height ?? null,
        input.adminId,
      ],
    );
    if (!row) throw new Error('Media insert returned no row');
    return { asset: toDto(row), duplicate: false };
  } catch (err) {
    await fs.unlink(path.join(UPLOADS_DIR, storedName)).catch(() => undefined);
    throw err;
  }
}

/**
 * Decode a base64 payload the panel read out of a file input, tolerating the `data:...;base64,`
 * prefix browsers add.
 *
 * `Buffer.from(_, 'base64')` quietly drops characters outside the alphabet, so a truncated or
 * hand-edited body would otherwise decode into *something* and get stored. Re-encoding and
 * comparing catches that. The size cap is not applied here — it belongs to the kind, and is
 * checked against these decoded bytes in `saveUpload`.
 */
export function decodeUploadPayload(raw: unknown): Buffer {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw ApiError.badRequest('data must be a base64-encoded file', 'upload_data_missing');
  }
  const withPrefix = raw.trim();
  const body = withPrefix.startsWith('data:') && withPrefix.includes(',')
    ? withPrefix.slice(withPrefix.indexOf(',') + 1)
    : withPrefix;
  const compact = body.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw ApiError.badRequest('data is not valid base64', 'upload_not_base64');
  }
  const buffer = Buffer.from(compact, 'base64');
  const unpad = (text: string) => text.replace(/=+$/, '');
  if (unpad(buffer.toString('base64')) !== unpad(compact)) {
    throw ApiError.badRequest('data is not valid base64', 'upload_not_base64');
  }
  return buffer;
}

/** Where an asset is still being pointed at, as labels a panel operator can act on. */
async function findReferences(url: string): Promise<string[]> {
  const found: string[] = [];
  for (const site of REFERENCE_SITES) {
    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text n FROM ${site.table} WHERE ${site.column} = $1`,
      [url],
    );
    if (Number(rows[0]?.n ?? 0) > 0) found.push(site.label);
  }
  return found;
}

export async function deleteUpload(assetId: string): Promise<{ ok: true }> {
  const row = await one<MediaAssetRow>('SELECT * FROM media_assets WHERE id = $1', [assetId]);
  if (!row) throw ApiError.notFound('Upload not found');

  const references = await findReferences(row.url);
  if (references.length > 0) {
    throw ApiError.conflict(
      `Still used as ${references.join(', ')} — move those rows onto another file first`,
      'upload_in_use',
    );
  }

  await query('DELETE FROM media_assets WHERE id = $1', [assetId]);
  // The row is gone either way; a leftover file is cleaned up by the next operator, but a
  // database pointing at a missing file is a broken image on a member's phone.
  await fs.unlink(path.join(UPLOADS_DIR, row.stored_name)).catch(() => undefined);
  return { ok: true };
}
