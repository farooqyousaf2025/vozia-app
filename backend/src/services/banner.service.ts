import { many, one, query } from '../config/db';
import { BannerRow } from '../types/db';
import {
  ApiError,
  optionalString,
  requireBoolean,
  requireEnum,
  requireInt,
  requireString,
} from '../utils/http';

/**
 * Operator-run promotional art.
 *
 * Three rules carry over from every other catalogue in this schema. A device is handed URLs and
 * verbs, never a path built from a slug or a route guessed from a string. The tap target's *shape*
 * is validated before it is stored, because a row that says `ROOM` and holds a sentence would be a
 * crash on every phone that asked for it. And a retired campaign is switched off, not deleted — the
 * counts next to it are the only answer an operator gets to "did that banner work".
 */

export const BANNER_PLACEMENTS = ['SPLASH', 'HOME', 'GIFT', 'GAME'] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];

/** Which renderer opens `url`. The upload's bytes decided it; `media.service` will refuse a mismatch. */
export const BANNER_FORMATS = ['PNG', 'GIF', 'WEBP', 'JPEG', 'LOTTIE', 'SVGA', 'MP4'] as const;
export type BannerFormat = (typeof BANNER_FORMATS)[number];

export const BANNER_CTA_TYPES = ['NONE', 'INTERNAL', 'ROOM', 'URL'] as const;
export type BannerCtaType = (typeof BANNER_CTA_TYPES)[number];

/**
 * The four screens a phone can navigate to without a resource id.
 *
 * Deliberately short, and deliberately mirrored by the app's own route table: `GIFT_PANEL` and
 * `GAME_DESK` are not here because both belong to a room the member is standing in, so a banner
 * cannot promise them without naming the room — which is what `ROOM` is for.
 */
export const BANNER_INTERNAL_TARGETS = ['HOME', 'STORE', 'WALLET', 'PROFILE'] as const;

/** How many live banners one surface is allowed to be handed. A carousel that never ends is not a banner. */
export const MAX_BANNERS_PER_PLACEMENT = 10;

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;
const URL_PATTERN = /^(\/|https:\/\/)/;
const ROOM_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTPS_PATTERN = /^https:\/\/\S+$/;

export type BannerCta = { type: BannerCtaType; value: string | null };

/** What a member's device is handed. Counts and scheduling are the operator's view, not the room's. */
export type BannerDto = {
  id: string;
  key: string;
  placement: BannerPlacement;
  title: string;
  subtitle: string | null;
  url: string;
  format: BannerFormat;
  durationMs: number;
  ctaType: BannerCtaType;
  ctaValue: string | null;
};

/** The panel's view: the same row plus its window, its switch and what it achieved. */
export type BannerAdminDto = BannerDto & {
  /** Where the surface puts this row relative to its siblings; a phone only ever gets them ordered. */
  sortOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  impressions: number;
  taps: number;
  createdAt: string;
  updatedAt: string;
};

function toDto(row: BannerRow): BannerDto {
  return {
    id: row.id,
    key: row.key,
    placement: row.placement as BannerPlacement,
    title: row.title,
    subtitle: row.subtitle,
    url: row.url,
    format: row.format as BannerFormat,
    durationMs: row.duration_ms,
    ctaType: row.cta_type as BannerCtaType,
    ctaValue: row.cta_value,
  };
}

function toAdminDto(row: BannerRow): BannerAdminDto {
  return {
    ...toDto(row),
    sortOrder: row.sort_order,
    startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
    isActive: row.is_active,
    impressions: Number(row.impressions),
    taps: Number(row.taps),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * The live rows for one surface, or for all four at once.
 *
 * One call for a session is why `placement` may be null: a phone that is about to show a splash, a
 * home strip and a gift-panel card should not make three requests to learn them. The cap is then
 * per placement, not total, so a crowded HOME cannot starve the SPLASH.
 *
 * The `ROOM` clause is the part worth reading twice: a banner pointing at a room that has closed is
 * not a broken navigation, it is no banner at all. Rooms close continuously, so this is a join at
 * read time rather than a rule an operator could have honoured when they wrote the campaign.
 */
export async function listLiveBanners(placement: BannerPlacement | null): Promise<BannerDto[]> {
  const rows = await many<BannerRow>(
    `SELECT * FROM (
       SELECT b.*,
              row_number() OVER (
                PARTITION BY b.placement ORDER BY b.sort_order ASC, b.created_at DESC
              ) AS live_rank
         FROM banners b
        WHERE ($1::text IS NULL OR b.placement = $1)
          AND b.is_active
          AND (b.starts_at IS NULL OR b.starts_at <= now())
          AND (b.ends_at IS NULL OR b.ends_at > now())
          AND (
            b.cta_type <> 'ROOM'
            OR EXISTS (SELECT 1 FROM rooms r WHERE r.id = b.cta_value::uuid AND r.status = 'ACTIVE')
          )
     ) live
     WHERE live_rank <= $2
     ORDER BY placement ASC, sort_order ASC, created_at DESC`,
    [placement, MAX_BANNERS_PER_PLACEMENT],
  );
  return rows.map(toDto);
}

/**
 * One counted event on one banner.
 *
 * Only a live row counts, and only the two verbs the app actually has. This is a write a member can
 * make, so it is deliberately the smallest one available: no payload beyond the id and the event, no
 * return value beyond confirmation, and no place for a client to put a number it made up.
 */
export async function recordBannerEvent(
  id: string,
  event: 'IMPRESSION' | 'TAP',
): Promise<{ ok: true }> {
  const column = event === 'TAP' ? 'taps' : 'impressions';
  const updated = await one<{ id: string }>(
    `UPDATE banners
        SET ${column} = ${column} + 1
      WHERE id = $1
        AND is_active
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at IS NULL OR ends_at > now())
      RETURNING id`,
    [id],
  );
  if (!updated) throw ApiError.notFound('No live banner with that id', 'banner_not_live');
  return { ok: true };
}

export async function listBanners(): Promise<BannerAdminDto[]> {
  const rows = await many<BannerRow>(
    'SELECT * FROM banners ORDER BY placement ASC, sort_order ASC, created_at DESC',
  );
  return rows.map(toAdminDto);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function readKey(value: unknown): string {
  const text = requireString(value, 'key', { min: 2, max: 39 });
  if (!KEY_PATTERN.test(text)) {
    throw ApiError.badRequest(
      'key must be 2-39 characters of lower-case letters, digits and hyphens',
      'banner_key_invalid',
    );
  }
  return text;
}

function readUrl(value: unknown): string {
  const text = requireString(value, 'url', { max: 500 });
  if (!URL_PATTERN.test(text)) {
    throw ApiError.badRequest(
      'url must be a root-relative path like /uploads/x.png or an https URL',
      'banner_url_invalid',
    );
  }
  return text;
}

function readTimestamp(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const text = requireString(value, field, { max: 40 });
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw ApiError.badRequest(`${field} must be an ISO-8601 timestamp`, 'banner_window_invalid');
  }
  return parsed;
}

/**
 * The tap target, checked as a pair.
 *
 * A `ROOM` banner is only honest if that room exists — an operator pasting an id from another
 * environment would otherwise ship a campaign that silently never appears, since `listLiveBanners`
 * drops rows pointing at rooms that are gone. Refusing it at the write is the same sentence with a
 * status code attached.
 */
async function readCta(body: Record<string, unknown>, existing?: BannerCta): Promise<BannerCta> {
  const rawType = body.ctaType ?? existing?.type;
  if (rawType === undefined) {
    if (existing) return existing;
    throw ApiError.badRequest('ctaType is required', 'banner_cta_missing');
  }
  const type = requireEnum(rawType, 'ctaType', BANNER_CTA_TYPES);
  const rawValue = body.ctaValue === undefined ? existing?.value : body.ctaValue;
  if (type === 'NONE') {
    if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
      throw ApiError.badRequest('a banner with ctaType NONE cannot carry a ctaValue', 'banner_cta_shape');
    }
    return { type, value: null };
  }
  const value = requireString(rawValue, 'ctaValue', { max: 300 });
  if (type === 'INTERNAL') {
    const upper = value.toUpperCase();
    if (!(BANNER_INTERNAL_TARGETS as readonly string[]).includes(upper)) {
      throw ApiError.badRequest(
        `ctaValue must be one of: ${BANNER_INTERNAL_TARGETS.join(', ')}`,
        'banner_cta_target_invalid',
      );
    }
    return { type, value: upper };
  }
  if (type === 'URL') {
    if (!HTTPS_PATTERN.test(value)) {
      throw ApiError.badRequest('ctaValue must be a full https:// link', 'banner_cta_url_invalid');
    }
    return { type, value };
  }
  if (!ROOM_UUID_PATTERN.test(value)) {
    throw ApiError.badRequest('ctaValue must be a room id (UUID)', 'banner_cta_room_invalid');
  }
  const room = await one<{ id: string }>('SELECT id FROM rooms WHERE id = $1', [value]);
  if (!room) throw ApiError.badRequest('No room with that id', 'banner_cta_room_missing');
  return { type, value };
}

/**
 * Whether a device opens this file in a renderer or draws it itself.
 *
 * The rule that a format and its bytes must agree is enforced where the bytes are — `media.service`
 * sniffs an upload and the panel refuses a row whose renderer cannot open the file attached to it —
 * so this only names the two families the app's routing table splits on.
 */
function readFormat(value: unknown): BannerFormat {
  const text = requireString(value, 'format', { max: 8 }).toUpperCase();
  if (!(BANNER_FORMATS as readonly string[]).includes(text)) {
    throw ApiError.badRequest(`format must be one of: ${BANNER_FORMATS.join(', ')}`, 'banner_format_invalid');
  }
  return text as BannerFormat;
}

function readDuration(value: unknown): number {
  const ms = requireInt(value, 'durationMs', { min: 0, max: 30_000 });
  if (ms > 0 && ms < 250) {
    throw ApiError.badRequest(
      'durationMs is either 0 (the surface\'s own default) or at least 250',
      'banner_duration_invalid',
    );
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function bannerAfterWrite(id: string): Promise<BannerAdminDto> {
  const row = await one<BannerRow>('SELECT * FROM banners WHERE id = $1', [id]);
  if (!row) throw new Error(`banner ${id} vanished after being written`);
  return toAdminDto(row);
}

export async function createBanner(body: Record<string, unknown>): Promise<BannerAdminDto> {
  const input = body ?? {};
  const key = readKey(input.key);
  const placement = requireEnum(input.placement, 'placement', BANNER_PLACEMENTS);
  const title = requireString(input.title, 'title', { max: 60 });
  const subtitle = optionalString(input.subtitle, 'subtitle', 120) ?? null;
  const url = readUrl(input.url);
  const format = readFormat(input.format ?? 'PNG');
  const durationMs = input.durationMs === undefined ? 0 : readDuration(input.durationMs);
  const cta = await readCta(input);
  const startsAt = readTimestamp(input.startsAt, 'startsAt');
  const endsAt = readTimestamp(input.endsAt, 'endsAt');
  assertWindow(startsAt, endsAt);
  const sortOrder = input.sortOrder === undefined ? 0 : requireInt(input.sortOrder, 'sortOrder', { min: -9999, max: 9999 });
  const isActive = input.isActive === undefined ? true : requireBoolean(input.isActive, 'isActive');

  if (await one<{ key: string }>('SELECT key FROM banners WHERE key = $1', [key])) {
    throw ApiError.conflict(`A banner already uses the key ${key}`, 'banner_exists');
  }

  const row = await one<BannerRow>(
    `INSERT INTO banners (key, placement, title, subtitle, url, format, duration_ms,
                          cta_type, cta_value, starts_at, ends_at, sort_order, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      key,
      placement,
      title,
      subtitle,
      url,
      format,
      durationMs,
      cta.type,
      cta.value,
      startsAt,
      endsAt,
      sortOrder,
      isActive,
    ],
  );
  if (!row) throw new Error('banner insert returned no row');
  return toAdminDto(row);
}

export async function updateBanner(id: string, body: Record<string, unknown>): Promise<BannerAdminDto> {
  const input = body ?? {};
  const existing = await one<BannerRow>('SELECT * FROM banners WHERE id = $1', [id]);
  if (!existing) throw ApiError.notFound('Banner not found', 'banner_not_found');

  const key = input.key === undefined ? existing.key : readKey(input.key);
  if (key !== existing.key) {
    throw ApiError.badRequest(
      'key is an identity — the audit line and any deep link name it. Add the new key and delete this one instead',
      'banner_key_immutable',
    );
  }
  const placement = input.placement === undefined
    ? (existing.placement as BannerPlacement)
    : requireEnum(input.placement, 'placement', BANNER_PLACEMENTS);
  const title = input.title === undefined ? existing.title : requireString(input.title, 'title', { max: 60 });
  const subtitle = input.subtitle === undefined
    ? existing.subtitle
    : optionalString(input.subtitle, 'subtitle', 120) ?? null;
  const url = input.url === undefined ? existing.url : readUrl(input.url);
  const format = readFormat(input.format ?? existing.format);
  const durationMs = input.durationMs === undefined ? existing.duration_ms : readDuration(input.durationMs);
  const cta = await readCta(input, {
    type: existing.cta_type as BannerCtaType,
    value: existing.cta_value,
  });
  const startsAt = input.startsAt === undefined
    ? (existing.starts_at ? new Date(existing.starts_at) : null)
    : readTimestamp(input.startsAt, 'startsAt');
  const endsAt = input.endsAt === undefined
    ? (existing.ends_at ? new Date(existing.ends_at) : null)
    : readTimestamp(input.endsAt, 'endsAt');
  assertWindow(startsAt, endsAt);
  const sortOrder = input.sortOrder === undefined
    ? existing.sort_order
    : requireInt(input.sortOrder, 'sortOrder', { min: -9999, max: 9999 });
  const isActive = input.isActive === undefined ? existing.is_active : requireBoolean(input.isActive, 'isActive');

  await query(
    `UPDATE banners
        SET placement = $2, title = $3, subtitle = $4, url = $5, format = $6, duration_ms = $7,
            cta_type = $8, cta_value = $9, starts_at = $10, ends_at = $11, sort_order = $12,
            is_active = $13
      WHERE id = $1`,
    [
      id,
      placement,
      title,
      subtitle,
      url,
      format,
      durationMs,
      cta.type,
      cta.value,
      startsAt,
      endsAt,
      sortOrder,
      isActive,
    ],
  );
  return bannerAfterWrite(id);
}

/**
 * Delete a campaign outright.
 *
 * `is_active = false` is the normal way to retire one — the counts stay readable and the key can be
 * switched back on next quarter. This route exists for the case where the row itself is the problem:
 * a duplicate key, or art that has to come down. `media.service` refuses it while the upload is still
 * referenced, which is the only guard that matters here.
 */
export async function deleteBanner(id: string): Promise<{ ok: true; key: string; placement: BannerPlacement }> {
  const existing = await one<BannerRow>('SELECT * FROM banners WHERE id = $1', [id]);
  if (!existing) throw ApiError.notFound('Banner not found', 'banner_not_found');
  await query('DELETE FROM banners WHERE id = $1', [id]);
  return { ok: true, key: existing.key, placement: existing.placement as BannerPlacement };
}

function assertWindow(startsAt: Date | null, endsAt: Date | null): void {
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw ApiError.badRequest('endsAt must be after startsAt', 'banner_window_invalid');
  }
}
