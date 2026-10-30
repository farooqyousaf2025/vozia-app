-- 0020 — Every day gets a small ladder of its own: quests, and a check-in streak.
--
-- 0017 gave a member one number to climb for as long as their account lives. That is a *career*:
-- it answers "how much have I done here". It does not answer the question a party app lives on —
-- "why open this one today". This migration adds the second, smaller loop the brief's §5 activity
-- list implies: a handful of tasks that reset every midnight, and a check-in that pays a little more
-- the longer you keep coming back.
--
-- Three things are deliberately true here:
--
--   * **XP remains server-authored.** Quests never accept an experience value from a client. A quest
--     is a row describing *what counts* (send a gift, spend diamonds, say something in a room); the
--     only writer of `users.xp` is still `rank.service.awardXp`, called from inside the same
--     transaction that recorded the qualifying action.
--   * **A day is a date in the operator's timezone, not the device's.** `quest_settings.reset_timezone`
--     is one setting for the whole platform, resolved by PostgreSQL itself. A phone with a wrong
--     clock cannot start tomorrow early.
--   * **Nothing here can be edited by a member.** Progress rows and check-in rows have no route that
--     accepts a value; the panel's only writes are the catalogue and the reward dials.

-- ---------------------------------------------------------------------------
-- The dials
-- ---------------------------------------------------------------------------
--
-- One row, enforced by the primary key. A settings table that can hold two rows eventually does, and
-- then "which timezone resets the day" has two answers. The CHECK on `singleton` makes the second
-- insert fail instead of quietly winning.

CREATE TABLE IF NOT EXISTS quest_settings (
  singleton              BOOLEAN  PRIMARY KEY DEFAULT true CHECK (singleton),
  -- An IANA name ('Asia/Kolkata', 'UTC'). The service refuses an unknown one by asking
  -- `pg_timezone_names`, because a CHECK constraint cannot run that subquery and a bad name would
  -- otherwise turn every `GET /api/quests` into a 500.
  reset_timezone         TEXT     NOT NULL DEFAULT 'UTC' CHECK (reset_timezone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  -- Check-in reward: base XP on day one, plus a step for each consecutive day, capped at
  -- `checkin_max_streak_days`. The ceiling is what stops a year-long streak from paying a salary.
  checkin_base_xp        INTEGER  NOT NULL DEFAULT 10 CHECK (checkin_base_xp BETWEEN 0 AND 10000),
  checkin_streak_step_xp INTEGER  NOT NULL DEFAULT 5  CHECK (checkin_streak_step_xp BETWEEN 0 AND 10000),
  checkin_max_streak_days SMALLINT NOT NULL DEFAULT 7 CHECK (checkin_max_streak_days BETWEEN 1 AND 365),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO quest_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS quest_settings_updated_at ON quest_settings;
  CREATE TRIGGER quest_settings_updated_at BEFORE UPDATE ON quest_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE quest_settings IS 'Single row of platform-wide daily-activity dials. The panel edits it under PATCH /api/admin/quests/settings.';
COMMENT ON COLUMN quest_settings.reset_timezone IS 'IANA zone that decides when "today" starts and when quests/check-ins reset. Validated against pg_timezone_names by quest.service.';
COMMENT ON COLUMN quest_settings.checkin_base_xp IS 'XP for a check-in on streak day 1. Day N pays base + (min(N, max) - 1) * step.';
COMMENT ON COLUMN quest_settings.checkin_max_streak_days IS 'Last streak day that still increases the reward; a longer streak keeps paying the cap.';

-- ---------------------------------------------------------------------------
-- The catalogue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS daily_quests (
  key         VARCHAR(40) PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  title       VARCHAR(80) NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  -- What a qualifying server-side event increments. A closed list rather than a script or a DSL:
  -- each value is a hook that already exists in this backend (gift ledger, room chat), so a new
  -- quest type is a migration plus a hook, never an operator typing code into a form.
  metric      TEXT        NOT NULL CHECK (metric IN ('GIFT_SENT', 'DIAMONDS_SPENT', 'CHAT_MESSAGE')),
  -- How much of `metric` completes the quest. Bounded so a typo cannot make a quest that is
  -- technically reachable and practically not, or one that pays for a single tap.
  target      INTEGER     NOT NULL CHECK (target BETWEEN 1 AND 1000000),
  xp_reward   INTEGER     NOT NULL CHECK (xp_reward BETWEEN 1 AND 100000),
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS daily_quests_active_idx ON daily_quests (is_active, sort_order);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS daily_quests_updated_at ON daily_quests;
  CREATE TRIGGER daily_quests_updated_at BEFORE UPDATE ON daily_quests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE daily_quests IS 'Admin-managed daily task catalogue. Progress resets every day at quest_settings.reset_timezone; the rows themselves persist.';
COMMENT ON COLUMN daily_quests.metric IS 'Which server-side counter this quest listens to. Gift metrics are recorded inside the gift ledger transaction; CHAT_MESSAGE after a chat row is stored.';
COMMENT ON COLUMN daily_quests.is_active IS 'false retires a quest: it disappears from GET /api/quests and stops recording progress, but yesterday''s completed rows and the XP they paid stay.';

-- ---------------------------------------------------------------------------
-- Progress
-- ---------------------------------------------------------------------------
--
-- The primary key is the whole rule: one row per member, per day, per quest. `LEAST(target, ...)`
-- on the increment means a member cannot bank progress past the goal, and `completed_at` is set
-- exactly once by a conditional UPDATE, which is what makes the XP award idempotent even if two
-- qualifying events land in the same transaction.

CREATE TABLE IF NOT EXISTS quest_progress (
  user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  quest_date   DATE        NOT NULL,
  quest_key    VARCHAR(40) NOT NULL REFERENCES daily_quests (key) ON DELETE CASCADE,
  progress     INTEGER     NOT NULL DEFAULT 0 CHECK (progress >= 0),
  completed_at TIMESTAMPTZ,
  xp_awarded   INTEGER     NOT NULL DEFAULT 0 CHECK (xp_awarded >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, quest_date, quest_key)
);

-- The screen read: every quest for one member on one date.
CREATE INDEX IF NOT EXISTS quest_progress_user_date_idx ON quest_progress (user_id, quest_date);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS quest_progress_updated_at ON quest_progress;
  CREATE TRIGGER quest_progress_updated_at BEFORE UPDATE ON quest_progress
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE quest_progress IS 'How far one member got on one quest on one local date. Rows are kept as history; a new day simply has no rows yet.';
COMMENT ON COLUMN quest_progress.completed_at IS 'NULL until the target was reached. The conditional UPDATE that sets it is also the once-only XP award, so replaying an event cannot pay twice.';
COMMENT ON COLUMN quest_progress.quest_key IS 'Cascade on delete: progress is a live counter, not a receipt. The XP it already paid lives in users.xp and is not clawed back when an operator removes a quest.';

-- ---------------------------------------------------------------------------
-- Check-ins
-- ---------------------------------------------------------------------------
--
-- One row per member per local date. The streak is *not* stored as a counter on `users`: it is
-- derived from yesterday's row, which means a missed day cannot leave a stale streak behind, and
-- the history of what was paid on which day is readable by support without reconstructing it.

CREATE TABLE IF NOT EXISTS daily_checkins (
  user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  checkin_date DATE        NOT NULL,
  -- Which day of the streak this check-in was: 1 for the first, yesterday+1 for a consecutive one.
  streak_day   SMALLINT    NOT NULL CHECK (streak_day BETWEEN 1 AND 365),
  xp_awarded   INTEGER     NOT NULL DEFAULT 0 CHECK (xp_awarded >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, checkin_date)
);

CREATE INDEX IF NOT EXISTS daily_checkins_user_date_idx ON daily_checkins (user_id, checkin_date DESC);

COMMENT ON TABLE daily_checkins IS 'One row per member per local date the member checked in. The streak is read back from the previous day, never trusted from a client.';
COMMENT ON COLUMN daily_checkins.streak_day IS 'Consecutive-day count, capped by quest_settings.checkin_max_streak_days for reward purposes; 1 starts again after a missed day.';

-- ---------------------------------------------------------------------------
-- Seeds: three quests an operator can re-tune on screen
-- ---------------------------------------------------------------------------
--
-- Rewards sit well under a gift's own XP (1 XP per diamond spent, so a Rose already pays 1 and a
-- Rocket 500) and under a rank rung: a day of quests is a nudge, not the main ladder. The targets
-- are the smallest numbers that still ask for the feature to be used: one gift, one meaningful
-- spend, three lines of chat.

INSERT INTO daily_quests (key, title, description, metric, target, xp_reward, sort_order) VALUES
  ('gift-1',   'Send a Gift',        'Send any gift to a host in a live room.',              'GIFT_SENT',      1,  20, 10),
  ('spend-50', 'Share the Love',     'Spend 50 diamonds on gifts today.',                    'DIAMONDS_SPENT', 50, 30, 20),
  ('chat-3',   'Join the Party',     'Send three messages in a room chat.',                  'CHAT_MESSAGE',   3,  15, 30)
ON CONFLICT (key) DO NOTHING;
