-- 0004_business_accounts.sql — BD agents, coin sellers, seller recharges, commission
-- accrual and the money-side accounting book.
--
-- Programme §21-§25. The existing ledger tracks *virtual coins* (diamonds in, R-coins out).
-- This migration tracks the real-money half of the business: who collected it, what share
-- the platform owes a seller or a BD representative, and how those obligations settle.
-- The two books are joined by `transactions.id` and never merged — a commission is a
-- payable in currency, not a balance a client can spend.
--
-- Three rules are enforced by the schema rather than by service code, because each one is
-- a way to lose money quietly:
--   * one commission line per (order, beneficiary, kind)        -> no double-paying
--   * one settlement batch per commission entry                 -> no double-settling
--   * every journal entry debits as much as it credits          -> no invented value

-- ---------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE business_account_kind AS ENUM ('BD_MANAGER', 'BD_AGENT', 'COIN_SELLER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE business_account_status AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE recharge_order_status AS ENUM (
    'AWAITING_PAYMENT',    -- seller opened it, nothing collected yet
    'AWAITING_VERIFICATION', -- seller claims payment; needs evidence + a finance decision
    'CREDITED',            -- coins issued, exactly once
    'REJECTED',            -- finance said no; no coins, no commission
    'CANCELLED',           -- seller withdrew it before credit
    'EXPIRED',             -- aged out of its validity window
    'REVERSED'             -- was credited, then refunded/chargebacked; see reversal fields
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE commission_beneficiary AS ENUM ('SELLER', 'BD', 'PLATFORM', 'PROVIDER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE commission_rule_kind AS ENUM ('SELLER_PERCENT', 'SELLER_FIXED', 'SELLER_TIER', 'BD_PERCENT', 'BD_FIXED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE commission_entry_status AS ENUM ('ACCRUED', 'REJECTED', 'SETTLED', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE settlement_status_new AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'VOID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_account_kind AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fin_direction AS ENUM ('DEBIT', 'CREDIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- business_accounts — BD representatives and coin sellers, one table.
--
-- Deliberately NOT in `admins`: a seller is an external business partner with a narrow,
-- own-scope data range, and putting their credential in the operator table would make
-- every existing `requireAdmin` route reachable with it. They authenticate through their
-- own scope (`scope: 'business'`) and can only ever reach the business routes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            business_account_kind   NOT NULL,
  -- The "unique BD ID" / "Seller ID" of the programme brief: short, human, never reused.
  code            VARCHAR(24) NOT NULL UNIQUE,
  display_name    VARCHAR(80) NOT NULL,
  contact_email   VARCHAR(120),
  contact_phone   VARCHAR(20),
  -- scrypt hash, same scheme as admins. NULL until the operator provisions a password.
  password_hash   TEXT,
  -- Sellers hang off a BD; a BD_AGENT hangs off its BD_MANAGER. NULL = reports to platform.
  parent_id       UUID REFERENCES business_accounts (id) ON DELETE SET NULL,
  status          business_account_status NOT NULL DEFAULT 'PENDING',
  market_country  VARCHAR(2),
  -- §22 "permitted recharge packages and transaction limits", per seller.
  max_order_diamonds   INT  NOT NULL DEFAULT 100000 CHECK (max_order_diamonds > 0),
  daily_diamond_limit  INT  NOT NULL DEFAULT 1000000 CHECK (daily_diamond_limit > 0),
  daily_order_limit    INT  NOT NULL DEFAULT 200 CHECK (daily_order_limit > 0),
  -- Set when a PENDING account is approved, or when it is suspended.
  approved_by     UUID REFERENCES admins (id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  suspended_reason VARCHAR(200),
  created_by      UUID REFERENCES admins (id) ON DELETE SET NULL,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id),
  -- A tree of sellers cannot contain another seller: only BD accounts may be parents.
  CHECK (kind = 'COIN_SELLER' OR parent_id IS NULL)
);

CREATE INDEX IF NOT EXISTS business_parent_idx ON business_accounts (parent_id, kind);
CREATE INDEX IF NOT EXISTS business_status_idx ON business_accounts (status, kind);

-- ---------------------------------------------------------------------------
-- commission_rules — versioned, effective-dated, never edited in place.
--
-- An in-flight order records the rules that paid it (`rule_version` on every entry), so
-- changing a rate tomorrow cannot restatement yesterday's statements.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commission_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           commission_rule_kind NOT NULL,
  -- SELLER_* rules pay a seller, BD_* rules pay the BD above them.
  beneficiary    commission_beneficiary NOT NULL,
  -- NULL = the platform default for this kind; a set id = an agreed rate for one account.
  applies_to_id  UUID REFERENCES business_accounts (id) ON DELETE CASCADE,
  rules_version  INT NOT NULL DEFAULT 1 CHECK (rules_version > 0),
  -- Percentage of eligible net recharge value, basis points (10000 = 100 %).
  percent_bps    INT CHECK (percent_bps BETWEEN 0 AND 10000),
  -- Fixed amount per eligible transaction, in currency minor units.
  fixed_cents    INT CHECK (fixed_cents >= 0),
  -- Volume tiers: [{"uptoCents":500000,"percentBps":300}, ...] ascending, last row open-ended.
  tiers          JSONB,
  -- A rule may apply only inside an order-value window (promo rates, small-order floors).
  min_order_cents INT CHECK (min_order_cents IS NULL OR min_order_cents >= 0),
  max_order_cents INT CHECK (max_order_cents IS NULL OR max_order_cents > 0),
  currency       VARCHAR(3) NOT NULL DEFAULT 'pkr',
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to   TIMESTAMPTZ,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by     UUID REFERENCES admins (id) ON DELETE SET NULL,
  note           VARCHAR(200),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'SELLER_PERCENT' AND percent_bps IS NOT NULL)
    OR (kind = 'BD_PERCENT'   AND percent_bps IS NOT NULL)
    OR (kind = 'SELLER_FIXED' AND fixed_cents IS NOT NULL)
    OR (kind = 'BD_FIXED'     AND fixed_cents IS NOT NULL)
    OR (kind = 'SELLER_TIER'  AND tiers IS NOT NULL)
  ),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Null-safe on purpose: `applies_to_id IS NULL` is the platform default, and a plain UNIQUE
-- would let two "default v1" rows coexist for the same kind.
CREATE UNIQUE INDEX IF NOT EXISTS commission_rule_version_idx
  ON commission_rules (kind, COALESCE(applies_to_id, '00000000-0000-0000-0000-000000000000'::uuid), rules_version);

CREATE INDEX IF NOT EXISTS commission_rule_lookup_idx
  ON commission_rules (beneficiary, kind, applies_to_id, effective_from DESC);

-- ---------------------------------------------------------------------------
-- recharge_orders — the seller-initiated workflow of §22.
--
-- The order, not the seller's claim, is the unit of trust: `AWAITING_VERIFICATION` means a
-- human or a PSP webhook has yet to say the money arrived, and only `CREDITED` may ever
-- move coins. The credit itself is idempotent because `reference` is unique and is used as
-- the external id in `payment_proofs`, the same table that already de-duplicates PSP
-- webhooks — so a seller resubmitting the same order cannot mint a second RECHARGE row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recharge_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        VARCHAR(32) NOT NULL UNIQUE,
  seller_id        UUID NOT NULL REFERENCES business_accounts (id) ON DELETE RESTRICT,
  -- Attribution frozen at creation: re-deriving it from the seller's current parent would
  -- rewrite history whenever a seller is moved between BDs.
  bd_id            UUID REFERENCES business_accounts (id) ON DELETE SET NULL,
  user_id          UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  package_key      VARCHAR(48),
  diamonds         INT NOT NULL CHECK (diamonds > 0),
  amount_cents     BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency         VARCHAR(3) NOT NULL DEFAULT 'pkr',
  -- 'PROVIDER:<name>' for a PSP-verified order, or a manual rail: 'JAZZCASH','EASYPAISA',
  -- 'BANK','CASH'. Manual rails always need evidence and a finance approval.
  payment_method   VARCHAR(24) NOT NULL,
  payment_ref      VARCHAR(120),
  provider         VARCHAR(24),
  external_id      VARCHAR(120),
  -- Receipt URL / screenshot id / operator note. Required before a manual order can be
  -- approved — "the seller says it is paid" is not a payment.
  evidence         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           recharge_order_status NOT NULL DEFAULT 'AWAITING_PAYMENT',
  -- Rate snapshot used for this order's commission entries.
  rules_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  fee_cents        BIGINT NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),  -- payment-provider fee
  transaction_id   UUID REFERENCES transactions (id) ON DELETE SET NULL,
  verified_by      UUID REFERENCES admins (id) ON DELETE SET NULL,
  verified_at      TIMESTAMPTZ,
  decision_note    VARCHAR(200),
  reversed_at      TIMESTAMPTZ,
  reversal_reason  VARCHAR(200),
  reverses_amount_cents BIGINT CHECK (reverses_amount_cents IS NULL OR reverses_amount_cents >= 0),
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Only a credited order may hold a ledger row, and a credited order must hold one.
  CHECK (status <> 'CREDITED' OR transaction_id IS NOT NULL),
  CHECK (status = 'CREDITED' OR transaction_id IS NULL)
);

-- A PSP reference belongs to one order, so a webhook replay finds the order it paid for.
CREATE UNIQUE INDEX IF NOT EXISTS recharge_order_external_idx
  ON recharge_orders (provider, external_id) WHERE provider IS NOT NULL AND external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS recharge_order_seller_idx ON recharge_orders (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recharge_order_bd_idx     ON recharge_orders (bd_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recharge_order_user_idx   ON recharge_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recharge_order_status_idx ON recharge_orders (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- commission_entries — what the platform owes, per order and per beneficiary.
--
-- `UNIQUE (recharge_order_id, beneficiary, beneficiary_id, kind)` is the whole
-- anti-double-pay story: the accrual service can be run again for the same order (retry,
-- manual re-run, a second webhook) and the database refuses a second line of the same kind.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commission_entries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recharge_order_id  UUID NOT NULL REFERENCES recharge_orders (id) ON DELETE CASCADE,
  beneficiary        commission_beneficiary NOT NULL,
  -- Set for SELLER/BD; NULL for PLATFORM revenue and PROVIDER fees, which owe nobody.
  beneficiary_id     UUID REFERENCES business_accounts (id) ON DELETE SET NULL,
  kind               commission_rule_kind NOT NULL,
  rule_id            UUID REFERENCES commission_rules (id) ON DELETE SET NULL,
  rule_version       INT NOT NULL DEFAULT 1,
  status             commission_entry_status NOT NULL DEFAULT 'ACCRUED',
  basis_cents        BIGINT NOT NULL DEFAULT 0 CHECK (basis_cents >= 0),
  amount_cents       BIGINT NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  currency           VARCHAR(3) NOT NULL DEFAULT 'pkr',
  -- A refund does not delete the accrual; it books the mirror line and points at it.
  reversal_of_id     UUID REFERENCES commission_entries (id) ON DELETE SET NULL,
  settled_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recharge_order_id, beneficiary, beneficiary_id, kind),
  CHECK (
    (beneficiary IN ('SELLER', 'BD') AND beneficiary_id IS NOT NULL)
    OR (beneficiary IN ('PLATFORM', 'PROVIDER') AND beneficiary_id IS NULL)
  ),
  CHECK (reversal_of_id IS NULL OR reversal_of_id <> id)
);

CREATE INDEX IF NOT EXISTS commission_entry_beneficiary_idx
  ON commission_entries (beneficiary, beneficiary_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS commission_entry_order_idx ON commission_entries (recharge_order_id);

-- The configurable allocation ceiling (system_config) can move; this cannot: the sum owed
-- across every beneficiary of one order may never exceed what that order actually
-- collected. It is the same "the total allocated amount cannot exceed the amount
-- available" rule the game settlement pool already enforces, applied to real money.
CREATE OR REPLACE FUNCTION commission_within_order_value() RETURNS trigger AS $$
DECLARE
  accrued BIGINT;
  order_value BIGINT;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN reversal_of_id IS NOT NULL THEN -amount_cents ELSE amount_cents END), 0)
    INTO accrued
    FROM commission_entries
   WHERE recharge_order_id = NEW.recharge_order_id
     AND status <> 'REJECTED';

  SELECT amount_cents INTO order_value FROM recharge_orders WHERE id = NEW.recharge_order_id;

  IF accrued > order_value THEN
    RAISE EXCEPTION 'order % allocates % of commission against a collection of %',
      NEW.recharge_order_id, accrued, order_value
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commission_entries_within_order ON commission_entries;
CREATE TRIGGER commission_entries_within_order
  AFTER INSERT OR UPDATE ON commission_entries
  FOR EACH ROW EXECUTE FUNCTION commission_within_order_value();

-- ---------------------------------------------------------------------------
-- commission_settlements — payout batches, and the join that makes settling once possible.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commission_settlements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       VARCHAR(32) NOT NULL UNIQUE,
  beneficiary     commission_beneficiary NOT NULL,
  beneficiary_id  UUID NOT NULL REFERENCES business_accounts (id) ON DELETE RESTRICT,
  currency        VARCHAR(3) NOT NULL DEFAULT 'pkr',
  amount_cents    BIGINT NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  entry_count     INT NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  status          settlement_status_new NOT NULL DEFAULT 'DRAFT',
  period_from     TIMESTAMPTZ NOT NULL,
  period_to       TIMESTAMPTZ NOT NULL,
  payout_method   VARCHAR(24),
  payout_details  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      UUID REFERENCES admins (id) ON DELETE SET NULL,
  approved_by     UUID REFERENCES admins (id) ON DELETE SET NULL,
  paid_at         TIMESTAMPTZ,
  note            VARCHAR(200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_to > period_from),
  CHECK (beneficiary IN ('SELLER', 'BD'))
);

CREATE INDEX IF NOT EXISTS settlement_beneficiary_idx
  ON commission_settlements (beneficiary, beneficiary_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS commission_settlement_items (
  settlement_id UUID NOT NULL REFERENCES commission_settlements (id) ON DELETE CASCADE,
  entry_id      UUID NOT NULL REFERENCES commission_entries (id) ON DELETE RESTRICT,
  included_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One entry, one batch — ever. Re-running settlement on a settled period is a no-op.
  PRIMARY KEY (settlement_id, entry_id),
  UNIQUE (entry_id)
);

-- ---------------------------------------------------------------------------
-- system_config — the switches §21-§23 make administrator-owned.
--
-- Which commission kinds may combine, and in what order, is a business rule the platform
-- must be able to change without a deploy; it is stored here so the accrual engine can
-- version it into `rules_snapshot` alongside the rates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_config (
  key         VARCHAR(48) PRIMARY KEY,
  value       JSONB NOT NULL,
  description VARCHAR(300),
  updated_by  UUID REFERENCES admins (id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_config (key, value, description) VALUES
  ('business.recharge',
   '{"orderValidityMinutes": 60, "manualEvidenceRequired": true, "autoCreditFromProvider": true}'::jsonb,
   'Seller recharge windows and whether a PSP webhook may credit without a human.'),
  ('commission.calculationOrder',
   '{"enabled": ["SELLER_TIER", "SELLER_PERCENT", "SELLER_FIXED", "BD_PERCENT", "BD_FIXED"], "maxAllocationBps": 2500}'::jsonb,
   'Order in which commission kinds are applied, and the ceiling on total commission as a share of the order value.'),
  ('business.bd',
   '{"multiManager": false}'::jsonb,
   'Whether more than one BD manager may exist and split a territory.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Double-entry book of financial value flows (§25).
--
-- The coin ledger already answers "whose balance moved". This answers "what did the
-- platform collect, how many coins did that issue, how much is still owed to a partner,
-- and how much of it is actually revenue". The face value of issued coins is a liability
-- (a service the platform still owes the holder), not revenue — recognised revenue is the
-- collection against which coins were issued, net of the provider fee.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fin_accounts (
  code       VARCHAR(32) PRIMARY KEY,
  name       VARCHAR(80) NOT NULL,
  kind       fin_account_kind NOT NULL,
  currency   VARCHAR(3) NOT NULL DEFAULT 'pkr',
  -- Increases on DEBIT for ASSET/EXPENSE, on CREDIT for LIABILITY/EQUITY/REVENUE.
  normal_side fin_direction NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO fin_accounts (code, name, kind, normal_side) VALUES
  ('COLLECTIONS_PENDING',   'Collections awaiting reconciliation', 'ASSET',      'DEBIT'),
  ('PROVIDER_COLLECTIONS',  'Money held by the payment provider',  'ASSET',      'DEBIT'),
  ('PROVIDER_FEES',         'Payment-provider fees',               'EXPENSE',    'DEBIT'),
  ('COIN_LIABILITY',        'Coins issued and not yet spent',      'LIABILITY',  'CREDIT'),
  ('SELLER_COMMISSION_PAY', 'Seller commission payable',           'LIABILITY',  'CREDIT'),
  ('BD_COMMISSION_PAY',     'BD commission payable',               'LIABILITY',  'CREDIT'),
  ('COMMISSION_EXPENSE',    'Partner commission expense',          'EXPENSE',    'DEBIT'),
  ('PLATFORM_REVENUE',      'Recognised platform revenue',         'REVENUE',    'CREDIT'),
  ('REFUND_RESERVE',        'Refunds and reversals held back',     'EXPENSE',    'DEBIT')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS fin_journal_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference    VARCHAR(40) NOT NULL UNIQUE,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What produced this entry, so finance can always walk back to the source row.
  source_kind  VARCHAR(24) NOT NULL,   -- 'RECHARGE_ORDER' | 'COMMISSION_ACCRUAL' | 'SETTLEMENT' | 'REVERSAL'
  source_id    TEXT NOT NULL,
  memo         VARCHAR(300),
  currency     VARCHAR(3) NOT NULL DEFAULT 'pkr',
  created_by   UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fin_journal_source_idx ON fin_journal_entries (source_kind, source_id);

CREATE TABLE IF NOT EXISTS fin_journal_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     UUID NOT NULL REFERENCES fin_journal_entries (id) ON DELETE CASCADE,
  account_code VARCHAR(32) NOT NULL REFERENCES fin_accounts (code) ON DELETE RESTRICT,
  direction    fin_direction NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency     VARCHAR(3) NOT NULL DEFAULT 'pkr',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fin_line_entry_idx  ON fin_journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS fin_line_account_idx ON fin_journal_lines (account_code, created_at DESC);

-- Idempotent by construction: one balanced entry per source row.
CREATE UNIQUE INDEX IF NOT EXISTS fin_journal_source_once_idx
  ON fin_journal_entries (source_kind, source_id);

CREATE OR REPLACE FUNCTION fin_journal_is_balanced() RETURNS trigger AS $$
DECLARE
  debits  BIGINT;
  credits BIGINT;
BEGIN
  -- Deferred to commit time: the writer inserts the header first and the lines after it,
  -- so an immediate check would reject every valid entry.
  SELECT COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'DEBIT'), 0),
         COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'CREDIT'), 0)
    INTO debits, credits
    FROM fin_journal_lines
   WHERE entry_id = NEW.entry_id;

  IF debits <> credits THEN
    RAISE EXCEPTION 'journal entry % is unbalanced (% debit / % credit)',
      NEW.entry_id, debits, credits
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fin_journal_lines_balanced ON fin_journal_lines;
CREATE CONSTRAINT TRIGGER fin_journal_lines_balanced
  AFTER INSERT OR UPDATE ON fin_journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fin_journal_is_balanced();

-- ---------------------------------------------------------------------------
-- admin role vocabulary (§23)
--
-- `admins.role` was VARCHAR(16), which cannot hold 'OPERATIONS_ADMIN'... it just fits, but
-- 'SUPER_ADMINISTRATOR' would not. Widened rather than re-typed so existing rows survive.
-- ---------------------------------------------------------------------------
ALTER TABLE admins ALTER COLUMN role TYPE VARCHAR(32);
UPDATE admins SET role = 'SUPER_ADMIN' WHERE role IN ('SUPER', 'ADMIN');

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_accounts', 'recharge_orders', 'commission_settlements', 'system_config'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %1$s_updated_at ON %1$I;
       CREATE TRIGGER %1$s_updated_at BEFORE UPDATE ON %1$I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;
