import fs from 'node:fs';
import path from 'node:path';

/**
 * Room theme registry.
 *
 * `public/themes/manifest.json` is the single source of truth: it is written by
 * scripts/generate-placeholder-assets.cjs together with the wallpapers it
 * references, so a theme can never be listed without its art. The API serves
 * this list and clients resolve the root-relative URLs against the API origin.
 */
export type RoomTheme = {
  slug: string;
  name: string;
  accent: string;
  wallpaper: string;
};

type Manifest = {
  welcome: string;
  effects: string[];
  themes: RoomTheme[];
};

const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'public', 'themes', 'manifest.json');

function load(): Manifest {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  if (!Array.isArray(manifest.themes) || manifest.themes.length === 0) {
    throw new Error(`${MANIFEST_PATH} lists no themes`);
  }
  return manifest;
}

const manifest = load();

export const THEMES: readonly RoomTheme[] = manifest.themes;
export const THEME_SLUGS: readonly string[] = THEMES.map((theme) => theme.slug);
export const DEFAULT_THEME = THEMES[0].slug;
export const WELCOME_EFFECT = manifest.welcome;
export const ROOM_EFFECTS: readonly string[] = manifest.effects;

export type ThemeCatalogue = {
  themes: readonly RoomTheme[];
  defaultTheme: string;
  welcome: string;
  effects: readonly string[];
};

export function themeCatalogue(): ThemeCatalogue {
  return {
    themes: THEMES,
    defaultTheme: DEFAULT_THEME,
    welcome: WELCOME_EFFECT,
    effects: ROOM_EFFECTS,
  };
}

export function isTheme(slug: string): slug is string {
  return THEMES.some((theme) => theme.slug === slug);
}

/** Rooms may still carry a slug whose art was removed; render the default instead. */
export function themeFor(slug: string | null | undefined): RoomTheme {
  return THEMES.find((theme) => theme.slug === slug) ?? THEMES[0];
}

// ---------------------------------------------------------------------------
// Ambient room effects
// ---------------------------------------------------------------------------
// Which loop plays behind a room is a property of the room, decided here rather
// than hard-coded in a client build: the API sends the URL on every room DTO and
// the app renders whatever arrives. Keyed by category because that is what a
// room actually is — a party looks different from a chat room even when the host
// picks the same wallpaper.
const CATEGORY_EFFECTS: Record<string, string> = {
  PARTY: 'room-confetti',
  MUSIC: 'room-sparkle',
  CHAT: 'room-glow',
  GAME: 'room-glow',
  POPULAR: 'room-hearts',
};

const effectByName = new Map(ROOM_EFFECTS.map((url) => [path.parse(url).name, url]));

// A mapping that points at a file the generator did not write would silently
// 404 on every device, so fail at boot like the theme list already does.
for (const name of Object.values(CATEGORY_EFFECTS)) {
  if (!effectByName.has(name)) throw new Error(`${MANIFEST_PATH} has no /effects/${name}.json`);
}

/** Root-relative Lottie URL for a room category; falls back to the first effect. */
export function ambientEffectFor(category: string | null | undefined): string {
  const name = CATEGORY_EFFECTS[category ?? ''] ?? CATEGORY_EFFECTS.CHAT;
  return effectByName.get(name) ?? ROOM_EFFECTS[0];
}
