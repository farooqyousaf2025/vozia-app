import { many, one, query, withTransaction } from '../config/db';
import { ProfileFrameRow, RoomCategoryEffectRow, RoomThemeRow, VisualEffectRow } from '../types/db';
import { ApiError, requireBoolean, requireInt, requireString } from '../utils/http';

/**
 * The decoration catalogue: wallpapers a host can pick, the Lottie loops a room breathes, the
 * flourish a member enters with, and the ring around an avatar.
 *
 * This used to be `backend/public/themes/manifest.json`, read once at boot. That made the
 * platform's look a build artefact: an operator could not add a theme, retire one, or decide that
 * a PARTY room should sparkle instead of confetti without shipping a new backend. The rows in
 * `room_themes`, `visual_effects` and `room_category_effects` (migration 0015), and the
 * `profile_frames` added by 0019, are now the registry, and the panel edits them through the
 * `config:manage` routes in `admin.controller.ts`.
 *
 * Two consequences drive the shape of this file:
 *
 * 1. `toRoom()` and `toMiniUser()` in `utils/serialize.ts` run on every room DTO — hundreds of
 *    times on a discovery page — and they are synchronous. So rows are read into an immutable
 *    snapshot at boot, after every admin write, and in the background when a snapshot goes stale.
 *    No request path awaits a catalogue query. That is also why the art lives *here* rather than in
 *    `store.service`: `serialize` may import this file, and a `store` → `serialize` → `store`
 *    cycle would decide the shape of every wallet DTO by which module happened to load first.
 * 2. Clients receive URLs only (`wallpaper`, `ambientEffect`, `welcome`, `art`). A client must
 *    never derive a path from a slug, because an operator's theme lives at `/uploads/<uuid>.png`,
 *    not at `/themes/<slug>/wallpaper.png`; a client that guessed would 404 on art that exists.
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
  priceDiamonds: number;
  forSale: boolean;
  /** Days a purchase lasts; null is permanent. */
  periodDays: number | null;
};

export type RoomThemeDto = RoomTheme & {
  isDefault: boolean;
  sortOrder: number;
  /** Rooms still carrying this slug — a delete leaves them rendering the default look. */
  roomsUsing: number;
  priceDiamonds: number;
  forSale: boolean;
  periodDays: number | null;
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
  /** Every WELCOME row by key, so a member's purchased flourish resolves like the free default. */
  welcomeByKey: Map<string, string>;
  accentByTheme: Map<string, string>;
  frames: Map<string, FrameArt>;
  categoryEffects: Map<string, string>;
  loadedAt: number;
};

/** The ring a member wears: art to draw over the avatar, and a colour to fall back on. */
export type FrameArt = { key: string; name: string; art: string; accent: string };

let snapshot: Snapshot | null = null;
let loading: Promise<void> | null = null;

async function fetchSnapshot(): Promise<Snapshot> {
  const [themeRows, effectRows, categoryRows, frameRows] = await Promise.all([
    many<RoomThemeRow>('SELECT * FROM room_themes ORDER BY sort_order ASC, slug ASC'),
    many<VisualEffectRow>('SELECT * FROM visual_effects ORDER BY sort_order ASC, key ASC'),
    many<RoomCategoryEffectRow>('SELECT * FROM room_category_effects'),
    many<ProfileFrameRow>('SELECT * FROM profile_frames ORDER BY sort_order ASC, key ASC'),
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
  const welcomes = effectRows.filter((row) => row.kind === 'WELCOME');

  return {
    themes,
    defaultTheme: themeRows.find((row) => row.is_default)?.slug ?? themes[0].slug,
    // Ordered by `sort_order`, so the seeded free flourish stays first and a purchased one never
    // silently becomes what a member who bought nothing is shown.
    welcome: welcomes[0]?.url ?? null,
    ambient,
    ambientUrlByKey: new Map(ambient.map((effect) => [effect.key, effect.url])),
    welcomeByKey: new Map(welcomes.map((row) => [row.key, row.url])),
    accentByTheme: new Map(themeRows.map((row) => [row.slug, row.accent.trim()])),
    frames: new Map(
      frameRows.map((row) => [row.key, { key: row.key, name: row.name, art: row.art_url, accent: row.accent.trim() }]),
    ),
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

/** The accent of one theme, or null when the row is gone. `store.service` needs it for a shop card. */
export function themeAccentFor(slug: string): string | null {
  return current().accentByTheme.get(slug) ?? null;
}

/** The Lottie scene behind one WELCOME key, or null when an operator retired it. */
export function welcomeEffectUrlFor(key: string): string | null {
  return current().welcomeByKey.get(key) ?? null;
}

/**
 * The ring a member is wearing, or null.
 *
 * Three different situations all resolve to "no ring", and all three are correct: the account never
 * equipped one, the copy expired (the expiry is copied onto `users` by `store.service` precisely so
 * this stays synchronous), and an operator retired a key a member is still nominally wearing — the
 * receipt survives the deletion, the art does not.
 */
export function wornFrame(row: {
  profile_frame_key?: string | null;
  profile_frame_expires_at?: Date | null;
}): FrameArt | null {
  if (!row.profile_frame_key) return null;
  if (row.profile_frame_expires_at && row.profile_frame_expires_at.getTime() <= Date.now()) return null;
  return current().frames.get(row.profile_frame_key) ?? null;
}

/**
 * The flourish other members see when this one enters a room. Null means "use the free default",
 * not "show nothing" — a member who bought nothing is still announced.
 */
export function wornWelcome(row: {
  welcome_effect_key?: string | null;
  welcome_effect_expires_at?: Date | null;
}): string | null {
  if (!row.welcome_effect_key) return null;
  if (row.welcome_effect_expires_at && row.welcome_effect_expires_at.getTime() <= Date.now()) return null;
  return welcomeEffectUrlFor(row.welcome_effect_key);
}

// ---------------------------------------------------------------------------
// Admin reads
// ---------------------------------------------------------------------------

export async function listAdminCatalogue(): Promise<{
  themes: RoomThemeDto[];
  effects: VisualEffectDto[];
  categoryEffects: CategoryEffectDto[];
  frames: ProfileFrameDto[];
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
    // One call for the whole decoration screen, priced rows and rings included.
    frames: await listFrames(),
  };
}

function themeDto(row: RoomThemeRow, roomsUsing: number): RoomThemeDto {
  return {
    ...toWallpaper(row),
    isDefault: row.is_default,
    sortOrder: row.sort_order,
    roomsUsing,
    priceDiamonds: row.price_diamonds,
    forSale: row.for_sale,
    periodDays: row.period_days,
  };
}

function effectDto(row: VisualEffectRow, usedByCategories: string[]): VisualEffectDto {
  return {
    key: row.key,
    kind: row.kind as EffectKind,
    name: row.name,
    url: row.url,
    sortOrder: row.sort_order,
    usedByCategories,
    priceDiamonds: row.price_diamonds,
    forSale: row.for_sale,
    periodDays: row.period_days,
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
async function insertTheme(input: Required<ThemeChanges>, pricing: Pricing): Promise<RoomThemeDto> {
  await withTransaction(async (client) => {
    if (input.isDefault) {
      await client.query('UPDATE room_themes SET is_default = false WHERE is_default');
    }
    await client.query(
      `INSERT INTO room_themes (slug, name, accent, wallpaper_url, is_default, sort_order,
                                price_diamonds, for_sale, period_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.slug,
        input.name,
        input.accent,
        input.wallpaperUrl,
        input.isDefault,
        input.sortOrder,
        pricing.priceDiamonds,
        pricing.forSale,
        pricing.periodDays,
      ],
    );
  });
  await loadThemeRegistry();
  return themeAfterWrite(input.slug);
}

export async function createTheme(body: Record<string, unknown>): Promise<RoomThemeDto> {
  const input = readThemeBody(body ?? {});
  const pricing = readPricing(body ?? {});
  assertPricing('theme', pricing.forSale, pricing.priceDiamonds);
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
  return insertTheme(complete, pricing);
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
  const pricing = readPricing(body ?? {}, rowPricing(existing));
  assertPricing('theme', pricing.forSale, pricing.priceDiamonds);
  await withTransaction(async (client) => {
    if (changes.isDefault === true) {
      await client.query('UPDATE room_themes SET is_default = false WHERE is_default');
    }
    await client.query(
      `UPDATE room_themes
          SET name = $2, accent = $3, wallpaper_url = $4, is_default = $5, sort_order = $6,
              price_diamonds = $7, for_sale = $8, period_days = $9
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
        pricing.priceDiamonds,
        pricing.forSale,
        pricing.periodDays,
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
  const pricing = readPricing(body ?? {});
  const complete = {
    key: input.key ?? '',
    kind: input.kind ?? 'AMBIENT',
    name: input.name ?? '',
    url: input.url ?? '',
    sortOrder: input.sortOrder ?? 0,
  };
  assertPricing('effect', pricing.forSale, pricing.priceDiamonds);
  // The store only sells WELCOME flourishes: an ambient loop plays behind everybody's room, so a
  // price on one would be a row the panel shows as "buy" and no purchase path can honour.
  if (pricing.forSale && complete.kind !== 'WELCOME') {
    throw ApiError.badRequest(
      'Only a WELCOME effect can be sold — an ambient loop plays behind every room in its category',
      'effect_kind_not_sellable',
    );
  }
  const missing = (['key', 'name', 'url'] as const).filter((field) => !complete[field]);
  if (missing.length > 0) throw ApiError.badRequest(`${missing.join(', ')} required`, 'effect_fields_missing');
  if (await one<VisualEffectRow>('SELECT key FROM visual_effects WHERE key = $1', [complete.key])) {
    throw ApiError.conflict(`An effect already uses the key ${complete.key}`, 'effect_exists');
  }
  await query(
    `INSERT INTO visual_effects (key, kind, name, url, sort_order, price_diamonds, for_sale, period_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [complete.key, complete.kind, complete.name, complete.url, complete.sortOrder,
     pricing.priceDiamonds, pricing.forSale, pricing.periodDays],
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
  const pricing = readPricing(body ?? {}, rowPricing(existing));
  assertPricing('effect', pricing.forSale, pricing.priceDiamonds);
  if (pricing.forSale && existing.kind !== 'WELCOME') {
    throw ApiError.badRequest(
      'Only a WELCOME effect can be sold — an ambient loop plays behind every room in its category',
      'effect_kind_not_sellable',
    );
  }
  await query(
    `UPDATE visual_effects
        SET name = $2, url = $3, sort_order = $4, price_diamonds = $5, for_sale = $6, period_days = $7
      WHERE key = $1`,
    [
      key,
      changes.name ?? existing.name,
      changes.url ?? existing.url,
      changes.sortOrder ?? existing.sort_order,
      pricing.priceDiamonds,
      pricing.forSale,
      pricing.periodDays,
    ],
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

// ---------------------------------------------------------------------------
// Avatar frames (migration 0019)
// ---------------------------------------------------------------------------

/** One `profile_frames` row with the operator-facing fields the published catalogue hides. */
export type ProfileFrameDto = {
  key: string;
  name: string;
  art: string;
  accent: string;
  sortOrder: number;
  priceDiamonds: number;
  forSale: boolean;
  /** Days a purchase lasts; null is permanent. */
  periodDays: number | null;
  /** Members holding this ring right now, sale or grant included. */
  holders: number;
};

/**
 * The same pricing rule the database CHECK enforces, stated here so the panel gets a sentence
 * rather than a constraint name: a row is either not for sale and free, or for sale and priced.
 * There is no "on sale for zero", because that is a giveaway, and a giveaway is a different feature.
 */
function assertPricing(subject: 'frame' | 'theme' | 'effect', forSale: boolean, priceDiamonds: number): void {
  if (forSale && priceDiamonds <= 0) {
    throw ApiError.badRequest(
      'An item on sale needs a price above zero — take it off sale instead of selling it for free',
      `${subject}_price_required`,
    );
  }
  if (!forSale && priceDiamonds > 0) {
    throw ApiError.badRequest('A price only means something on an item that is for sale', `${subject}_price_without_sale`);
  }
}

/** The three price columns every sellable catalogue row carries (migration 0019). */
type Pricing = { priceDiamonds: number; forSale: boolean; periodDays: number | null };

function rowPricing(row: { price_diamonds: number; for_sale: boolean; period_days: number | null }): Pricing {
  return { priceDiamonds: row.price_diamonds, forSale: row.for_sale, periodDays: row.period_days };
}

function readPricing(body: Record<string, unknown>, existing?: Pricing): Pricing {
  const out: Pricing = {
    priceDiamonds: existing?.priceDiamonds ?? 0,
    forSale: existing?.forSale ?? false,
    periodDays: existing?.periodDays ?? null,
  };
  if (body.priceDiamonds !== undefined) {
    out.priceDiamonds = requireInt(body.priceDiamonds, 'priceDiamonds', { min: 0, max: 100_000_000 });
  }
  if (body.forSale !== undefined) out.forSale = requireBoolean(body.forSale, 'forSale');
  // `periodDays: null` is a value, not an omission: it is how an operator makes an item permanent.
  if ('periodDays' in body) {
    out.periodDays =
      body.periodDays === null || body.periodDays === ''
        ? null
        : requireInt(body.periodDays, 'periodDays', { min: 1, max: 3650 });
  }
  return out;
}

type FrameChanges = {
  key?: string;
  name?: string;
  artUrl?: string;
  accent?: string;
  sortOrder?: number;
};

function readFrameBody(body: Record<string, unknown>): FrameChanges {
  const out: FrameChanges = {};
  if (body.key !== undefined) out.key = readIdentity(body.key, 'key');
  if (body.name !== undefined) out.name = requireString(body.name, 'name', { max: 60 });
  if (body.artUrl !== undefined) out.artUrl = readUrl(body.artUrl, 'artUrl');
  if (body.accent !== undefined) out.accent = readAccent(body.accent);
  if (body.sortOrder !== undefined) out.sortOrder = requireInt(body.sortOrder, 'sortOrder', { min: -9999, max: 9999 });
  return out;
}

function frameDto(row: ProfileFrameRow, holders: number): ProfileFrameDto {
  return {
    key: row.key,
    name: row.name,
    art: row.art_url,
    accent: row.accent.trim(),
    sortOrder: row.sort_order,
    priceDiamonds: row.price_diamonds,
    forSale: row.for_sale,
    periodDays: row.period_days,
    holders,
  };
}

async function frameAfterWrite(key: string): Promise<ProfileFrameDto> {
  const row = await one<ProfileFrameRow>('SELECT * FROM profile_frames WHERE key = $1', [key]);
  if (!row) throw new Error(`frame ${key} vanished after being written`);
  const holders = await one<{ n: string }>(
    'SELECT count(*)::text n FROM user_items WHERE kind = $1 AND item_key = $2',
    ['FRAME', key],
  );
  return frameDto(row, Number(holders?.n ?? 0));
}

export async function listFrames(): Promise<ProfileFrameDto[]> {
  const [rows, usage] = await Promise.all([
    many<ProfileFrameRow>('SELECT * FROM profile_frames ORDER BY sort_order ASC, key ASC'),
    many<{ item_key: string; n: string }>(
      `SELECT item_key, count(*)::text n FROM user_items WHERE kind = 'FRAME' GROUP BY item_key`,
    ),
  ]);
  const holdersByKey = new Map(usage.map((row) => [row.item_key, Number(row.n)]));
  return rows.map((row) => frameDto(row, holdersByKey.get(row.key) ?? 0));
}

export async function createFrame(body: Record<string, unknown>): Promise<ProfileFrameDto> {
  const input = readFrameBody(body ?? {});
  const missing = (['key', 'name', 'artUrl', 'accent'] as const).filter((field) => !input[field]);
  if (missing.length > 0) throw ApiError.badRequest(`${missing.join(', ')} required`, 'frame_fields_missing');
  const pricing = readPricing(body ?? {});
  assertPricing('frame', pricing.forSale, pricing.priceDiamonds);
  if (await one<ProfileFrameRow>('SELECT key FROM profile_frames WHERE key = $1', [input.key!])) {
    throw ApiError.conflict(`A frame already uses the key ${input.key}`, 'frame_exists');
  }
  await query(
    `INSERT INTO profile_frames (key, name, art_url, accent, sort_order, price_diamonds, for_sale, period_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [input.key, input.name, input.artUrl, input.accent, input.sortOrder ?? 0, pricing.priceDiamonds, pricing.forSale, pricing.periodDays],
  );
  await loadThemeRegistry();
  return frameAfterWrite(input.key!);
}

export async function updateFrame(key: string, body: Record<string, unknown>): Promise<ProfileFrameDto> {
  const changes = readFrameBody(body ?? {});
  const existing = await one<ProfileFrameRow>('SELECT * FROM profile_frames WHERE key = $1', [key]);
  if (!existing) throw ApiError.notFound('Frame not found');
  if (changes.key && changes.key !== key) {
    throw ApiError.badRequest(
      'key is an identity — members wear it and receipts name it. Add the new key and delete this one instead',
      'frame_key_immutable',
    );
  }
  const pricing = readPricing(body ?? {}, rowPricing(existing));
  assertPricing('frame', pricing.forSale, pricing.priceDiamonds);
  const next = {
    name: changes.name ?? existing.name,
    artUrl: changes.artUrl ?? existing.art_url,
    accent: changes.accent ?? existing.accent.trim(),
    sortOrder: changes.sortOrder ?? existing.sort_order,
  };
  await query(
    `UPDATE profile_frames
        SET name = $2, art_url = $3, accent = $4, sort_order = $5,
            price_diamonds = $6, for_sale = $7, period_days = $8
      WHERE key = $1`,
    [key, next.name, next.artUrl, next.accent, next.sortOrder, pricing.priceDiamonds, pricing.forSale, pricing.periodDays],
  );
  await loadThemeRegistry();
  return frameAfterWrite(key);
}

/**
 * Retire a frame.
 *
 * Members keep their receipts and the key on their account, exactly the way rooms keep a deleted
 * theme slug: `wornFrame()` finds no art for a key that is gone and draws no ring. Deleting the
 * ownership rows as well would destroy the proof that somebody paid for something.
 */
export async function deleteFrame(key: string): Promise<{ ok: true; key: string; membersStillHolding: number }> {
  const existing = await one<ProfileFrameRow>('SELECT key FROM profile_frames WHERE key = $1', [key]);
  if (!existing) throw ApiError.notFound('Frame not found');
  const holders = await one<{ n: string }>(
    'SELECT count(*)::text n FROM user_items WHERE kind = $1 AND item_key = $2',
    ['FRAME', key],
  );
  await query('DELETE FROM profile_frames WHERE key = $1', [key]);
  await loadThemeRegistry();
  return { ok: true, key, membersStillHolding: Number(holders?.n ?? 0) };
}
