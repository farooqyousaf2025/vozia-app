-- 0038 — The earning rules engine: what a member is paid for, in what amount, and how often.
--
-- 0020 gave the platform daily quests and a check-in streak, and both work — but every figure they pay is
-- an XP number on a row that cannot say anything else. There is no way to express "this campaign pays 300
-- bonus diamonds, only to hosts over VIP 3 who are older than a week, twice a day, and only after an
-- operator has looked at the screenshot" without shipping code, because a quest row has no currency, no
-- eligibility, no cap, no window and no approval step. That is the gap §3-§6 of the earning brief describes,
-- and it is a data gap rather than a money gap: the coins themselves were built by 0036/0037 and this file
-- spends them through that module instead of inventing a second mint.
--
-- Four decisions shape the file.
--
-- First, **a rule is a row and a payout is a row, and neither takes an amount from a request.** The phone
-- submits which rule it satisfied and, for a claimable metric, the evidence; `reward_amount`, currency,
-- target and caps are read off the live rule version inside the transaction that pays. This is the same
-- argument `commission_rules` makes about rates: a number a client can send is a number a client can
-- choose.
--
-- Second, **rules are versioned the way `commission_rules` is** — `key` plus `rule_version`, publishing a
-- version closes the previous one's window, and the activity and payout rows carry `rule_id` and
-- `rule_version`. An operator repricing a live campaign therefore cannot change what an in-flight attempt
-- pays or what was already paid: the history says what the rule said that day, which is the only way a
-- support answer and a finance report can ever agree.
--
-- Third, **the reset period is a bucket string on the activity row, not a job.** `DAY`, `WEEK`, `MONTH` or
-- `NEVER` resolve to a `bucket` like `2026-11-08` or `2026-W45` computed in PostgreSQL from
-- `quest_settings.reset_timezone`, so "today" stays the one platform-wide local date the quests already
-- use rather than a second definition of the day somebody could get wrong twice. The row is keyed
-- `(user_id, rule_id, bucket, occurrence)`, so a new period simply has no rows — no midnight sweep has to
-- succeed for the caps to be right — and `occurrence` is what makes "twice a day" a unique constraint
-- instead of a count an attacker races.
--
-- Fourth, **the cap that matters is counted in payouts, and payouts cannot repeat.** `earning_payouts`
-- carries `UNIQUE (activity_id)`: the first writer pays, a retry conflicts. Because a rule's price is
-- fixed on the rule, a count cap *is* a value cap — 2 payouts a day at 300 diamonds is 600 diamonds a day,
-- which is why there is no second, separately-raceable "daily amount" column. Campaigns get the one cap an
-- individual member's count cannot express: `budget_diamonds`, the total the platform will mint for the
-- campaign before it stops paying anyone.
--
-- Bonus coins, not R-coins. `reward_currency` is `XP` or `BONUS_DIAMOND`, and the second one is paid
-- through `grantPromoDiamonds` with `source_id = activity.id`, so every coin this engine mints arrives as
-- a grant with an expiry, a `PROMO_GRANT` journal entry against `COIN_LIABILITY`, and a de-duplication key
-- that already exists. Paying R-coins from a campaign is deliberately absent: an R-coin is withdrawable,
-- so a task that hands them out would let the platform mint a cash payout with no funding account behind
-- it, and that is the exact shape 0034 was written to close. If campaign R-coins are ever needed they come
-- with the account that funds them, not with a column added here.
--
-- No new `fin_accounts` rows for the same reason: 0037 already established `PROMOTIONAL:PLATFORM` as the
-- budget a minted coin is expensed against, and a second budget account is how a panel and a finance
-- report start disagreeing about one marketing spend.

-- ---------------------------------------------------------------------------
-- enums
--
-- Declared before the tables that read them, and nothing here uses `ALTER TYPE ... ADD VALUE`, which a
-- containing transaction cannot apply and a following statement cannot see.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE earning_campaign_status AS ENUM ('DRAFT', 'LIVE', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE earning_reset AS ENUM ('DAY', 'WEEK', 'MONTH', 'NEVER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE earning_activity_status AS ENUM ('OPEN', 'PENDING', 'PAID', 'REFUSED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- earning_campaigns — a window and a budget that rules belong to
--
-- `status` exists beside the time window rather than being replaced by it because a campaign has to be
-- buildable before it is runnable: an operator assembling twelve rules needs a place to put them, and
-- `DRAFT` says "these rows are real but nothing may pay from them" without pretending the dates have
-- arrived. `CLOSED` stops payouts immediately, which a past `ends_at` also does — the difference is that
-- closing is an operator's decision on the clock, and an emergency should not have to wait for a deadline.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS earning_campaigns (
  id             UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The immutable slug a report and a support ticket can both quote. Renaming means a new campaign,
  -- because rows already paid would then point at a title that is not the one they ran under.
  key            TEXT                    NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  title          VARCHAR(80)             NOT NULL CHECK (title ~ '\S'),
  description    VARCHAR(300)            NOT NULL DEFAULT '',
  status         earning_campaign_status NOT NULL DEFAULT 'DRAFT',
  starts_at      TIMESTAMPTZ             NOT NULL DEFAULT now(),
  ends_at        TIMESTAMPTZ,
  -- The whole-campaign ceiling, in bonus diamonds minted, not in payouts. A per-member cap cannot stop a
  -- hundred accounts each taking their two legal payouts, and a marketing brief is always a budget.
  budget_diamonds INT                    CHECK (budget_diamonds IS NULL OR budget_diamonds > 0),
  created_by     UUID                    REFERENCES admins (id) ON DELETE SET NULL,
  note           VARCHAR(300),
  created_at     TIMESTAMPTZ             NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ             NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS earning_campaign_live_idx
  ON earning_campaigns (status, starts_at, ends_at);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS earning_campaigns_updated_at ON earning_campaigns;
  CREATE TRIGGER earning_campaigns_updated_at BEFORE UPDATE ON earning_campaigns
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE earning_campaigns IS
  'A dated, budgeted window that earning rules may belong to. NULL budget means no ceiling, which is a decision an operator makes rather than a default the code takes.';
COMMENT ON COLUMN earning_campaigns.budget_diamonds IS
  'Maximum promotional diamonds this campaign may mint in total, counted from earning_payouts. Enforced at payout time against the live sum, so it holds however many rules the campaign has.';

-- ---------------------------------------------------------------------------
-- earning_rules — what qualifies, what it pays, how often, and who may say so
--
-- Versioned like `commission_rules`: one row per (key, rule_version), publishing a new version stamps
-- `ends_at` on the previous one. `is_active` is the retire switch and is deliberately separate from the
-- window: a rule can be perfectly in-date and still switched off, and an operator who wants the second
-- thing should not have to rewrite the dates to get it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS earning_rules (
  id                 UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  key                TEXT            NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  rule_version       INT             NOT NULL DEFAULT 1 CHECK (rule_version > 0),
  title              VARCHAR(80)     NOT NULL CHECK (title ~ '\S'),
  description        VARCHAR(300)    NOT NULL DEFAULT '',
  campaign_id        UUID            REFERENCES earning_campaigns (id) ON DELETE RESTRICT,

  -- Which observable signal advances this rule. A closed list mirrored by the registry in
  -- earning-rule.service.ts, which also decides whether the metric is counted by a server hook or
  -- submitted by a member: a metric that nobody increments can never pay, and one the member could
  -- increment would be a payout on their own say-so.
  metric             TEXT            NOT NULL CHECK (
    metric IN ('GIFT_SENT', 'DIAMONDS_SPENT', 'CHAT_MESSAGE', 'CHECKIN', 'CHECKIN_STREAK',
               'DAILY_LOGIN', 'ROOM_JOIN', 'GAME_PLAY', 'STORE_PURCHASE', 'SUBMISSION')
  ),
  -- What the award is for, and therefore which `promo_grants.source_kind` a bonus payout lands under.
  -- Kept as its own column because the metric says how it was earned and the purpose says why the
  -- platform chose to pay for it — a report groups on the second.
  purpose            TEXT            NOT NULL CHECK (
    purpose IN ('CHECKIN', 'QUEST', 'CAMPAIGN', 'EVENT', 'ACHIEVEMENT')
  ),

  target             INT             NOT NULL CHECK (target > 0 AND target <= 1000000),
  reward_amount      INT             NOT NULL CHECK (reward_amount > 0 AND reward_amount <= 10000000),
  -- The two currencies this platform can pay honestly. See the header: a third value needs the account
  -- that funds it before the schema admits it.
  reward_currency    TEXT            NOT NULL CHECK (reward_currency IN ('XP', 'BONUS_DIAMOND')),

  -- How the counting period is cut, and how many times one member may be paid inside it. `NEVER` means
  -- the whole lifetime in one bucket, which is what makes a one-off achievement expressible without a
  -- second kind of row.
  reset              earning_reset   NOT NULL DEFAULT 'DAY',
  max_per_period     INT             CHECK (max_per_period IS NULL OR max_per_period > 0),
  max_total          INT             CHECK (max_total IS NULL OR max_total > 0),

  -- Minimum eligibility. Account age is measured against `users.created_at` at payout time, not against
  -- the day the attempt started, so a rule cannot be started on day 6 and finished on day 8 by waiting.
  min_account_age_days INT           NOT NULL DEFAULT 0 CHECK (min_account_age_days >= 0 AND min_account_age_days <= 3650),
  min_vip_level      INT             NOT NULL DEFAULT 0 CHECK (min_vip_level >= 0 AND min_vip_level <= 20),
  -- Empty array means everyone. Non-empty means the account's own `user_type` / `country_code` has to be
  -- on the list, and the containment CHECK below is what stops a typo living on in a rule nobody reads
  -- until a campaign silently pays nobody. Country codes are validated in the service (ISO-2, uppercase):
  -- Postgres has no catalogue of them to contain a CHECK against, and inventing one here would be a list
  -- nobody maintains.
  eligible_user_types TEXT[]         NOT NULL DEFAULT '{}',
  eligible_countries  TEXT[]         NOT NULL DEFAULT '{}',
  CHECK (eligible_user_types <@ ARRAY['HOST', 'USER', 'AGENCY_ADMIN']::text[]),
  CHECK (coalesce(array_length(eligible_countries, 1), 0) <= 200),

  -- Metric-specific conditions (a minimum gift value, one gift category, one store kind). Validated
  -- against the per-metric whitelist in the service — the schema cannot know which keys a metric can
  -- answer, but it can insist the value stays an object a report can read.
  restrictions       JSONB           NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(restrictions) = 'object'),

  -- A claim that an operator must look at before money moves. Only a claimable metric can use it: an
  -- auto-incremented gift count has no evidence to review, and a queue of rows nobody can verify is a
  -- queue that gets approved on habit.
  requires_approval  BOOLEAN         NOT NULL DEFAULT FALSE,

  starts_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
  ends_at            TIMESTAMPTZ,
  is_active          BOOLEAN         NOT NULL DEFAULT TRUE,
  created_by         UUID            REFERENCES admins (id) ON DELETE SET NULL,
  note               VARCHAR(300),
  created_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),
  UNIQUE (key, rule_version),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  -- An approval step only makes sense where a member submits something. Postgres can enforce the pairing
  -- because both halves are columns on this row.
  CHECK (NOT requires_approval OR metric = 'SUBMISSION')
);

-- The version that answers at a moment: the newest live row for a metric whose window covers it.
CREATE INDEX IF NOT EXISTS earning_rule_lookup_idx
  ON earning_rules (metric, is_active, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS earning_rule_campaign_idx
  ON earning_rules (campaign_id) WHERE campaign_id IS NOT NULL;

DO $$
BEGIN
  DROP TRIGGER IF EXISTS earning_rules_updated_at ON earning_rules;
  CREATE TRIGGER earning_rules_updated_at BEFORE UPDATE ON earning_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE earning_rules IS
  'Versioned earning rules: what advances them, what they pay, who may claim them and how often. A payout carries rule_id and rule_version, so repricing never rewrites history.';
COMMENT ON COLUMN earning_rules.metric IS
  'The signal this rule counts. Closed list shared with the registry in earning-rule.service.ts, which decides whether a server hook or the member supplies its events.';
COMMENT ON COLUMN earning_rules.max_per_period IS
  'Payouts per member per reset bucket. NULL means one per bucket by default in code; because reward_amount is fixed, this count is also the value ceiling for that bucket.';

-- ---------------------------------------------------------------------------
-- earning_activities — one attempt by one member at one rule in one bucket
--
-- The row is the counter, the claim, the evidence and the decision, because all four describe the same
-- thing and splitting them would let the cap be answered from one table while the approval sat in another.
-- `target` and the reward are snapshotted when the row is created: a rule repriced at noon does not change
-- what the morning's attempt is worth, and the payout then records what was actually paid.
--
-- `UNIQUE (user_id, rule_id, bucket, occurrence)` is the whole concurrency argument. Two simultaneous
-- claims for the second payout both try to insert the same key; one gets it, the other is told it already
-- stands. A count-then-insert cap would have been a race with a wallet on the other side of it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS earning_activities (
  id            UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID                    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rule_id       UUID                    NOT NULL REFERENCES earning_rules (id) ON DELETE RESTRICT,
  rule_version  INT                     NOT NULL,
  campaign_id   UUID                    REFERENCES earning_campaigns (id) ON DELETE RESTRICT,
  bucket        TEXT                    NOT NULL,
  occurrence    INT                     NOT NULL DEFAULT 1 CHECK (occurrence > 0),

  -- Snapshots of the rule as this attempt found it.
  target        INT                     NOT NULL CHECK (target > 0),
  reward_amount INT                     NOT NULL CHECK (reward_amount > 0),
  reward_currency TEXT                  NOT NULL CHECK (reward_currency IN ('XP', 'BONUS_DIAMOND')),
  purpose       TEXT                    NOT NULL,

  progress      INT                     NOT NULL DEFAULT 0 CHECK (progress >= 0),
  status        earning_activity_status NOT NULL DEFAULT 'OPEN',

  -- What the member said happened, for a claimable metric. An object of short strings validated by the
  -- service; it is evidence for a human, so it is stored rather than parsed into meaninglessness.
  evidence      JSONB                   NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(evidence) = 'object'),

  submitted_at  TIMESTAMPTZ,
  decided_by    UUID                    REFERENCES admins (id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  decision_note VARCHAR(300),
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ             NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ             NOT NULL DEFAULT now(),
  UNIQUE (user_id, rule_id, bucket, occurrence),
  -- A paid row without a paid timestamp is a payout the engine cannot prove, and a refusal without a note
  -- is an operator saying no in a way nobody can answer a ticket with. Both are shape facts, so both are
  -- the schema's to hold — the same argument 0032 makes about a PAID withdrawal.
  CHECK (status <> 'PAID' OR paid_at IS NOT NULL),
  CHECK (status <> 'REFUSED' OR decision_note IS NULL OR decision_note ~ '\S'),
  CHECK (status <> 'PENDING' OR submitted_at IS NOT NULL),
  -- Only a submitted attempt can wait for review.
  CHECK (submitted_at IS NULL OR status <> 'OPEN')
);

-- The review queue, which must not read paid history.
CREATE INDEX IF NOT EXISTS earning_activity_review_idx
  ON earning_activities (status, submitted_at) WHERE status = 'PENDING';
-- "what have I got running" — the member's own read, newest bucket first.
CREATE INDEX IF NOT EXISTS earning_activity_member_idx
  ON earning_activities (user_id, bucket DESC, rule_id);
CREATE INDEX IF NOT EXISTS earning_activity_rule_idx
  ON earning_activities (rule_id, status);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS earning_activities_updated_at ON earning_activities;
  CREATE TRIGGER earning_activities_updated_at BEFORE UPDATE ON earning_activities
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE earning_activities IS
  'One member''s attempt at one rule inside one reset bucket. Progress, claim evidence and the operator decision all live on the same row because they describe the same attempt.';
COMMENT ON COLUMN earning_activities.bucket IS
  'The period this attempt belongs to, computed by PostgreSQL in the platform reset timezone: 2026-11-08 for a day, 2026-W45 for a week, 2026-11 for a month, ALL for a lifetime rule.';
COMMENT ON COLUMN earning_activities.occurrence IS
  'Which payout number this is inside the bucket, so a per-period cap above one is a unique key rather than a count that two requests can both pass.';

-- ---------------------------------------------------------------------------
-- earning_payouts — the engine's own record of what it paid
--
-- This is not a second ledger: an XP payout is answered by `users.xp` and a bonus-diamond payout by the
-- `promo_grants` row it minted and that grant's `PROMO_GRANT` journal entry. What this table adds is the
-- engine's answer to "how many times has this account been paid under this rule version", which no other
-- table can give, and the unique key that makes paying twice impossible.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS earning_payouts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The guard. A rule pays an activity once, so a retried payout has nowhere to land.
  activity_id    UUID        NOT NULL UNIQUE REFERENCES earning_activities (id) ON DELETE RESTRICT,
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rule_id        UUID        NOT NULL REFERENCES earning_rules (id) ON DELETE RESTRICT,
  rule_version   INT         NOT NULL,
  campaign_id    UUID        REFERENCES earning_campaigns (id) ON DELETE RESTRICT,
  bucket         TEXT        NOT NULL,
  occurrence     INT         NOT NULL CHECK (occurrence > 0),
  metric         TEXT        NOT NULL,
  purpose        TEXT        NOT NULL,
  currency       TEXT        NOT NULL CHECK (currency IN ('XP', 'BONUS_DIAMOND')),
  amount         INT         NOT NULL CHECK (amount > 0),
  -- Set only by a bonus-diamond payout, and required there: the grant is what makes the coin an expiring,
  -- bookable, non-cashable one. RESTRICT keeps the trail — a payout whose grant vanished could not be
  -- explained to support or to the reconciler.
  promo_grant_id UUID        REFERENCES promo_grants (id) ON DELETE RESTRICT,
  CHECK (currency <> 'BONUS_DIAMOND' OR promo_grant_id IS NOT NULL),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS earning_payout_member_idx
  ON earning_payouts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS earning_payout_campaign_idx
  ON earning_payouts (campaign_id, currency, created_at) WHERE campaign_id IS NOT NULL;

COMMENT ON TABLE earning_payouts IS
  'Every award the earning engine has paid, with the rule version that paid it. UNIQUE (activity_id) is what makes a replayed payout impossible rather than merely unlikely.';

-- ---------------------------------------------------------------------------
-- the vocabulary a bonus payout may mint under
--
-- `promo_grants.source_kind` is a closed list of the hooks that can mint, and until now it had no value for
-- an achievement. A payout writes its rule's purpose there, so the grant stays traceable; widening the
-- CHECK is the honest version of "the engine can now mint for a purpose 0036 could not name", and it is a
-- CHECK on a TEXT column rather than an `ALTER TYPE ... ADD VALUE`, which this transaction could not have
-- used in the statement that follows it anyway.
-- ---------------------------------------------------------------------------

ALTER TABLE promo_grants DROP CONSTRAINT IF EXISTS promo_grants_source_kind_check;
ALTER TABLE promo_grants ADD CONSTRAINT promo_grants_source_kind_check CHECK (
  source_kind IN ('CHECKIN', 'QUEST', 'CAMPAIGN', 'REFERRAL', 'EVENT', 'ACHIEVEMENT', 'ADMIN')
);
