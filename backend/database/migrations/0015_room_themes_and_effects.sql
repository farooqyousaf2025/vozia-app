-- 0015 — Room themes and ambient effects become data the administrator owns.
--
-- Until now the theme list and the effect loops were read out of
-- backend/public/themes/manifest.json at boot, which meant the only room decoration a host could
-- pick was one this repository had generated and shipped. The art stays where it is — the
-- generator still writes wallpapers and Lottie files into public/ — but *which* of them exist,
-- what they are called, which one is the default and which loop plays behind a PARTY room is now
-- rows in the database, editable from the admin panel like the gift catalogue already is.
--
-- Seeds below are the values that manifest carried on the day this migration was written, so an
-- upgrade changes nothing an operator can see. On a fresh install schema.sql runs first and this
-- migration seeds the catalogue; the manifest file remains the generator's own record and the
-- source these INSERTs were copied from, not a runtime registry.
--
-- visual_effects is the same table media_assets' COMMENT already pointed at: an effect is a
-- Lottie URL with a name, whether it loops behind a room or flashes once when someone joins.

CREATE TABLE IF NOT EXISTS visual_effects (
  key        VARCHAR(40) PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  kind       VARCHAR(16) NOT NULL CHECK (kind IN ('AMBIENT', 'WELCOME')),
  name       VARCHAR(60) NOT NULL,
  -- Root-relative (served by this API) or https (a CDN mirror). Anything else — a javascript:
  -- or file: URL — would be handed straight to every device that joins a room.
  url        TEXT        NOT NULL CHECK (url ~ '^(/|https://)'),
  sort_order INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE visual_effects IS 'Lottie scenes the room plays: AMBIENT loops behind the seats, WELCOME flashes on entry. Admin-managed; published by GET /api/rooms/themes.';
COMMENT ON COLUMN visual_effects.key IS 'Stable identifier rooms map to (room_category_effects.effect_key). Renaming a key is a delete plus an insert, not an UPDATE.';

CREATE TABLE IF NOT EXISTS room_themes (
  slug          VARCHAR(40) PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  name          VARCHAR(60) NOT NULL,
  accent        CHAR(7)     NOT NULL CHECK (accent ~ '^#[0-9a-fA-F]{6}$'),
  wallpaper_url TEXT        NOT NULL CHECK (wallpaper_url ~ '^(/|https://)'),
  is_default    BOOLEAN     NOT NULL DEFAULT false,
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one theme is the default. A partial unique index makes PostgreSQL enforce it: rows with
-- is_default = false are not indexed at all, so any number of them may exist.
CREATE UNIQUE INDEX IF NOT EXISTS room_themes_one_default_idx ON room_themes (is_default) WHERE is_default;

COMMENT ON TABLE room_themes IS 'Room backgrounds a host or an operator can pick. Replaces the boot-time read of public/themes/manifest.json.';
COMMENT ON COLUMN room_themes.accent IS 'Hex colour clients tint the room chrome with; validated as #rrggbb so a stray value cannot break a CSS or Compose parser.';

-- Which ambient loop plays behind a room is a property of the room's category, and two categories
-- may share one loop (GAME and CHAT both glowed). ON DELETE RESTRICT: deleting an effect that a
-- category still names would leave the mapping pointing at nothing.
CREATE TABLE IF NOT EXISTS room_category_effects (
  category   room_category PRIMARY KEY,
  effect_key VARCHAR(40)   NOT NULL REFERENCES visual_effects (key) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE room_category_effects IS 'One AMBIENT visual_effects.key per room_category. A category with no row falls back to the default theme''s loop, never to a blank screen.';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['visual_effects', 'room_themes', 'room_category_effects'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %1$s_updated_at ON %1$I;
       CREATE TRIGGER %1$s_updated_at BEFORE UPDATE ON %1$I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

-- ---- seed: the catalogue public/themes/manifest.json shipped with ---------------------------

INSERT INTO visual_effects (key, kind, name, url, sort_order) VALUES
  ('room-sparkle',  'AMBIENT', 'Sparkle',  '/effects/room-sparkle.json',  10),
  ('room-confetti', 'AMBIENT', 'Confetti', '/effects/room-confetti.json', 20),
  ('room-hearts',   'AMBIENT', 'Hearts',   '/effects/room-hearts.json',   30),
  ('room-glow',     'AMBIENT', 'Glow',     '/effects/room-glow.json',     40),
  ('welcome',       'WELCOME', 'Welcome flourish', '/welcome.json',       10)
ON CONFLICT (key) DO NOTHING;

INSERT INTO room_themes (slug, name, accent, wallpaper_url, is_default, sort_order) VALUES
  ('aurora',          'Aurora',          '#3ddc97', '/themes/aurora/wallpaper.png',          true,  10),
  ('nebula',          'Nebula',          '#f472b6', '/themes/nebula/wallpaper.png',          false, 20),
  ('sunset-glass',    'Sunset Glass',    '#fbbf24', '/themes/sunset-glass/wallpaper.png',    false, 30),
  ('midnight-ocean',  'Midnight Ocean',  '#38bdf8', '/themes/midnight-ocean/wallpaper.png',  false, 40)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO room_category_effects (category, effect_key) VALUES
  ('PARTY',    'room-confetti'),
  ('MUSIC',    'room-sparkle'),
  ('CHAT',     'room-glow'),
  ('GAME',     'room-glow'),
  ('POPULAR',  'room-hearts')
ON CONFLICT (category) DO NOTHING;

-- A wallpaper is the sixth thing an operator can upload, and the two new tables above are what
-- make it necessary: choosing a theme's background from the panel means pointing `wallpaper_url`
-- at `/uploads/<uuid>.png`. 0014 documented five kinds; this restates the column with the sixth.
COMMENT ON COLUMN media_assets.kind IS 'GIFT_ICON | GIFT_ANIMATION | GIFT_SOUND | EFFECT | BADGE | WALLPAPER; decides which formats and byte cap the upload must satisfy.';
