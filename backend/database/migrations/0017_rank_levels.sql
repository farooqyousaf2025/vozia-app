-- 0017 — Levels become a ladder the administrator owns.
--
-- §5 of the platform brief asks for two different things that this repository had only half of:
--
--   * "VIP membership" — `users.vip_level`, an operator-set spend tier that gates which gifts a
--     member may buy (`gifts.min_vip_level`, enforced in `ledger.service.ts`). It still is.
--   * "User experience and levels" — an *earned* rank. Nothing existed: no experience counter,
--     no names for the rungs, no badge artwork, and a phone that could only show a bare integer.
--
-- This migration adds the earned one. `users.xp` is a server-maintained total that a client can
-- never write (there is no route that accepts it), and `rank_levels` is the ladder that turns a
-- number into something a member can see: a rung, a name, a badge image and a colour. The panel
-- edits those rows under `/api/admin/ranks` exactly like it edits gifts, themes and chat emoji, so
-- renaming Gold III or moving it from 30,000 XP to 25,000 is an operation, not a release.
--
-- Keeping rank and VIP apart is deliberate. Raising somebody's VIP is a commercial decision about
-- what they may spend; a rank is a record of what they already did. Folding them together would
-- mean an operator's "give this host a free tier" edit silently rewrote their history.

ALTER TABLE users ADD COLUMN IF NOT EXISTS xp BIGINT NOT NULL DEFAULT 0 CHECK (xp >= 0);

COMMENT ON COLUMN users.xp IS 'Lifetime experience, moved only by server-side activity (see rank.service.ts). Compared against rank_levels.min_xp to find the member''s rung; never settable by a client.';

CREATE TABLE IF NOT EXISTS rank_levels (
  -- The rung's number, not a slug: `users.xp` is compared against `min_xp` to find it, and the
  -- scale is bounded by the same 0..20 CHECK `users.vip_level` uses so a device that has an old
  -- build cached cannot be shown a level it has no room to draw.
  level    SMALLINT    PRIMARY KEY CHECK (level >= 0 AND level <= 20),
  name     VARCHAR(60) NOT NULL,
  -- Root-relative (served by this API) or https (a CDN mirror). The same rule as
  -- visual_effects.url, room_themes.wallpaper_url and emoji_characters.url: this string is handed
  -- to every device, so a javascript: or file: value must not be storable even by an operator.
  badge_url TEXT       NOT NULL CHECK (badge_url ~ '^(/|https://)'),
  accent    CHAR(7)    NOT NULL CHECK (accent ~ '^#[0-9a-fA-F]{6}$'),
  -- Experience a member must hold to sit at this rung. `min_xp = 0` for level 0 is the floor:
  -- every account has one, so there is always a badge to show.
  min_xp   BIGINT      NOT NULL DEFAULT 0 CHECK (min_xp >= 0),
  is_active BOOLEAN    NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A ladder is read by level on every user DTO and searched by threshold on the admin writes that
-- have to prove the rungs stay in order; both are cheap here because the table holds 21 rows.
CREATE INDEX IF NOT EXISTS rank_levels_min_xp_idx ON rank_levels (min_xp, level);

COMMENT ON TABLE rank_levels IS 'Earned-level ladder: level -> name, badge art, colour and the XP needed to reach it. Admin-managed; published by GET /api/ranks.';
COMMENT ON COLUMN rank_levels.min_xp IS 'Inclusive XP floor for this rung. rank.service refuses a write that would put a rung below the one under it, so the ladder cannot fold back on itself.';
COMMENT ON COLUMN rank_levels.badge_url IS 'Art the phone draws beside the name in the entry banner, the seat grid and the ranking sheet. Clients get this URL; they never build it from the level.';
COMMENT ON COLUMN rank_levels.is_active IS 'false retires a rung: it stops appearing in the published ladder and nobody can be placed on it, but rows keep resolving to the nearest live rung below.';

-- Seeds: a 21-rung ladder on the scale `users.vip_level` already uses, with the badge art
-- scripts/generate-placeholder-assets.cjs writes into backend/public/badges/. Thresholds are the
-- starting point an operator is expected to re-tune once real spend data exists — which is the
-- whole reason they are rows.
INSERT INTO rank_levels (level, name, badge_url, accent, min_xp) VALUES
  (0,  'Newcomer',   '/badges/level-0.png',  '#9aa5b1', 0),
  (1,  'Bronze I',   '/badges/level-1.png',  '#a9714b', 300),
  (2,  'Bronze II',  '/badges/level-2.png',  '#b07a52', 800),
  (3,  'Bronze III', '/badges/level-3.png',  '#b8835a', 1600),
  (4,  'Silver I',   '/badges/level-4.png',  '#a8b0ba', 3000),
  (5,  'Silver II',  '/badges/level-5.png',  '#b3bbc4', 5000),
  (6,  'Silver III', '/badges/level-6.png',  '#c0c7cf', 8000),
  (7,  'Gold I',     '/badges/level-7.png',  '#d9a53c', 13000),
  (8,  'Gold II',    '/badges/level-8.png',  '#e2b04a', 20000),
  (9,  'Gold III',   '/badges/level-9.png',  '#ecbc58', 30000),
  (10, 'Platinum I', '/badges/level-10.png', '#7fd3c8', 45000),
  (11, 'Platinum II', '/badges/level-11.png', '#8adbd0', 65000),
  (12, 'Platinum III', '/badges/level-12.png', '#96e2d8', 90000),
  (13, 'Diamond I',  '/badges/level-13.png', '#7ea8ff', 125000),
  (14, 'Diamond II', '/badges/level-14.png', '#8bb2ff', 170000),
  (15, 'Diamond III', '/badges/level-15.png', '#98bdff', 230000),
  (16, 'Crown I',    '/badges/level-16.png', '#c98cff', 300000),
  (17, 'Crown II',   '/badges/level-17.png', '#d49bff', 400000),
  (18, 'Crown III',  '/badges/level-18.png', '#dfabff', 520000),
  (19, 'Legend',     '/badges/level-19.png', '#ff8f9e', 700000),
  (20, 'Immortal',   '/badges/level-20.png', '#ff6b3d', 950000)
ON CONFLICT (level) DO NOTHING;
