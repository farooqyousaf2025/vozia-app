import { many, one, query } from '../config/db';
import { EmojiRow } from '../types/db';
import { ApiError, requireInt, requireString } from '../utils/http';

/**
 * The chat emoji a member can pick, and the code they type instead of picking.
 *
 * Like room themes before migration 0015, this set used to be a build artefact: a manifest the
 * asset generator wrote and the app could not change. `emoji_characters` is the registry now, and
 * the panel edits it under `/api/admin/emoji`.
 *
 * The rule that shapes the whole file is that **a message stores the token, never the URL**.
 * `rooms.chat` rows keep `see you [wave]` as text, so an operator can retire an emoji, point its
 * code at new art, or delete the catalogue entirely without rewriting history — a message whose
 * code no longer resolves just shows the plain text it always was. That is also why the token is
 * derived from `key` here instead of stored per row: there is then exactly one spelling of a code,
 * and no row can disagree with its own identity.
 *
 * `EMOJI_CODE_PATTERN` is a contract, not a detail: the Android client scans messages with this
 * same expression (published on `GET /api/emoji`), so a key longer than the pattern's 32 characters
 * would be unmatchable. `KEY_PATTERN` refuses it at the door rather than storing an emoji nobody can
 * send.
 */

export const EMOJI_CODE_PATTERN = '\\[[a-z0-9][a-z0-9-]{0,31}\\]';
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
// Same rule as visual_effects.url and room_themes.wallpaper_url: this string is handed to every
// device that reads a chat message, so `javascript:` and `file:` must not be storable.
const URL_PATTERN = /^(\/|https:\/\/)/;

/** What `GET /api/emoji` publishes. */
export type EmojiOption = { key: string; label: string; code: string; url: string };

export type EmojiCatalogue = { codePattern: string; emojis: EmojiOption[] };

/** The same rows plus the picker position, which a phone does not need. */
export type EmojiDto = EmojiOption & { sortOrder: number };

const codeFor = (key: string) => `[${key}]`;

function toDto(row: EmojiRow): EmojiDto {
  return { key: row.key, label: row.label, code: codeFor(row.key), url: row.url, sortOrder: row.sort_order };
}

async function rows(): Promise<EmojiRow[]> {
  return many<EmojiRow>('SELECT * FROM emoji_characters ORDER BY sort_order, key');
}

/** The published catalogue: every code the client should recognise, in picker order. */
export async function emojiCatalogue(): Promise<EmojiCatalogue> {
  const list = await rows();
  return {
    codePattern: EMOJI_CODE_PATTERN,
    emojis: list.map((row) => ({ key: row.key, label: row.label, code: codeFor(row.key), url: row.url })),
  };
}

export async function listAdminEmoji(): Promise<{ emojis: EmojiDto[] }> {
  return { emojis: (await rows()).map(toDto) };
}

async function afterWrite(key: string): Promise<EmojiDto> {
  const row = await one<EmojiRow>('SELECT * FROM emoji_characters WHERE key = $1', [key]);
  if (!row) throw ApiError.notFound('Emoji not found');
  return toDto(row);
}

type EmojiChanges = { key?: string; label?: string; url?: string; sortOrder?: number };

function readEmojiBody(body: Record<string, unknown>): EmojiChanges {
  const changes: EmojiChanges = {};
  if (body.key !== undefined) {
    // Length is bounded here only by the column; KEY_PATTERN owns the real limit (32) because a
    // longer key could never be matched inside a message. Saying it twice, in two voices, would
    // make an over-long key fail as a generic "too long" instead of as an unusable code.
    const key = requireString(body.key, 'key', { min: 2, max: 40 });
    if (!KEY_PATTERN.test(key)) {
      throw ApiError.badRequest(
        'key takes lowercase letters, digits and inner dashes, 2 to 32 characters — it is the code a member types in a message',
        'emoji_key_invalid',
      );
    }
    changes.key = key;
  }
  if (body.label !== undefined) changes.label = requireString(body.label, 'label', { min: 1, max: 60 });
  if (body.url !== undefined) {
    const url = requireString(body.url, 'url', { min: 2, max: 512 });
    if (!URL_PATTERN.test(url)) {
      throw ApiError.badRequest('url must be a path on this API (/-relative) or an https link', 'emoji_url_invalid');
    }
    changes.url = url;
  }
  if (body.sortOrder !== undefined) changes.sortOrder = requireInt(body.sortOrder, 'sortOrder', { min: 0, max: 10_000 });
  return changes;
}

export async function createEmoji(body: Record<string, unknown>): Promise<EmojiDto> {
  const input = readEmojiBody(body ?? {});
  const missing = (['key', 'label', 'url'] as const).filter((field) => !input[field]);
  if (missing.length > 0) throw ApiError.badRequest(`${missing.join(', ')} required`, 'emoji_fields_missing');
  const complete = { key: input.key!, label: input.label!, url: input.url!, sortOrder: input.sortOrder ?? 0 };
  if (await one<EmojiRow>('SELECT key FROM emoji_characters WHERE key = $1', [complete.key])) {
    throw ApiError.conflict(`A chat emoji already uses the code [${complete.key}]`, 'emoji_exists');
  }
  await query(
    'INSERT INTO emoji_characters (key, label, url, sort_order) VALUES ($1, $2, $3, $4)',
    [complete.key, complete.label, complete.url, complete.sortOrder],
  );
  return afterWrite(complete.key);
}

export async function updateEmoji(key: string, body: Record<string, unknown>): Promise<EmojiDto> {
  const changes = readEmojiBody(body ?? {});
  const existing = await one<EmojiRow>('SELECT * FROM emoji_characters WHERE key = $1', [key]);
  if (!existing) throw ApiError.notFound('Emoji not found');
  if (changes.key && changes.key !== key) {
    throw ApiError.badRequest(
      'key is an identity, not a label — every message already sent spells the code after it. Add the new code and delete this one instead',
      'emoji_key_immutable',
    );
  }
  await query(
    'UPDATE emoji_characters SET label = $2, url = $3, sort_order = $4, updated_at = now() WHERE key = $1',
    [key, changes.label ?? existing.label, changes.url ?? existing.url, changes.sortOrder ?? existing.sort_order],
  );
  return afterWrite(key);
}

export async function deleteEmoji(key: string): Promise<{ ok: true; key: string }> {
  const existing = await one<EmojiRow>('SELECT key FROM emoji_characters WHERE key = $1', [key]);
  if (!existing) throw ApiError.notFound('Emoji not found');
  await query('DELETE FROM emoji_characters WHERE key = $1', [key]);
  // No reference count and no "last one" guard: messages keep their text, so retiring a code
  // cannot break anything that was already sent.
  return { ok: true, key };
}
