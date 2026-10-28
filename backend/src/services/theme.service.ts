import { many, one, query, withTransaction } from '../config/db';
import { RoomCategoryEffectRow, RoomThemeRow, VisualEffectRow } from '../types/db';
import { ApiError, requireBoolean, requireInt, requireString } from '../utils/http';

/**
 * The room decoration catalogue: wallpapers a host can pick, and the Lottie loops a room breathes.
 *
 * This used to be `backend/public/themes/manifest.json`, read once at boot. That made the
 * platform's look a build artefact: an operator could not add a theme, retire one, or decide that
 * a PARTY room should sparkle instead of confetti without shipping a new backend. The rows in
 * `room_themes`, `visual_effects` and `room_category_effects` (migration 0015) are now the
 * registry, and the panel edits them through the `config:manage` routes in `admin.controller.ts`.
 *
 * Two consequences drive the shape of this file:
 *
 * 1. `toRoom()` in `utils/serialize.ts` runs on every room DTO — hundreds of times on a discovery
 *    page — and it is synchronous. So rows are read into an immutable snapshot at boot, after
 *    every admin write, and in the background when a snapshot goes stale. No request path awaits
 *    a catalogue query.
 * 2. Clients receive URLs only (`wallpaper`, `ambientEffect`, `welcome`). A client must never
 *    derive a path from a slug, because an operator's theme lives at `/uploads/<uuid>.png`, not at
 *    `/themes/<slug>/wallpaper.png`; a client that guessed would 404 on art that exists.
 *
 * A snapshot is a few dozen rows, so a second backend process being up to REFRESH_AFTER_MS behind
 * a write is not worth a pub/sub channel.
 */

export const EFFECT_KINDS = ['AMBIENT', 'WELCOME'] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

/** Exactly what `GET /api/rooms/themes` publishes; the shape an installed app parses. */
export type RoomTheme = {
  slug: string;
  name: string;
  accent: string;
  wallpaper: string;
};

export type ThemeCatalogue = {
  themes: readonly RoomTheme[];
  defaultTheme: string;
  welcome: string | null;
  effects: readonly string[];
};

/** The same rows plus the operator-facing fields the published catalogue hides. */
export type VisualEffectDto = {
  key: string;
  kind: EffectKind;
  name: string;
  url: string;
  sortOrder: number;
  /** Which room categories play this loop; empty for a WELCOME effect. */
  usedByCategories: string[];
};

export type RoomThemeDto = RoomTheme & {
  isDefault: boolean;
  sortOrder: number;
  /** Rooms still carrying this slug — a delete leaves them rendering the default look. */
  roomsUsing: number;
};

export type CategoryEffectDto = {
  category: string;
  effectKey: string;
  name: string | null;
  url: string | null;
};

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;
const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;
// The CHECK in 0015 repeats this rule: the string is handed to every device that joins a room,
// so a `javascript:` or `file:` value must not be storable even by an operator.
const URL_PATTERN = /^(\/|https:\/\/)/;
const REFRESH_AFTER_MS = 30_000;

type Snapshot = {
  themes: RoomTheme[];
  defaultTheme: string;
  welcome: string | null;
  ambient: { key: string; url: string }[];
  ambientUrlByKey: Map<string, string>;
  categoryEffects: Map<string, string>;
  loadedAt: number;
};

let snapshot: Snapshot | null = null;
let loading: Promise<void> | null = null;

async function fetchSnapshot(): Promise<Snapshot> {
  const [themeRows, effectRows, categoryRows] = await Promise.all([
    many<RoomThemeRow>('SELECT * FROM room_themes ORDER BY sort_order ASC, slug ASC'),
    many<VisualEffectRow>('SELECT * FROM visual_effects ORDER BY sort_order ASC, key ASC'),
    many<RoomCategoryEffectRow>('SELECT * FROM room_category_effects'),
  ]);

  if (themeRows.length === 0) {
    throw new Error(
      'room_themes is empty, but every room needs a default look. Run npm run db:migrate, ' +
        'or add a theme from the admin panel.',
    );
  }

  const themes = themeRows.map(toWallpaper);
  const ambient = effectRows
    .filter((row) => row.kind === 'AMBIENT')
    .map((row) => ({ key: row.key, url: row.url }));

  return {
    themes,
    defaultTheme: themeRows.find((row) => row.is_default)?.slug ?? themes[0].slug,
    welcome: effectRows.find((row) => row.kind === 'WELCOME')?.url ?? null,
    ambient,
    ambientUrlByKey: new Map(ambient.map((effect) => [effect.key, effect.url])),
    categoryEffects: new Map(categoryRows.map((row) => [row.category, row.effect_key])),
    loadedAt: Date.now(),
  };
}

/**
 * Replace the snapshot every synchronous accessor below serves from. Awaiting callers share one
 * in-flight read so a burst of stale requests cannot stampede the database.
 */
export async function loadThemeRegistry(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    snapshot = await fetchSnapshot();
  })().finally(() => {
    loading = null;
  });
  return loading;
}

function current(): Snapshot {
  if (!snapshot) {
    throw new ApiError(503, 'Room decoration catalogue is not loaded yet', 'theme_registry_loading');
  }
  // Serve the stale snapshot and refresh behind it: a slow reload must not delay a room DTO.
  if (Date.now() - snapshot.loadedAt > REFRESH_AFTER_MS) {
    void loadThemeRegistry().catch((err) => console.warn('[voiza] theme catalogue refresh failed:', err.message));
  }
  return snapshot;
}

function toWallpaper(row: RoomThemeRow): RoomTheme {
  return { slug: row.slug, name: row.name, accent: row.accent.trim(), wallpaper: row.wallpaper_url };
}

// ---------------------------------------------------------------------------
// Published catalogue (what a phone reads)
// ---------------------------------------------------------------------------

export function themeCatalogue(): ThemeCatalogue {
  const registry = current();
  return {
    themes: registry.themes,
    defaultTheme: registry.defaultTheme,
    welcome: registry.welcome,
    effects: registry.ambient.map((effect) => effect.url),
  };
}

export function themeSlugs(): string[] {
  return current().themes.map((theme) => theme.slug);
}

export function defaultThemeSlug(): string {
  return current().defaultTheme;
}

export function isTheme(slug: string): boolean {
  return current().themes.some((theme) => theme.slug === slug);
}

/** A room may carry a slug whose row was removed; it renders the default instead. */
export function themeFor(slug: string | null | undefined): RoomTheme {
  const registry = current();
  return (
    registry.themes.find((theme) => theme.slug === slug) ??
    registry.themes.find((theme) => theme.slug === registry.defaultTheme) ??
    registry.themes[0]
  );
}

/**
 * Ambient Lottie URL for a room category, or null when no loop is left to play. A category with
 * no mapping row falls back to CHAT's, then to the first ambient effect — never to a blank screen
 * while at least one loop exists.
 */
export function ambientEffectFor(category: string | null | undefined): string | null {
  const registry = current();
  if (registry.ambient.length === 0) return null;
  const key = registry.categoryEffects.get(category ?? '') ?? registry.categoryEffects.get('CHAT');
  const url = key ? registry.ambientUrlByKey.get(key) : undefined;
  return url ?? registry.ambient[0].url;
}

/** The wallpaper a room should load — resolved server-side so no client derives a path. */
export function themeWallpaperFor(slug: string | null | undefined): string {
  return themeFor(slug).wallpaper;
}

// ---------------------------------------------------------------------------
// Admin reads
// ---------------------------------------------------------------------------

export async function listAdminCatalogue(): Promise<{
  themes: RoomThemeDto[];
  effects: VisualEffectDto[];
  categoryEffects: CategoryEffectDto[];
}> {
  const [themeRows, effectRows, categoryRows, usage] = await Promise.all([
    many<RoomThemeRow>('SELECT * FROM room_themes ORDER BY sort_order ASC, slug ASC'),
    many<VisualEffectRow>('SELECT * FROM visual_effects ORDER BY kind ASC, sort_order ASC, key ASC'),
    many<RoomCategoryEffectRow>('SELECT * FROM room_category_effects ORDER BY category ASC'),
    many<{ theme: string; n: string }>('SELECT theme, count(*)::text n FROM rooms GROUP BY theme'),
  ]);

  const usedByKey = new Map<string, string[]>();
  for (const row of categoryRows) {
    const list = usedByKey.get(row.effect_key) ?? [];
    list.push(row.category);
    usedByKey.set(row.effect_key, list);
  }
  const roomsByTheme = new Map(usage.map((row) => [row.theme, Number(row.n)]));

  return {
    themes: themeRows.map((row) => themeDto(row, roomsByTheme.get(row.slug) ?? 0)),
    effects: effectRows.map((row) => effectDto(row, usedByKey.get(row.key) ?? [])),
    categoryEffects: categoryRows.map((row) => ({
      category: row.category,
      effectKey: row.effect_key,
      name: effectRows.find((effect) => effect.key === row.effect_key)?.name ?? null,
      url: effectRows.find((effect) => effect.key === row.effect_key)?.url ?? null,
    })),
  };
}

function themeDto(row: RoomThemeRow, roomsUsing: number): RoomThemeDto {
  return { ...toWallpaper(row), isDefault: row.is_default, sortOrder: row.sort_order, roomsUsing };
}

function effectDto(row: VisualEffectRow, usedByCategories: string[]): VisualEffectDto {
  return {
    key: row.key,
    kind: row.kind as EffectKind,
    name: row.name,
    url: row.url,
    sortOrder: row.sort_order,
    usedByCategories,
  };
}

async function themeAfterWrite(slug: string): Promise<RoomThemeDto> {
  const row = await one<RoomThemeRow>('SELECT * FROM room_themes WHERE slug = $1', [slug]);
  if (!row) throw new Error(`theme ${slug} vanished after being written`);
  const usage = await one<{ n: string }>('SELECT count(*)::text n FROM rooms WHERE theme = $1', [slug]);
  return themeDto(row, Number(usage?.n ?? 0));
}

async function effectAfterWrite(key: string): Promise<VisualEffectDto> {
  const row = await one<VisualEffectRow>('SELECT * FROM visual_effects WHERE key = $1', [key]);
  if (!row) throw new Error(`effect ${key} vanished after being written`);
  const mapped = await many<{ category: string }>('SELECT category::text category FROM room_category_effects WHERE effect_key = $1', [key]);
  return effectDto(row, mapped.map((item) => item.category));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function readIdentity(value: unknown, field: string): string {
  const text = requireString(value, field, { min: 2, max: 39 });
  if (!SLUG_PATTERN.test(text)) {
    throw ApiError.badRequest(
      `${field} must be 2-39 characters of lower-case letters, digits and hyphens`,
      `${field}_invalid`,
    );
  }
  return text;
}

function readUrl(value: unknown, field: string): string {
  const text = requireString(value, field, { max: 500 });
  if (!URL_PATTERN.test(text)) {
    throw ApiError.badRequest(`${field} must be a root-relative path like /uploads/x.png or an https URL`, `${field}_invalid`);
  }
  return text;
}

function readAccent(value: unknown): string {
  // Deliberately no length rule: `#fff` is a bad accent, and the useful answer is the one that
  // says so under `accent_invalid` rather than complaining about the character count.
  const text = requireString(value, 'accent', { max: 32 });
  if (!ACCENT_PATTERN.test(text)) throw ApiError.badRequest('accent must be a hex colour like #3ddc97', 'accent_invalid');
  return text;
}

function readKind(value: unknown): EffectKind {
  const text = requireString(value, 'kind', { max: 16 }).toUpperCase();
  if (!(EFFECT_KINDS as readonly string[]).includes(text)) {
    throw ApiError.badRequest(`kind must be one of: ${EFFECT_KINDS.join(', ')}`, 'effect_kind_invalid');
  }
  return text as EffectKind;
}

// Every field is optional on a partial write, and a missing field must never be written as an
// empty string — the trap `parseGiftInput` documents for the gift catalogue.
type ThemeChanges = {
  slug?: string;
  name?: string;
  accent?: string;
  wallpaperUrl?: string;
  isDefault?: boolean;
  sortOrder?: number;
};

function readThemeBody(body: Record<string, unknown>): ThemeChanges {
  return {
    slug: body.slug === undefined ? undefined : readIdentity(body.slug, 'slug'),
    name: body.name === undefined ? undefined : requireString(body.name, 'name', { max: 60 }),
    accent: body.accent === undefined ? undefined : readAccent(body.accent),
    wallpaperUrl: body.wallpaperUrl === undefined ? undefined : readUrl(body.wallpaperUrl, 'wallpaperUrl'),
    isDefault: body.isDefault === undefined ? undefined : requireBoolean(body.isDefault, 'isDefault'),
    sortOrder: body.sortOrder === undefined ? undefined : requireInt(body.sortOrder, 'sortOrder', { min: -9999, max: 9999 }),
  };
}

type EffectChanges = { key?: string; kind?: EffectKind; name?: string; url?: string; sortOrder?: number };

function readEffectBody(body: Record<string, unknown>): EffectChanges {
  return {
    key: body.key === undefined ? undefined : readIdentity(body.key, 'key'),
    kind: body.kind === undefined ? undefined : readKind(body.kind),
    name: body.name === undefined ? undefined : requireString(body.name, 'name', { max: 60 }),
    url: body.url === undefined ? undefined : readUrl(body.url, 'url'),
    sortOrder: body.sortOrder === undefined ? undefined : requireInt(body.sortOrder, 'sortOrder', { min: -9999, max: 9999 }),
  };
}

/** The values of the `room_category` enum, asked of the schema rather than hardcoded here. */
let categoryNames: Promise<string[]> | null = null;
function roomCategories(): Promise<string[]> {
  if (!categoryNames) {
    categoryNames = many<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'room_category'
       ORDER BY e.enumsortorder`,
    )
      .then((rows) => rows.map((row) => row.label))
      .catch((err) => {
        // A failed read must not be cached as the empty set: that would refuse every mapping.
        categoryNames = null;
        throw err;
      });
  }
  return categoryNames;
}

// ---------------------------------------------------------------------------
// Admin writes
// ---------------------------------------------------------------------------

/**
 * Set the default flag in one transaction. The partial unique index in 0015 rejects two defaults
 * and is checked per statement, so the old default has to be cleared before the new one is set.
 */
async function insertTheme(input: Required<ThemeChanges>): Promise<RoomThemeDto> {
  await withTransaction(async (client) => {
    if (input.isDefault) {
      await client.query('UPDATE room_themes SET is_default = false WHERE is_default');
    }
    await client.query(
      `INSERT INTO room_themes (slug, name, accent, wallpaper_url, is_default, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.slug, input.name, input.accent, input.wallpaperUrl, input.isDefault, input.sortOrder],
    );
  });
  await loadThemeRegistry();
  return themeAfterWrite(input.slug);
}

export async function createTheme(body: Record<string, unknown>): Promise<RoomThemeDto> {
  const input = readThemeBody(body ?? {});
  const complete: Required<ThemeChanges> = {
    slug: input.slug ?? '',
    name: input.name ?? '',
    accent: input.accent ?? '',
    wallpaperUrl: input.wallpaperUrl ?? '',
    isDefault: input.isDefault ?? false,
    sortOrder: input.sortOrder ?? 0,
  };
  const missing = (['slug', 'name', 'accent', 'wallpaperUrl'] as const).filter((field) => !complete[field]);
  if (missing.length > 0) throw ApiError.badRequest(`${missing.join(', ')} required`, 'theme_fields_missing');
  if (await one<RoomThemeRow>('SELECT slug FROM room_themes WHERE slug = $1', [complete.slug])) {
    throw ApiError.conflict(`A theme already uses the slug ${complete.slug}`, 'theme_exists');
  }
  return insertTheme(complete);
}

export async function updateTheme(slug: string, body: Record<string, unknown>): Promise<RoomThemeDto> {
  const changes = readThemeBody(body ?? {});
  const existing = await one<RoomThemeRow>('SELECT * FROM room_themes WHERE slug = $1', [slug]);
  if (!existing) throw ApiError.notFound('Theme not found');
  if (changes.slug && changes.slug !== slug) {
    throw ApiError.badRequest(
      'slug is an identity, not a label — rooms store it. Add the new slug and delete this one instead',
      'theme_slug_immutable',
    );
  }
  await withTransaction(async (client) => {
    if (changes.isDefault === true) {
      await client.query('UPDATE room_themes SET is_default = false WHERE is_default');
    }
    await client.query(
      `UPDATE room_themes
          SET name = $2, accent = $3, wallpaper_url = $4, is_default = $5, sort_order = $6
        WHERE slug = $1`,
      [
        slug,
        changes.name ?? existing.name,
        changes.accent ?? existing.accent,
        changes.wallpaperUrl ?? existing.wallpaper_url,
        // One-way: demoting the only default would leave rooms with nothing to fall back on, so
        // `isDefault: false` means "unchanged" here, and a delete of the default is refused below.
        changes.isDefault === true ? true : existing.is_default,
        changes.sortOrder ?? existing.sort_order,
      ],
    );
  });
  await loadThemeRegistry();
  return themeAfterWrite(slug);
}

export async function deleteTheme(slug: string): Promise<{ ok: true; slug: string; roomsLeftOnDefault: number }> {
  const existing = await one<RoomThemeRow>('SELECT * FROM room_themes WHERE slug = $1', [slug]);
  if (!existing) throw ApiError.notFound('Theme not found');

  const count = await one<{ n: string }>('SELECT count(*)::text n FROM room_themes');
  if (Number(count?.n ?? 0) <= 1) {
    throw ApiError.conflict('This is the only theme — the catalogue needs at least one look for rooms to wear', 'theme_last');
  }
  if (existing.is_default) {
    throw ApiError.conflict(
      'This is the default theme. Make another theme the default first, then delete this one',
      'theme_is_default',
    );
  }

  const rooms = await one<{ n: string }>('SELECT count(*)::text n FROM rooms WHERE theme = $1', [slug]);
  await query('DELETE FROM room_themes WHERE slug = $1', [slug]);
  await loadThemeRegistry();
  // Rooms keep the dead slug. `themeFor()` renders the default for them, which is why removing a
  // look needs no rewrite of the rooms table.
  return { ok: true, slug, roomsLeftOnDefault: Number(rooms?.n ?? 0) };
}

export async function createEffect(body: Record<string, unknown>): Promise<VisualEffectDto> {
  const input = readEffectBody(body ?? {});
  const complete = {
    key: input.key ?? '',
    kind: input.kind ?? 'AMBIENT',
    name: input.name ?? '',
    url: input.url ?? '',
    sortOrder: input.sortOrder ?? 0,
  };
  const missing = (['key', 'name', 'url'] as const).filter((field) => !complete[field]);
  if (missing.length > 0) throw ApiError.badRequest(`${missing.join(', ')} required`, 'effect_fields_missing');
  if (await one<VisualEffectRow>('SELECT key FROM visual_effects WHERE key = $1', [complete.key])) {
    throw ApiError.conflict(`An effect already uses the key ${complete.key}`, 'effect_exists');
  }
  await query(
    `INSERT INTO visual_effects (key, kind, name, url, sort_order) VALUES ($1,$2,$3,$4,$5)`,
    [complete.key, complete.kind, complete.name, complete.url, complete.sortOrder],
  );
  await loadThemeRegistry();
  return effectAfterWrite(complete.key);
}

export async function updateEffect(key: string, body: Record<string, unknown>): Promise<VisualEffectDto> {
  const changes = readEffectBody(body ?? {});
  const existing = await one<VisualEffectRow>('SELECT * FROM visual_effects WHERE key = $1', [key]);
  if (!existing) throw ApiError.notFound('Effect not found');
  if (changes.key && changes.key !== key) {
    throw ApiError.badRequest(
      'key is an identity — category mappings reference it. Add the new key and delete this one instead',
      'effect_key_immutable',
    );
  }
  if (changes.kind && changes.kind !== existing.kind) {
    throw ApiError.badRequest(
      `This effect is ${existing.kind}. Switching kind would move it between the loop behind a room and the entry flourish — delete it and add it again`,
      'effect_kind_immutable',
    );
  }
  await query(
    `UPDATE visual_effects SET name = $2, url = $3, sort_order = $4 WHERE key = $1`,
    [key, changes.name ?? existing.name, changes.url ?? existing.url, changes.sortOrder ?? existing.sort_order],
  );
  await loadThemeRegistry();
  return effectAfterWrite(key);
}

export async function deleteEffect(key: string): Promise<{ ok: true; key: string }> {
  const existing = await one<VisualEffectRow>('SELECT key, kind FROM visual_effects WHERE key = $1', [key]);
  if (!existing) throw ApiError.notFound('Effect not found');

  const mapped = await many<{ category: string }>(
    'SELECT category::text category FROM room_category_effects WHERE effect_key = $1',
    [key],
  );
  if (mapped.length > 0) {
    // The FK is ON DELETE RESTRICT, so Postgres refuses this too; naming the categories is what
    // makes the refusal actionable.
    throw ApiError.conflict(
      `Still played behind ${mapped.map((row) => row.category).join(', ')} — point those categories at another loop first`,
      'effect_in_use',
    );
  }
  const remaining = await one<{ n: string }>('SELECT count(*)::text n FROM visual_effects WHERE kind = $1', [existing.kind]);
  if (Number(remaining?.n ?? 0) <= 1) {
    throw ApiError.conflict(
      existing.kind === 'AMBIENT'
        ? 'This is the last ambient loop — rooms would have nothing to play behind them'
        : 'This is the only welcome flourish — add another before removing it',
      'effect_last',
    );
  }

  await query('DELETE FROM visual_effects WHERE key = $1', [key]);
  await loadThemeRegistry();
  return { ok: true, key };
}

/** Move a room category onto a different ambient loop. The categories come from the enum, not a list here. */
export async function setCategoryEffect(category: string, effectKey: string): Promise<CategoryEffectDto> {
  const normalized = requireString(category, 'category', { max: 24 }).toUpperCase();
  const known = await roomCategories();
  if (!known.includes(normalized)) {
    throw ApiError.badRequest(`category must be one of: ${known.join(', ')}`, 'room_category_invalid');
  }
  const effect = await one<VisualEffectRow>('SELECT * FROM visual_effects WHERE key = $1', [effectKey]);
  if (!effect) throw ApiError.notFound('Effect not found');
  if (effect.kind !== 'AMBIENT') {
    throw ApiError.badRequest(
      `${effectKey} is a ${effect.kind} effect; only AMBIENT loops play behind a room`,
      'effect_kind_mismatch',
    );
  }

  await query(
    `INSERT INTO room_category_effects (category, effect_key) VALUES ($1::room_category, $2)
     ON CONFLICT (category) DO UPDATE SET effect_key = EXCLUDED.effect_key`,
    [normalized, effectKey],
  );
  await loadThemeRegistry();
  return { category: normalized, effectKey, name: effect.name, url: effect.url };
}
