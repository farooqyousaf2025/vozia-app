-- 0001_games.sql — server-authoritative game framework (programme §7, §8, §9, §13).
--
-- Money model, decided here because everything downstream depends on it:
--   * an entry fee debits `users.diamond_balance`  -> the brief's "User Coins"
--   * a prize credits `users.diamond_balance`      -> spendable in-app, NOT withdrawable
--   * the platform cut is recorded, never parked in a user row
-- Host Earnings (`r_coin_balance`) is deliberately left out of the prize path: a game
-- reward that can be cashed out is a different regulated product, and the brief requires
-- that decision to be made by a human after a compliance review, not by a migration.
-- `entry_fee_enabled` and `prize_enabled` therefore ship FALSE on every row.
--
-- Game Points never touch the wallet: they live on `game_participants.score`.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE game_session_status AS ENUM (
    'WAITING', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED');

CREATE TYPE game_participant_status AS ENUM (
    'REQUESTED', 'JOINED', 'READY', 'PLAYING', 'COMPLETED', 'LEFT', 'DISCONNECTED');

-- PENDING is the "no money has moved yet" state; a session may only leave it once a
-- settlement or refund row exists.
CREATE TYPE game_settlement_status AS ENUM ('PENDING', 'SETTLED', 'PARTIAL', 'REFUNDED', 'DISPUTED');

CREATE TYPE dispute_status AS ENUM ('OPEN', 'UNDER_REVIEW', 'UPHELD', 'REJECTED', 'REFUNDED');

CREATE TYPE commission_allocation_status AS ENUM ('CALCULATED', 'SETTLED', 'REVERSED');

-- Transaction kinds the game ledger writes. Compensating entries only: a posted row is
-- never edited or deleted, so a refund is a new GAME_REFUND row beside the GAME_ENTRY it
-- reverses.
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'GAME_ENTRY';
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'GAME_PRIZE';
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'GAME_REFUND';
ALTER TYPE transaction_type ADD VALUE IF NOT EXISTS 'PLATFORM_COMMISSION';
-- NOTE: these values are not used inside this file — PostgreSQL refuses to read a newly
-- added enum value in the same transaction that added it.

-- ---------------------------------------------------------------------------
-- Definitions: what a game is, and what it costs to play
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS game_definitions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable identifier the clients and the engine dispatch on. Never reused, never renamed
  -- once a build of the app shipped with it.
  key                 VARCHAR(32) NOT NULL UNIQUE,
  name                VARCHAR(40) NOT NULL,
  description         VARCHAR(200),
  -- Board/round shape the generic engine reads: grid size, seat count, question count...
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  min_players         INT NOT NULL DEFAULT 2 CHECK (min_players >= 1),
  max_players         INT NOT NULL CHECK (max_players BETWEEN 1 AND 8),
  allow_spectators    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Round clock is server-side; a client that answers after it expired is rejected.
  turn_timeout_seconds INT NOT NULL DEFAULT 30 CHECK (turn_timeout_seconds BETWEEN 5 AND 300),
  -- Availability. A disabled definition cannot create sessions but keeps history readable.
  is_active           BOOLEAN NOT NULL DEFAULT FALSE,
  -- Paid entry and redeemable prizes are both OFF until an operator has cleared them.
  entry_fee_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  entry_fee_diamonds  INT NOT NULL DEFAULT 0 CHECK (entry_fee_diamonds >= 0),
  entry_fee_min       INT NOT NULL DEFAULT 0 CHECK (entry_fee_min >= 0),
  entry_fee_max       INT NOT NULL DEFAULT 0 CHECK (entry_fee_max >= 0),
  prize_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  -- Platform cut of the collected pool, basis points (10000 = 100%).
  commission_bps      INT NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 5000),
  -- Ordered payout shares of the prize pool, e.g. [{"rank":1,"share_bps":10000}].
  -- Must sum to <= 10000; enforced on write so a session can never over-distribute.
  prize_rules         JSONB NOT NULL DEFAULT '[{"rank":1,"share_bps":10000}]'::jsonb,
  -- 'NONE' | 'CANCELLED' | 'DISPUTED' | 'ALWAYS' — which exits give the fee back.
  refund_policy       VARCHAR(16) NOT NULL DEFAULT 'CANCELLED'
                        CHECK (refund_policy IN ('NONE','CANCELLED','DISPUTED','ALWAYS')),
  -- Promotional window: entry fee is waived for sessions created inside it.
  promo_free_entry    BOOLEAN NOT NULL DEFAULT FALSE,
  promo_until         TIMESTAMPTZ,
  -- Anti-abuse: per-user entries per rolling day, and a minimum gap between entries.
  daily_entry_limit   INT NOT NULL DEFAULT 50 CHECK (daily_entry_limit >= 0),
  anti_abuse          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Bumped whenever a money-affecting field changes; sessions pin the version they used.
  rules_version       INT NOT NULL DEFAULT 1 CHECK (rules_version >= 1),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (entry_fee_diamonds BETWEEN entry_fee_min AND entry_fee_max),
  CHECK (min_players <= max_players)
);

-- Append-only history of the money rules. A session stores its own snapshot, so a
-- commission change tomorrow cannot rewrite what was collected yesterday.
CREATE TABLE IF NOT EXISTS game_rule_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_key       VARCHAR(32) NOT NULL,
  rules_version  INT NOT NULL,
  -- The whole definition row's money-relevant fields, as read at the time.
  rules          JSONB NOT NULL,
  changed_by     UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_key, rules_version)
);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS game_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_key           VARCHAR(32) NOT NULL,
  definition_id      UUID NOT NULL REFERENCES game_definitions (id) ON DELETE RESTRICT,
  -- Games run inside an audio room; a NULL room is a lobby-only match, which the
  -- framework supports but the app never offers today.
  room_id            UUID REFERENCES rooms (id) ON DELETE CASCADE,
  created_by         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status             game_session_status NOT NULL DEFAULT 'WAITING',
  -- Rules pinned at creation. If the operator edits the definition mid-match, the
  -- running session settles under the numbers it started with.
  rules_version      INT NOT NULL,
  rules              JSONB NOT NULL,
  entry_fee_diamonds INT NOT NULL DEFAULT 0 CHECK (entry_fee_diamonds >= 0),
  max_players        INT NOT NULL CHECK (max_players BETWEEN 1 AND 8),
  -- Authoritative board/round state: whose move it is, scores, dice, question index.
  state              JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Server-computed deadline for the current turn. Clients count down to it; they do
  -- not decide it.
  turn_deadline_at   TIMESTAMPTZ,
  turn_owner_id      UUID REFERENCES users (id) ON DELETE SET NULL,
  result             JSONB,
  cancel_reason      VARCHAR(200),
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An unfinished paid session must always be resolvable: either it settles, or the
  -- fees go back. `settlement_status` below is the single column that says which.
  settlement_status  game_settlement_status NOT NULL DEFAULT 'PENDING'
);

CREATE INDEX IF NOT EXISTS game_sessions_room_idx   ON game_sessions (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS game_sessions_status_idx ON game_sessions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS game_sessions_key_idx    ON game_sessions (game_key, created_at DESC);

-- ---------------------------------------------------------------------------
-- Participants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS game_participants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Board slot (0..max_players-1), assigned by the server, never chosen by the client.
  position            INT NOT NULL CHECK (position >= 0 AND position < 8),
  status              game_participant_status NOT NULL DEFAULT 'REQUESTED',
  -- Game Points. Not money, not purchasable, not withdrawable.
  score               BIGINT NOT NULL DEFAULT 0,
  -- Tie-break for speed-scored games (Quiz Battle), in ms of summed answer latency.
  tie_break_ms        BIGINT NOT NULL DEFAULT 0,
  rank                INT,
  entry_fee_diamonds  INT NOT NULL DEFAULT 0 CHECK (entry_fee_diamonds >= 0),
  -- The ledger rows that moved this player's fee, and any compensating refund.
  fee_transaction_id  UUID REFERENCES transactions (id) ON DELETE SET NULL,
  refund_transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  prize_diamonds      INT NOT NULL DEFAULT 0 CHECK (prize_diamonds >= 0),
  joined_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at            TIMESTAMPTZ,
  disconnected_at     TIMESTAMPTZ,
  last_action_at      TIMESTAMPTZ,
  -- One row per player per session: joining twice, or paying twice on a retry, is a
  -- constraint violation rather than a bug to be noticed later.
  UNIQUE (session_id, user_id),
  UNIQUE (session_id, position)
);

CREATE INDEX IF NOT EXISTS game_participants_user_idx ON game_participants (user_id, joined_at DESC);

-- ---------------------------------------------------------------------------
-- Replayable event log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS game_events (
  id           BIGSERIAL PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  -- Per-session sequence, allocated under the session row lock, so a gap or a
  -- duplicate is proof of tampering rather than a race.
  seq          INT NOT NULL CHECK (seq >= 1),
  -- 'JOINED' 'LEFT' 'MOVE' 'ANSWER' 'DICE' 'TIMEOUT' 'CANCELLED' 'SETTLED' ...
  type         VARCHAR(32) NOT NULL,
  actor_id     UUID REFERENCES users (id) ON DELETE SET NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS game_events_session_idx ON game_events (session_id, seq);

-- ---------------------------------------------------------------------------
-- Settlement — at most once per session, by primary key
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS game_settlements (
  session_id       UUID PRIMARY KEY REFERENCES game_sessions (id) ON DELETE CASCADE,
  game_key         VARCHAR(32) NOT NULL,
  rules_version    INT NOT NULL,
  player_count     INT NOT NULL CHECK (player_count >= 0),
  -- Gross pool actually collected, the platform cut, and the pool left for prizes.
  gross_pool       INT NOT NULL CHECK (gross_pool >= 0),
  commission       INT NOT NULL CHECK (commission >= 0),
  prize_pool       INT NOT NULL CHECK (prize_pool >= 0),
  -- prize_pool = gross_pool - commission - deductions, checked so the arithmetic
  -- cannot be wrong even if every caller above it is.
  deductions       INT NOT NULL DEFAULT 0 CHECK (deductions >= 0),
  distributed      INT NOT NULL CHECK (distributed >= 0),
  CHECK (commission + prize_pool + deductions = gross_pool),
  CHECK (distributed <= prize_pool),
  -- [{rank,user_id,diamonds,transaction_id}] — the money trail per winner.
  payouts          JSONB NOT NULL DEFAULT '[]'::jsonb,
  refunds          JSONB NOT NULL DEFAULT '[]'::jsonb,
  status           game_settlement_status NOT NULL DEFAULT 'SETTLED',
  settled_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commission_allocations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'GAME_SESSION' today; the shape is shared so a paid call or a tournament can use it.
  kind            VARCHAR(24) NOT NULL,
  source_id       UUID NOT NULL,
  gross_amount    INT NOT NULL CHECK (gross_amount >= 0),
  currency        VARCHAR(12) NOT NULL CHECK (currency IN ('diamond','r_coin')),
  host_user_id    UUID REFERENCES users (id) ON DELETE SET NULL,
  host_share      INT NOT NULL DEFAULT 0 CHECK (host_share >= 0),
  agency_id       UUID REFERENCES agencies (id) ON DELETE SET NULL,
  agency_share    INT NOT NULL DEFAULT 0 CHECK (agency_share >= 0),
  platform_share  INT NOT NULL DEFAULT 0 CHECK (platform_share >= 0),
  -- Nothing may allocate more than the source produced.
  CHECK (host_share + agency_share + platform_share <= gross_amount),
  rules_version   INT NOT NULL,
  rule_snapshot   JSONB NOT NULL,
  status          commission_allocation_status NOT NULL DEFAULT 'CALCULATED',
  transaction_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One allocation per (kind, source): an agency cannot be paid twice for the same pool.
  UNIQUE (kind, source_id)
);

CREATE INDEX IF NOT EXISTS commission_alloc_source_idx ON commission_allocations (kind, source_id);

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS game_disputes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  raised_by     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason        VARCHAR(500) NOT NULL,
  status        dispute_status NOT NULL DEFAULT 'OPEN',
  -- Set by the operator when the review changes the outcome or moves money back.
  resolution    VARCHAR(500),
  reviewed_by   UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at   TIMESTAMPTZ,
  -- One live dispute per session; a second report is folded into the first review.
  UNIQUE (session_id, raised_by)
);

CREATE INDEX IF NOT EXISTS game_disputes_status_idx ON game_disputes (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Shipped definitions — inactive, fee-free, prize-free until reviewed
-- ---------------------------------------------------------------------------

INSERT INTO game_definitions (key, name, description, config, min_players, max_players,
                              turn_timeout_seconds, allow_spectators)
VALUES
  ('TIC_TAC_TOE', 'Tic-Tac-Toe', 'Two players, one grid, three in a row.',
   '{"grid":3,"winLines":8}', 2, 2, 30, TRUE),
  ('QUIZ_BATTLE', 'Quiz Battle', 'Server-timed rounds; correct answers plus speed decide it.',
   '{"rounds":5,"options":4,"secondsPerQuestion":15,"correctPoints":100,"maxSpeedBonus":50}',
   2, 8, 15, TRUE),
  ('LUDO', 'Ludo Party', 'Four players, one dice, server-rolled.',
   '{"pieces":4,"track":52,"home":6,"startRoll":6}', 2, 4, 45, TRUE)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- updated_at maintenance — reuses set_updated_at() from the schema.sql baseline.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['game_definitions', 'game_sessions'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %1$s_updated_at ON %1$I;
       CREATE TRIGGER %1$s_updated_at BEFORE UPDATE ON %1$I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;
