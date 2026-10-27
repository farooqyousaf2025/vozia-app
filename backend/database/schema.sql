-- =============================================================================
-- Voiza — audio party room platform
-- PostgreSQL schema (idempotent: safe to re-run)
-- =============================================================================
-- Mounted at /docker-entrypoint-initdb.d/01-schema.sql, so Postgres applies it
-- automatically on first container start. To re-apply against a live database:
--   psql "$DATABASE_URL" -f backend/database/schema.sql
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- ILIKE containment indexes for admin search

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_type   AS ENUM ('HOST', 'USER', 'AGENCY_ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('ACTIVE', 'BANNED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE room_type   AS ENUM ('PUBLIC', 'PRIVATE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE room_status AS ENUM ('ACTIVE', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE room_category AS ENUM ('POPULAR', 'PARTY', 'MUSIC', 'GAME', 'CHAT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE seat_status AS ENUM ('EMPTY', 'OCCUPIED', 'LOCKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE participant_role AS ENUM ('HOST', 'SPEAKER', 'AUDIENCE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE transaction_type AS ENUM (
    'GIFT_SENT', 'RECHARGE', 'WITHDRAWAL',
    'ADMIN_ADJUSTMENT', 'AGENCY_COMMISSION', 'SEAT_FEE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE transaction_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE withdrawal_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agency_status AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE chat_message_type AS ENUM ('TEXT', 'GIFT', 'SYSTEM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- agencies  (created first: users reference nothing here, but agency_hosts does,
--            and we allow an agency to point at its owner user later via ALTER)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agencies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(80)  NOT NULL UNIQUE,
  logo_url        TEXT,
  contact_phone   VARCHAR(20),
  commission_bps  INT          NOT NULL DEFAULT 1000,   -- 10.00 % platform cut back to agency
    CHECK (commission_bps BETWEEN 0 AND 10000),
  status          agency_status NOT NULL DEFAULT 'PENDING',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone             VARCHAR(20)  NOT NULL UNIQUE,
  username          VARCHAR(40)  NOT NULL UNIQUE,
  avatar_url        TEXT,
  bio               VARCHAR(200),
  gender            VARCHAR(10),
  country_code      VARCHAR(2),
  diamond_balance   INT          NOT NULL DEFAULT 0 CHECK (diamond_balance >= 0),
  r_coin_balance    INT          NOT NULL DEFAULT 0 CHECK (r_coin_balance    >= 0),
  -- lifetime counters, maintained by the ledger service (not triggers) so the
  -- numbers stay consistent with transactions regardless of admin adjustments
  total_gifts_sent     BIGINT NOT NULL DEFAULT 0,
  total_gifts_received BIGINT NOT NULL DEFAULT 0,
  user_type         user_type    NOT NULL DEFAULT 'USER',
  status            user_status  NOT NULL DEFAULT 'ACTIVE',
  is_verified       BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Spend gate: gifts.min_vip_level is compared against this on every send.
  vip_level         INT          NOT NULL DEFAULT 0 CHECK (vip_level >= 0 AND vip_level <= 20),
  device_token      TEXT,                              -- push (FCM) target
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Pre-existing databases were created before vip_level existed; ADD COLUMN IF NOT
-- EXISTS keeps schema.sql idempotent, which is what lets the container re-apply it
-- on every boot.
ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_level INT NOT NULL DEFAULT 0
  CHECK (vip_level >= 0 AND vip_level <= 20);

CREATE INDEX IF NOT EXISTS users_status_idx        ON users (status);
CREATE INDEX IF NOT EXISTS users_user_type_idx     ON users (user_type);
CREATE INDEX IF NOT EXISTS users_last_seen_idx     ON users (last_seen_at DESC NULLS LAST);
-- GIN trigram indexes so admin `ILIKE '%term%'` searches stay fast on large user tables
CREATE INDEX IF NOT EXISTS users_phone_trgm_idx    ON users USING GIN (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_username_trgm_idx ON users USING GIN (username gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- otp_codes — mock/real SMS one-time codes. We store a hash so a DB leak cannot
-- be replayed against the auth endpoint.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS otp_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       VARCHAR(20) NOT NULL,
  code_hash   TEXT        NOT NULL,
  purpose     VARCHAR(16) NOT NULL DEFAULT 'LOGIN',
  attempts    INT         NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS otp_phone_idx ON otp_codes (phone, created_at DESC);

-- ---------------------------------------------------------------------------
-- admins — back-office operators for the React admin panel. Kept separate from
-- `users` so a party account can never escalate to panel access by renaming.
-- Seeded on boot by the backend from ADMIN_BOOTSTRAP_* env vars.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(40) NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  display_name  VARCHAR(60),
  role          VARCHAR(16) NOT NULL DEFAULT 'MODERATOR',   -- SUPER | MODERATOR
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- rooms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_number    INT  NOT NULL UNIQUE,                 -- short human-joinable number
  title          VARCHAR(60) NOT NULL,
  description    VARCHAR(200),
  cover_url      TEXT,
  -- room theme; see backend/src/config/themes.ts for the registry it must match
  theme          VARCHAR(32) NOT NULL DEFAULT 'aurora',
  host_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type           room_type     NOT NULL DEFAULT 'PUBLIC',
  -- scrypt hash; NULL for PUBLIC rooms
  password_hash  TEXT,
  seat_capacity  INT NOT NULL DEFAULT 9 CHECK (seat_capacity BETWEEN 1 AND 12),
  status         room_status   NOT NULL DEFAULT 'ACTIVE',
  category       room_category NOT NULL DEFAULT 'PARTY',
  livekit_room_name TEXT NOT NULL,                     -- usually 'voiza-<uuid>'
  listener_count INT NOT NULL DEFAULT 0,               -- denormalised, refreshed by socket layer
  total_gift_value BIGINT NOT NULL DEFAULT 0,          -- R-coins received, drives Popular ranking
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ
);

-- rooms carries the set_updated_at trigger below, so the column must exist even
-- in databases created before it was declared (UPDATE on rooms otherwise aborts
-- with `record "new" has no field "updated_at"`).
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- Databases created before theming need the column too; 'aurora' is the default look.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS theme VARCHAR(32) NOT NULL DEFAULT 'aurora';
-- Likes are counted live in Redis and flushed here, so a room's total survives a
-- restart and the ops console can rank rooms by engagement.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS like_count BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS rooms_active_idx   ON rooms (status, category, created_at DESC);
CREATE INDEX IF NOT EXISTS rooms_host_idx     ON rooms (host_id);
CREATE INDEX IF NOT EXISTS rooms_popular_idx  ON rooms (status, total_gift_value DESC);

-- ---------------------------------------------------------------------------
-- room_seats — one row per (room, seat_index). Rows are pre-created on room
-- creation so locking a seat never races with seat materialisation.
-- seat_index 0 is the host seat; 1..8 are speaker seats.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_seats (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  seat_index INT  NOT NULL CHECK (seat_index >= 0 AND seat_index <= 11),
  user_id    UUID REFERENCES users (id) ON DELETE SET NULL,
  status     seat_status NOT NULL DEFAULT 'EMPTY',
  is_muted   BOOLEAN NOT NULL DEFAULT FALSE,
  -- TRUE on seat 0 and any seat the host appointed; controls who may publish audio
  is_speaker BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, seat_index),
  -- OCCUPIED requires a user, EMPTY/LOCKED must not carry one
  CHECK ((status = 'OCCUPIED') = (user_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS room_seats_room_idx ON room_seats (room_id, seat_index);
CREATE INDEX IF NOT EXISTS room_seats_user_idx ON room_seats (user_id);

-- ---------------------------------------------------------------------------
-- room_participants — everyone present (speakers + audience). left_at IS NULL
-- means currently inside. Drives the audience strip and hand-raise queue.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_participants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     UUID NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        participant_role NOT NULL DEFAULT 'AUDIENCE',
  seat_index  INT,
  hand_raised BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS room_participants_active_uq
  ON room_participants (room_id, user_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS room_participants_room_idx
  ON room_participants (room_id, left_at);
CREATE INDEX IF NOT EXISTS room_participants_queue_idx
  ON room_participants (room_id) WHERE left_at IS NULL AND hand_raised;

-- ---------------------------------------------------------------------------
-- room_bans — moderator removals that also block re-entry. Distinct from
-- users.status = BANNED (platform-wide): a room ban only closes one door.
-- expires_at NULL = permanent until an admin lifts it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_bans (
  room_id    UUID NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  banned_by  UUID REFERENCES admins (id) ON DELETE SET NULL,
  reason     VARCHAR(200),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS room_bans_user_idx ON room_bans (user_id, expires_at);

-- ---------------------------------------------------------------------------
-- gifts (virtual store catalogue)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gifts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(40) NOT NULL UNIQUE,
  icon_url      TEXT NOT NULL,
  -- Lottie / animated overlay the client plays full-screen. Nullable: clients
  -- fall back to a particle burst on icon_url when absent.
  animation_url TEXT,
  sound_url     TEXT,
  diamond_price INT NOT NULL CHECK (diamond_price > 0),
  r_coin_value  INT NOT NULL CHECK (r_coin_value >= 0),
  category      VARCHAR(24) NOT NULL DEFAULT 'SPECIAL',   -- ROSE | SPECIAL | LUXURY | EVENT
  min_vip_level INT NOT NULL DEFAULT 0,
  sort_order    INT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gifts_active_idx ON gifts (is_active, sort_order);

-- How loud a gift is on screen, decided by the operator rather than by the client:
--   TICKER      -> one row in the scrolling gift column next to the seats
--   FULLSCREEN  -> takes over the whole room for its duration
-- Borrowed from the way TUILiveKit routes a gift by whether it has an animation
-- resource at all, but made explicit: a rose should not blind the whole room, a
-- castle should. `animation_url` alone cannot express that, because every gift in
-- the catalogue now has one.
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS effect_kind VARCHAR(12) NOT NULL DEFAULT 'TICKER'
  CHECK (effect_kind IN ('TICKER', 'FULLSCREEN'));

-- ---------------------------------------------------------------------------
-- transactions — the ledger. Append-only: balances are derived from the wallet
-- service, and every write here carries a post-image for audit/reconciliation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type              transaction_type   NOT NULL,
  status            transaction_status NOT NULL DEFAULT 'COMPLETED',
  sender_id         UUID REFERENCES users (id) ON DELETE SET NULL,
  receiver_id       UUID REFERENCES users (id) ON DELETE SET NULL,
  gift_id           UUID REFERENCES gifts (id) ON DELETE SET NULL,
  quantity          INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  amount_diamonds   INT NOT NULL DEFAULT 0 CHECK (amount_diamonds >= 0),
  amount_r_coins    INT NOT NULL DEFAULT 0 CHECK (amount_r_coins   >= 0),
  -- balance snapshots taken inside the same DB transaction as the mutation
  sender_diamonds_after   INT,
  receiver_r_coins_after  INT,
  room_id           UUID REFERENCES rooms (id) ON DELETE SET NULL,
  agency_id         UUID REFERENCES agencies (id) ON DELETE SET NULL,
  note              VARCHAR(200),
  meta              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_id IS NULL OR sender_id <> receiver_id)
);

CREATE INDEX IF NOT EXISTS tx_created_idx      ON transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS tx_sender_idx       ON transactions (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tx_receiver_idx     ON transactions (receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tx_type_idx         ON transactions (type, created_at DESC);
CREATE INDEX IF NOT EXISTS tx_room_idx         ON transactions (room_id);
CREATE INDEX IF NOT EXISTS tx_meta_gin_idx     ON transactions USING GIN (meta);

-- ---------------------------------------------------------------------------
-- agency_hosts — which hosts belong to which agency, at which split.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agency_hosts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     UUID NOT NULL REFERENCES agencies (id) ON DELETE CASCADE,
  host_user_id  UUID NOT NULL REFERENCES users (id)   ON DELETE CASCADE,
  commission_bps INT NOT NULL DEFAULT 1000,
  checked_in_days INT NOT NULL DEFAULT 0,        -- streak, drives bonus payout
  status        agency_status NOT NULL DEFAULT 'ACTIVE',
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agency_id, host_user_id)
);

CREATE INDEX IF NOT EXISTS agency_hosts_host_idx ON agency_hosts (host_user_id);

ALTER TABLE agencies
  ADD COLUMN IF NOT EXISTS owner_user_id UUID;

CREATE INDEX IF NOT EXISTS agencies_owner_idx ON agencies (owner_user_id);

ALTER TABLE agencies
  DROP CONSTRAINT IF EXISTS agencies_owner_user_id_fkey;
ALTER TABLE agencies
  ADD CONSTRAINT agencies_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- chat_messages — persisted in-room feed (real-time fan-out is Socket.IO/Redis).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      UUID NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users (id) ON DELETE SET NULL,
  message_type chat_message_type NOT NULL DEFAULT 'TEXT',
  content      VARCHAR(500) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_room_idx ON chat_messages (room_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- withdrawal_requests — R-coin cash-out pipeline for hosts/agencies.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount_r_coins  INT NOT NULL CHECK (amount_r_coins > 0),
  status          withdrawal_status NOT NULL DEFAULT 'PENDING',
  payout_method   VARCHAR(24)  NOT NULL DEFAULT 'BANK',
  payout_details  JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by     UUID REFERENCES admins (id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS withdrawal_status_idx ON withdrawal_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS withdrawal_user_idx   ON withdrawal_requests (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Payment proofs — the idempotency key for "money arrived".
--
-- Stripe retries a webhook it does not get a 2xx for, and it also sends the same
-- event more than once under load. Crediting diamonds per delivery would print
-- money, so the external id is recorded first and the credit hangs off it:
-- a second insert hits the UNIQUE and the ledger skips.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_proofs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     VARCHAR(24) NOT NULL,
  external_id  VARCHAR(120) NOT NULL,
  user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  diamonds     INT NOT NULL CHECK (diamonds > 0),
  amount_cents INT NOT NULL CHECK (amount_cents >= 0),
  currency     VARCHAR(3) NOT NULL DEFAULT 'usd',
  transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

CREATE INDEX IF NOT EXISTS payment_proof_user_idx ON payment_proofs (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'rooms', 'gifts', 'agencies'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %1$s_updated_at ON %1$I;
       CREATE TRIGGER %1$s_updated_at BEFORE UPDATE ON %1$I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Catalogue seed — idempotent. Prices in diamonds, host earnings in R-coins.
-- 1 diamond is purchased for money; 1 R-coin is host-side value, withdrawable.
-- min_vip_level is the spend tier the ledger enforces, sound_url plays over the
-- animation on the receiver's device.
-- sort_order ascends with diamond_price, because the gift panel paginates
-- cheapest-first; scripts/e2e-live.cjs asserts the ladder, so a new row has to be
-- inserted at the price-matching position rather than appended at the end.
-- ---------------------------------------------------------------------------
INSERT INTO gifts (name, icon_url, animation_url, sound_url, diamond_price, r_coin_value, category, min_vip_level, sort_order, effect_kind)
VALUES
  ('Rose',        '/gifts/rose.png',     '/gifts/rose.json',      '/gifts/sounds/chime.wav',   1,     1, 'ROSE',     0,  10, 'TICKER'),
  ('True Heart',  '/gifts/heart.png',    '/gifts/heart.json',     '/gifts/sounds/chime.wav',   2,     2, 'SPECIAL',  0,  15, 'TICKER'),
  ('Ice Cream',   '/gifts/icecream.png', '/gifts/icecream.json',  '/gifts/sounds/chime.wav',   5,     5, 'SPECIAL',  0,  20, 'TICKER'),
  ('Lucky Star',  '/gifts/star.png',     '/gifts/star.json',      '/gifts/sounds/chime.wav',   10,    9, 'SPECIAL',  0,  24, 'TICKER'),
  ('Balloon',     '/gifts/balloon.png',  '/gifts/balloon.json',   '/gifts/sounds/chime.wav',   15,    14, 'SPECIAL', 0,  27, 'TICKER'),
  ('Perfume',     '/gifts/perfume.png',  '/gifts/perfume.json',   '/gifts/sounds/chime.wav',   20,    18, 'SPECIAL', 0,  30, 'TICKER'),
  ('Lollipop',    '/gifts/lollipop.png', '/gifts/lollipop.json',  '/gifts/sounds/chime.wav',   35,    32, 'SPECIAL', 0,  35, 'TICKER'),
  ('Teddy',       '/gifts/teddy.png',    '/gifts/teddy.json',     '/gifts/sounds/chime.wav',   50,    45, 'SPECIAL', 0,  40, 'TICKER'),
  ('Ring',        '/gifts/ring.png',     '/gifts/ring.json',      '/gifts/sounds/chime.wav',   100,   90, 'SPECIAL', 1,  50, 'TICKER'),
  ('Happy Cake',  '/gifts/cake.png',     '/gifts/cake.json',      '/gifts/sounds/chime.wav',   150,   135, 'EVENT',  2,  55, 'TICKER'),
  ('Rocket',      '/gifts/rocket.png',   '/gifts/rocket.json',    '/gifts/sounds/whoosh.wav',  500,   450, 'LUXURY', 3,  60, 'FULLSCREEN'),
  ('Sports Car',  '/gifts/car.png',      '/gifts/car.json',       '/gifts/sounds/whoosh.wav',  1000,  900, 'LUXURY', 5,  70, 'FULLSCREEN'),
  ('Fireworks',   '/gifts/fireworks.png','/gifts/fireworks.json', '/gifts/sounds/fanfare.wav', 2500,  2250, 'LUXURY', 6,  75, 'FULLSCREEN'),
  ('Castle',      '/gifts/castle.png',   '/gifts/castle.json',    '/gifts/sounds/fanfare.wav', 5000,  4500, 'LUXURY', 8,  80, 'FULLSCREEN'),
  ('King Crown',  '/gifts/crown.png',    '/gifts/crown.json',     '/gifts/sounds/fanfare.wav', 10000, 9000, 'EVENT',  12, 90, 'FULLSCREEN'),
  ('Private Jet', '/gifts/jet.png',      '/gifts/jet.json',       '/gifts/sounds/whoosh.wav',  20000, 18000, 'EVENT',  15, 100, 'FULLSCREEN')
ON CONFLICT DO NOTHING;

-- The seed above never overwrites, so databases created before Rose got an
-- animation keep the NULL; backfill it rather than asking operators to reseed.
UPDATE gifts SET animation_url = '/gifts/rose.json' WHERE name = 'Rose' AND animation_url IS NULL;

-- Same reason for the tier and the sound: an existing catalogue row would
-- otherwise never gain them. Re-applied on every boot, so it stays cheap.
UPDATE gifts SET min_vip_level = v.level, sound_url = v.sound, effect_kind = v.effect
  FROM (VALUES
    ('True Heart',  0,  '/gifts/sounds/chime.wav'::text,  'TICKER'::text),
    ('Rose',        0,  '/gifts/sounds/chime.wav',        'TICKER'),
    ('Lucky Star',  0,  '/gifts/sounds/chime.wav',        'TICKER'),
    ('Ice Cream',   0,  '/gifts/sounds/chime.wav',        'TICKER'),
    ('Balloon',     0,  '/gifts/sounds/chime.wav',        'TICKER'),
    ('Perfume',     0,  '/gifts/sounds/chime.wav',        'TICKER'),
    ('Lollipop',    0,  '/gifts/sounds/chime.wav',        'TICKER'),
    ('Teddy',       0,  '/gifts/sounds/chime.wav',        'TICKER'),
    ('Ring',        1,  '/gifts/sounds/chime.wav',        'TICKER'),
    ('Happy Cake',  2,  '/gifts/sounds/chime.wav',        'TICKER'),
    ('Rocket',      3,  '/gifts/sounds/whoosh.wav',       'FULLSCREEN'),
    ('Sports Car',  5,  '/gifts/sounds/whoosh.wav',       'FULLSCREEN'),
    ('Fireworks',   6,  '/gifts/sounds/fanfare.wav',      'FULLSCREEN'),
    ('Castle',      8,  '/gifts/sounds/fanfare.wav',      'FULLSCREEN'),
    ('King Crown',  12, '/gifts/sounds/fanfare.wav',      'FULLSCREEN'),
    ('Private Jet', 15, '/gifts/sounds/whoosh.wav',       'FULLSCREEN')
  ) AS v(name, level, sound, effect)
 WHERE gifts.name = v.name
   -- Only write when something actually differs, so a boot does not bump
   -- updated_at on the whole catalogue.
   AND (gifts.min_vip_level IS DISTINCT FROM v.level
        OR gifts.sound_url IS DISTINCT FROM v.sound
        OR gifts.effect_kind IS DISTINCT FROM v.effect);
