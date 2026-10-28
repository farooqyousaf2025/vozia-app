-- 0019 — Cosmetics become things a member can buy, own and wear.
--
-- Three catalogues already exist in this database: `room_themes` (migration 0015), `visual_effects`
-- (0015) and `rank_levels` (0017). All three are administrator-owned, all three are published to
-- devices as URLs, and none of them can make anybody a single coin: an operator decides what every
-- room looks like and every member sees the same thing. The one thing missing was the counter that
-- turns that art into an economy.
--
-- This migration adds it, and pointedly does not add a fourth catalogue. Prices and rental periods
-- are columns on the rows that already hold the art, so an operator edits a theme's price on the
-- same screen as its wallpaper — one place to learn, one place to be right. `profile_frames` is the
-- only new catalogue because nothing here sold an avatar ring before; its art came from the same
-- MIT-licensed Trace library as the rank seals (see THIRD_PARTY_LICENSES/trace-assets/PROVENANCE.md).
--
-- `rank_levels` deliberately stays out of the store. A rung is a record of what a member already
-- did; a frame is what they chose to spend on. Selling levels would fold those two together, which
-- is the same mistake 0017 argues against for VIP.

-- ---------------------------------------------------------------------------
-- Prices on the rows that already exist
-- ---------------------------------------------------------------------------
--
-- One rule holds for all three tables, and it is enforced by CHECK rather than by service code so
-- a hand-edited row cannot contradict it: an item is either *not for sale*, which means anybody may
-- use it (the default aurora theme, the original welcome flourish), or it is for sale at a price
-- above zero. There is no "for sale, free" state, because that is a giveaway and a giveaway needs a
-- reason, which is a different feature.
--
-- `period_days` is the rental length: how long a purchase keeps working. NULL means permanent, so
-- an operator can sell something once and forever, which is what most people expect a purchase to
-- be. Bounded above because a period nobody can reach in the app's lifetime is a bug dressed as a
-- price.

ALTER TABLE room_themes
  ADD COLUMN IF NOT EXISTS price_diamonds INTEGER NOT NULL DEFAULT 0 CHECK (price_diamonds >= 0),
  ADD COLUMN IF NOT EXISTS for_sale       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS period_days    SMALLINT CHECK (period_days IS NULL OR period_days BETWEEN 1 AND 3650);

ALTER TABLE visual_effects
  ADD COLUMN IF NOT EXISTS price_diamonds INTEGER NOT NULL DEFAULT 0 CHECK (price_diamonds >= 0),
  ADD COLUMN IF NOT EXISTS for_sale       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS period_days    SMALLINT CHECK (period_days IS NULL OR period_days BETWEEN 1 AND 3650);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['room_themes', 'visual_effects'] LOOP
    EXECUTE format(
      'ALTER TABLE %1$I DROP CONSTRAINT IF EXISTS %1$s_priced_if_for_sale,
                ADD CONSTRAINT %1$s_priced_if_for_sale
                CHECK ((NOT for_sale AND price_diamonds = 0) OR (for_sale AND price_diamonds > 0))', t);
  END LOOP;
END $$;

COMMENT ON COLUMN room_themes.for_sale IS 'true = a host must own this theme before a room can wear it. false = free for everyone, which is how the seeded default stays.';
COMMENT ON COLUMN room_themes.period_days IS 'Days a purchase lasts. NULL never expires. Rebuying adds another period to whatever time is left.';
COMMENT ON COLUMN visual_effects.for_sale IS 'Only meaningful for WELCOME rows today: an AMBIENT loop is chosen by room category, not by a person, so selling one needs a room-level override that does not exist yet.';

-- ---------------------------------------------------------------------------
-- The new catalogue: avatar frames
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profile_frames (
  key        VARCHAR(40) PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  name       VARCHAR(60) NOT NULL,
  -- Same URL rule as every other art column in this schema: this string is handed to devices, so a
  -- `javascript:` or `file:` value must not be storable even by an operator.
  art_url    TEXT        NOT NULL CHECK (art_url ~ '^(/|https://)'),
  accent     CHAR(7)     NOT NULL CHECK (accent ~ '^#[0-9a-fA-F]{6}$'),
  sort_order INTEGER     NOT NULL DEFAULT 0,
  price_diamonds INTEGER NOT NULL DEFAULT 0 CHECK (price_diamonds >= 0),
  for_sale       BOOLEAN NOT NULL DEFAULT false,
  period_days    SMALLINT CHECK (period_days IS NULL OR period_days BETWEEN 1 AND 3650),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT profile_frames_priced_if_for_sale
    CHECK ((NOT for_sale AND price_diamonds = 0) OR (for_sale AND price_diamonds > 0))
);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS profile_frames_updated_at ON profile_frames;
  CREATE TRIGGER profile_frames_updated_at BEFORE UPDATE ON profile_frames
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE profile_frames IS 'Avatar rings a member buys and wears in the seat grid, on their profile and in the entry banner. Admin-managed; published by GET /api/store.';
COMMENT ON COLUMN profile_frames.art_url IS 'A ring with a transparent middle, drawn over the avatar rather than replacing it. Clients get this URL and never build one from the key.';
COMMENT ON COLUMN profile_frames.accent IS 'Fallback ring colour for a client that cannot load the art, so a slow CDN shows a plain circle instead of a missing image.';

-- ---------------------------------------------------------------------------
-- Ownership
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_items (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Which catalogue the key indexes into. A literal rather than three nullable FK columns: one row
  -- per owned thing keeps the UNIQUE below possible, and a purchase receipt should not be able to
  -- point at two items at once.
  kind        TEXT        NOT NULL CHECK (kind IN ('FRAME', 'THEME', 'EFFECT')),
  item_key    TEXT        NOT NULL,
  -- 'ADMIN_GRANT' exists so support can hand a frame back to a member whose purchase was reversed,
  -- or give one to a host for an event. It is recorded rather than inferred from a missing
  -- transaction, because "who gave me this" is the first question a dispute asks.
  acquired_via TEXT       NOT NULL DEFAULT 'PURCHASE' CHECK (acquired_via IN ('PURCHASE', 'ADMIN_GRANT')),
  -- The single posted ledger row that paid for this. ON DELETE SET NULL: a receipt outlives its
  -- ledger row only if somebody deletes ledger rows, which the ledger rules forbid anyway.
  transaction_id UUID     REFERENCES transactions (id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One row per member per item. A second purchase extends `expires_at` instead of inserting a
  -- duplicate, which is what makes "own it twice" impossible to represent.
  UNIQUE (user_id, kind, item_key)
);

-- The two reads this table actually serves: "what does this member own" (the store screen, every
-- equip check) and "is this item still worn" (the expiry sweep in store.service's resolve path).
CREATE INDEX IF NOT EXISTS user_items_user_idx ON user_items (user_id, kind, expires_at);
CREATE INDEX IF NOT EXISTS user_items_item_idx ON user_items (kind, item_key);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS user_items_updated_at ON user_items;
  CREATE TRIGGER user_items_updated_at BEFORE UPDATE ON user_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE user_items IS 'What a member owns and until when. One row per (member, item); a repeat purchase extends the expiry rather than adding a row.';
COMMENT ON COLUMN user_items.item_key IS 'profile_frames.key, room_themes.slug or visual_effects.key depending on kind. No foreign key on purpose: an operator retiring a theme must not delete the receipt that says a member paid for it, and rooms already keep a dead theme slug for the same reason.';
COMMENT ON COLUMN user_items.expires_at IS 'NULL = permanent. An expired row is kept, not deleted: it is the history of a purchase, and rebuying restarts from max(expires_at, now()).';

-- ---------------------------------------------------------------------------
-- What a member is wearing right now
-- ---------------------------------------------------------------------------
--
-- The key alone would be enough for a page that loads the item rows, but `toUser()` is synchronous
-- and runs on every seat of every room DTO. So the expiry is copied onto the user, exactly the way
-- 0017 put `xp` on the user and kept the ladder in memory: the per-member scalar lives on the row,
-- the catalogue it points into lives in a snapshot. `store.service` refreshes both together, and a
-- renewal that extends an item currently being worn updates this copy too — otherwise a member who
-- bought their frame a second time would watch it vanish on the old date.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_frame_key        VARCHAR(40),
  ADD COLUMN IF NOT EXISTS profile_frame_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS welcome_effect_key       VARCHAR(40),
  ADD COLUMN IF NOT EXISTS welcome_effect_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN users.profile_frame_key IS 'Equipped profile_frames.key, or NULL for no ring. Never a client field: /api/store/equip checks ownership and expiry server-side, and there is no route that accepts a key the member does not hold.';
COMMENT ON COLUMN users.welcome_effect_key IS 'The flourish other members see when this one enters a room. NULL means the free default, not "no effect".';
COMMENT ON COLUMN users.profile_frame_expires_at IS 'Denormalised copy of user_items.expires_at so the synchronous seat DTO can tell a worn ring from an expired one without a join. store.service writes both in the same transaction.';

-- ---------------------------------------------------------------------------
-- The ledger gets one more thing money can buy
-- ---------------------------------------------------------------------------
--
-- `ALTER TYPE ... ADD VALUE` is allowed inside this file's transaction but the new label cannot be
-- used by it, which is why nothing below inserts an ITEM_PURCHASE row. The value is what
-- `store.service.purchaseItem` posts: diamonds out of one wallet, no receiver, no R-coins, because a
-- cosmetic is a sink and not a transfer.

-- `IF NOT EXISTS` rather than an exception block: PostgreSQL refuses to run this statement inside a
-- subtransaction, so a DO wrapper is not available here.
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'ITEM_PURCHASE';

COMMENT ON COLUMN transactions.type IS 'GIFT_SENT | RECHARGE | WITHDRAWAL | ADMIN_ADJUSTMENT | AGENCY_COMMISSION | SEAT_FEE | GAME_ENTRY | GAME_PRIZE | GAME_REFUND | PLATFORM_COMMISSION | RECHARGE_REVERSAL | ITEM_PURCHASE. ITEM_PURCHASE has a sender, no receiver and no R-coins: the platform keeps the diamonds.';

-- ---------------------------------------------------------------------------
-- Seeds: a starting shop an operator can re-price on screen
-- ---------------------------------------------------------------------------
--
-- Prices are on the same scale as the gift catalogue (a Rose is 1, a Rocket 500, Fireworks 2,500)
-- and therefore on the same XP scale, since spending is what moves `users.xp` at 1 XP per diamond.
-- They are the opening position, not a decision this file is attached to — the reason they are rows
-- is that the person running the platform can change them.

INSERT INTO profile_frames (key, name, art_url, accent, sort_order, price_diamonds, for_sale, period_days) VALUES
  ('ring-bronze',   'Bronze Ring',    '/frames/trace/frame-1.png',  '#c98a6b', 10,  300, true, 30),
  ('ring-silver',   'Silver Ring',    '/frames/trace/frame-2.png',  '#b3bbc4', 20,  600, true, 30),
  ('ring-jade',     'Jade Ring',      '/frames/trace/frame-3.png',  '#3ddc97', 30, 1200, true, 30),
  ('ring-ocean',    'Ocean Ring',     '/frames/trace/frame-4.png',  '#38bdf8', 40, 2000, true, 30),
  ('ring-amber',    'Amber Ring',     '/frames/trace/frame-5.png',  '#fbbf24', 50, 3000, true, 30),
  ('ring-rose',     'Rose Ring',      '/frames/trace/frame-6.png',  '#f472b6', 60, 4500, true, 30),
  ('ring-sky',      'Sky Ring',       '/frames/trace/frame-7.png',  '#8bb2ff', 70, 6000, true, 30),
  ('ring-violet',   'Violet Ring',    '/frames/trace/frame-8.png',  '#c98cff', 80, 8000, true, 30),
  ('ring-crown',    'Crown Ring',     '/frames/trace/frame-9.png',  '#dfabff', 90, 12000, true, 30),
  ('ring-immortal', 'Immortal Ring',  '/frames/trace/frame-10.png', '#ff6b3d', 100, 20000, true, 30)
ON CONFLICT (key) DO NOTHING;

-- The aurora theme is the platform default and stays free; the other three become the shop window.
UPDATE room_themes
   SET price_diamonds = CASE slug
                          WHEN 'nebula'         THEN 1500
                          WHEN 'sunset-glass'   THEN 1500
                          WHEN 'midnight-ocean' THEN 2000
                          ELSE price_diamonds
                        END,
       for_sale   = true,
       period_days = 30
 WHERE slug IN ('nebula', 'sunset-glass', 'midnight-ocean')
   AND for_sale = false
   AND price_diamonds = 0;

-- Entry flourishes. These reuse the ambient Lottie files already in public/effects/: the client
-- plays a WELCOME scene once (iterations = 1) instead of looping it, which is what turns the same
-- artwork into a burst rather than a background. The original free `welcome` row is untouched and
-- stays first by sort_order, so a member who buys nothing sees exactly what they saw yesterday.
INSERT INTO visual_effects (key, kind, name, url, sort_order, price_diamonds, for_sale, period_days) VALUES
  ('welcome-confetti', 'WELCOME', 'Confetti Burst',  '/effects/room-confetti.json', 20, 800,  true, 30),
  ('welcome-hearts',   'WELCOME', 'Heart Rain',      '/effects/room-hearts.json',   30, 1200, true, 30),
  ('welcome-spectrum', 'WELCOME', 'Spectrum Flash',  '/effects/room-spectrum.json', 40, 2000, true, 30)
ON CONFLICT (key) DO NOTHING;
