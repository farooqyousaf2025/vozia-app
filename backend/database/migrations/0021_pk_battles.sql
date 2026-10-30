-- 0021 — PK battles: two rooms, one clock, a gift race decided by the ledger.
--
-- A PK is the live-room version of a scoreboard: room A and room B agree on a window, and for
-- those minutes every gift sent inside a room counts towards that room's total. The room with
-- more diamonds spent wins.
--
-- Three rules shape the schema:
--
--   * **The score is not a column that anybody writes.** It is the sum of `GIFT_SENT` rows in that
--     room between `started_at` and `ends_at`, read back from `transactions` — the same ledger that
--     already moved the money. There is no endpoint, socket event or admin form that can add a
--     point. `score_a`/`score_b` exist only as the frozen result written once at settlement, so a
--     report does not have to re-sum a window that could later be reversed.
--   * **A room fights one battle at a time.** Two partial unique indexes make a second live row for
--     the same room impossible even if two invitations race; the service also locks both rooms
--     before inserting, which turns that race into an ordinary "this room is busy" answer.
--   * **A battle is between two hosts.** The invitation is accepted by the other room's host, so a
--     member cannot drag somebody else's room into a race, and the operator can stop a battle but
--     cannot start one on a host's behalf.

-- ---------------------------------------------------------------------------
-- The dials
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pk_settings (
  singleton               BOOLEAN  PRIMARY KEY DEFAULT true CHECK (singleton),
  -- Turning this off refuses new invitations. A battle already running still finishes: ending it
  -- would leave its supporters' gifts suddenly worth nothing.
  is_enabled              BOOLEAN  NOT NULL DEFAULT true,
  -- How long a challenge sits unanswered before it expires, so a host who closed the app does not
  -- leave the other room waiting.
  invite_timeout_seconds  INTEGER  NOT NULL DEFAULT 60   CHECK (invite_timeout_seconds BETWEEN 10 AND 900),
  -- The duration the invitation form starts on, and the range an inviter may choose within. The
  -- order check below is what keeps a phone from being offered a window the server would refuse.
  min_duration_seconds    INTEGER  NOT NULL DEFAULT 60   CHECK (min_duration_seconds BETWEEN 10 AND 3600),
  default_duration_seconds INTEGER NOT NULL DEFAULT 300  CHECK (default_duration_seconds BETWEEN 10 AND 3600),
  max_duration_seconds    INTEGER  NOT NULL DEFAULT 900  CHECK (max_duration_seconds BETWEEN 10 AND 7200),
  -- XP for the member who spent the most diamonds in the winning room. Zero turns the prize off
  -- while leaving the battle itself intact.
  winner_bonus_xp         INTEGER  NOT NULL DEFAULT 50   CHECK (winner_bonus_xp BETWEEN 0 AND 100000),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_settings_duration_order
    CHECK (min_duration_seconds <= default_duration_seconds AND default_duration_seconds <= max_duration_seconds)
);

INSERT INTO pk_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS pk_settings_updated_at ON pk_settings;
  CREATE TRIGGER pk_settings_updated_at BEFORE UPDATE ON pk_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE pk_settings IS 'Single row of platform-wide PK dials. The panel edits it under PUT /api/admin/pk/settings.';
COMMENT ON COLUMN pk_settings.is_enabled IS 'false refuses new challenges; a battle already running still settles normally.';
COMMENT ON COLUMN pk_settings.winner_bonus_xp IS 'XP paid to the top diamond spender of the winning room. 0 disables the prize, not the battle.';

-- ---------------------------------------------------------------------------
-- The battles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pk_battles (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_a_id          UUID        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  room_b_id          UUID        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  -- The host who sent the challenge (room A's host). Kept so the record survives a room changing
  -- hands later; it is not consulted for permission once the battle exists.
  invited_by         UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  duration_seconds   INTEGER     NOT NULL CHECK (duration_seconds BETWEEN 10 AND 7200),
  status             TEXT        NOT NULL DEFAULT 'INVITED'
                     CHECK (status IN ('INVITED', 'ACTIVE', 'FINISHED', 'DECLINED', 'CANCELLED', 'EXPIRED')),
  invited_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  invite_expires_at  TIMESTAMPTZ NOT NULL,
  started_at         TIMESTAMPTZ,
  ends_at            TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  -- Frozen copies of the two totals, written once by the settlement and never edited. NULL until
  -- then: a live battle's score is summed from the ledger on every read instead.
  score_a            BIGINT,
  score_b            BIGINT,
  winner_room_id     UUID        REFERENCES rooms (id) ON DELETE SET NULL,
  bonus_user_id      UUID        REFERENCES users (id) ON DELETE SET NULL,
  bonus_xp_awarded   INTEGER     NOT NULL DEFAULT 0 CHECK (bonus_xp_awarded >= 0),
  -- Who ended it early, when an operator stopped one. NULL for a battle that ran its clock out.
  stopped_by         UUID        REFERENCES admins (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_battles_distinct_rooms CHECK (room_a_id <> room_b_id),
  -- An ACTIVE battle must have a window; anything else may not pretend to.
  CONSTRAINT pk_battles_active_window
    CHECK (status <> 'ACTIVE' OR (started_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > started_at)),
  -- A FINISHED battle always has a finish time and both frozen totals, even when nobody scored
  -- and the winner is NULL (a 0–0 draw).
  CONSTRAINT pk_battles_finished_shape
    CHECK (status <> 'FINISHED' OR (finished_at IS NOT NULL AND score_a IS NOT NULL AND score_b IS NOT NULL)),
  -- A cancelled or declined invitation never ran, so it cannot have paid anybody.
  CONSTRAINT pk_battles_unplayed_no_prize
    CHECK (status IN ('ACTIVE', 'FINISHED') OR (bonus_xp_awarded = 0 AND bonus_user_id IS NULL))
);

-- One live battle (invited or running) per room. Two indexes because a room can be either side;
-- together they make "the same room fights twice at once" unrepresentable.
CREATE UNIQUE INDEX IF NOT EXISTS pk_battles_live_room_a_idx
  ON pk_battles (room_a_id) WHERE status IN ('INVITED', 'ACTIVE');
CREATE UNIQUE INDEX IF NOT EXISTS pk_battles_live_room_b_idx
  ON pk_battles (room_b_id) WHERE status IN ('INVITED', 'ACTIVE');

-- The settlement sweep and the room screen's "current battle" read.
CREATE INDEX IF NOT EXISTS pk_battles_due_idx ON pk_battles (ends_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS pk_battles_invite_due_idx ON pk_battles (invite_expires_at) WHERE status = 'INVITED';
CREATE INDEX IF NOT EXISTS pk_battles_room_pair_idx ON pk_battles (room_a_id, room_b_id, created_at DESC);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS pk_battles_updated_at ON pk_battles;
  CREATE TRIGGER pk_battles_updated_at BEFORE UPDATE ON pk_battles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE pk_battles IS 'An invitation, a timed gift race between two rooms, and its frozen result. Scores live in the ledger until settlement writes them here.';
COMMENT ON COLUMN pk_battles.score_a IS 'Diamonds spent inside room A between started_at and ends_at, summed from GIFT_SENT rows once at settlement. NULL while the battle is still running.';
COMMENT ON COLUMN pk_battles.winner_room_id IS 'The room with the higher total. NULL for a draw — a draw pays no prize and is still a finished battle.';
COMMENT ON COLUMN pk_battles.bonus_user_id IS 'Top diamond spender inside the winning room, paid winner_bonus_xp once at settlement.';
COMMENT ON COLUMN pk_battles.stopped_by IS 'Set when an operator ended the battle early; NULL when the clock decided it.';
