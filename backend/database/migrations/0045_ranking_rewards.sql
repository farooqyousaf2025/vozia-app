-- 0045 — Ranking rewards: the settled boards pay their top three, once per period.
--
-- The landing boards (GET /api/rankings) read *finished* windows: yesterday, last ISO week,
-- last calendar month. A finished window cannot move, so a reward computed from it at claim
-- time is the same reward every retry would compute — no settlement cron, no snapshot table
-- that could drift from the ledger it summarises.
--
-- The mint itself rides the promotional rail (promo-diamond.service): journalised against
-- COIN_LIABILITY, expiring, never withdrawable. `RANKING` joins the closed source-kind list
-- so an operator reading promo_grants can tell a ranking payout from a check-in or a campaign.
--
-- One claim per member per board per period, enforced by the unique key rather than by the
-- client: the insert conflicts, the conflict answers with the existing claim, and no second
-- grant is minted. `grant_id` ties the claim to the exact promo row it paid, so the money book
-- and the reward history can be joined both ways.

ALTER TABLE promo_grants DROP CONSTRAINT IF EXISTS promo_grants_source_kind_check;
ALTER TABLE promo_grants ADD CONSTRAINT promo_grants_source_kind_check CHECK (
  source_kind IN ('CHECKIN', 'QUEST', 'CAMPAIGN', 'REFERRAL', 'EVENT', 'ACHIEVEMENT', 'ADMIN', 'RANKING')
);

CREATE TABLE IF NOT EXISTS ranking_reward_claims (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- host | rich | gifter: the three boards the landing page shows.
  board       VARCHAR(8) NOT NULL CHECK (board IN ('host', 'rich', 'gifter')),
  -- The finished window the reward was computed from, e.g. day:2026-11-16, week:2026-11-09
  -- (the Monday), month:2026-10. A string, not a date range: the key IS the period identity.
  period_key  VARCHAR(24) NOT NULL,
  position    SMALLINT NOT NULL CHECK (position >= 1 AND position <= 10),
  amount      INT NOT NULL CHECK (amount > 0),
  grant_id    UUID REFERENCES promo_grants (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, board, period_key)
);

CREATE INDEX IF NOT EXISTS ranking_claims_period_idx ON ranking_reward_claims (board, period_key);

COMMENT ON TABLE ranking_reward_claims IS 'One settled-ranking reward per member per board per finished period. The unique key is the idempotency guard; grant_id points at the promotional mint it paid.';
COMMENT ON COLUMN ranking_reward_claims.period_key IS 'Finished window identity (day:<date>, week:<monday date>, month:<yyyy-mm>). Recomputed server-side at claim time; never accepted from a client.';

-- The operator's dial: what each podium place pays. Seeded modest; the panel edits it under
-- config:manage like every other system_config row, and the service refuses a non-positive
-- or absurd amount rather than trusting the stored JSON.
INSERT INTO system_config (key, value)
VALUES ('rankings.rewards', '{"rewards":[{"position":1,"amount":500},{"position":2,"amount":300},{"position":3,"amount":200}]}'::jsonb)
ON CONFLICT (key) DO NOTHING;