-- 0029_purpose_accounts.sql — owner-scoped purpose accounts over the books that already exist.
--
-- Purpose-accounts brief sections 2, 3, 4 and 10. This does NOT create a third wallet.
-- Voiza already keeps value in three places, and each one stays authoritative for what it
-- holds: `users.diamond_balance` / `users.r_coin_balance` for coins a person can spend,
-- `commission_entries` / `commission_settlements` for what the platform owes a BD or a
-- seller, and `fin_journal_lines` for what the platform itself collected, issued and kept.
-- A purpose account is a *named, owned window onto one of those*, recorded in
-- `fin_accounts.balance_source`, and the figures in `purpose_account_balances` are computed
-- from it rather than copied beside it. That is the difference between an accounting layer
-- and a second ledger that drifts.
--
-- "Projection first" is deliberate and it constrains the next phase: an account can be
-- reported and reconciled before it can be written through. Every derived column here can be
-- reproduced from its source by a query, so flipping a category to ledger-authoritative later
-- is a change of write path, not of history.
--
-- Four things are enforced by the schema rather than by service code, because each is a way
-- to make a balance disagree with itself quietly:
--   * one account per (owner, category, currency)        -> no split identity to reconcile
--   * every journal line in an entry shares one currency -> 5,000 diamonds cannot "balance"
--                                                          5,000 rupees (see the new trigger)
--   * a hold is a row with a reason and an author        -> frozen money stays explainable
--   * an account operation needs an idempotency key      -> a retried payout pays once

-- ---------------------------------------------------------------------------
-- enums
--
-- `ALTER TYPE ... ADD VALUE` cannot be *used* inside the file that creates it (see the
-- migrate runner's note), so nothing below reads these values in a CHECK expression —
-- Postgres validates them against the type itself, which is already created by the time the
-- INSERTs at the bottom of this file run.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE account_category AS ENUM (
    'PLATFORM_MAIN',     -- revenue, commission, adjustments, overall reporting
    'USER_DIAMOND',      -- purchased diamonds and what they bought
    'HOST_RCOIN',        -- gift earnings, bonuses, withdrawals
    'BD_MANAGER',        -- commission earned down a seller or agency tree
    'COIN_SELLER',       -- recharge business and its settlement records
    'AGENCY',            -- agency earnings from assigned hosts
    'GAME_OPS',          -- entry fees, service charges, game commission, refunds
    'PROMOTIONAL',       -- welcome bonuses and event rewards, with expiry
    'PENDING_SETTLEMENT' -- anything collected or owed but not yet confirmed
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_owner_kind AS ENUM ('PLATFORM', 'USER', 'BUSINESS', 'AGENCY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE purpose_account_status AS ENUM ('ACTIVE', 'SUSPENDED', 'FROZEN', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_hold_kind AS ENUM ('FROZEN', 'PENDING_SETTLEMENT', 'WITHDRAWAL', 'PROMOTIONAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_hold_status AS ENUM ('OPEN', 'RELEASED', 'CONVERTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- widen the account code
--
-- Owner-scoped codes are `CATEGORY:uuid`, which is 49 characters for the longest category
-- name; `code` was VARCHAR(32), sized for the nine hand-written chart codes. The foreign key
-- has to move with it, and Postgres will not alter a referenced column while the constraint
-- pins its type, so the constraint is dropped and re-created around the widen. Nothing is
-- regenerated: existing codes are unchanged, and every existing journal line still points
-- where it did.
-- ---------------------------------------------------------------------------
ALTER TABLE fin_journal_lines DROP CONSTRAINT IF EXISTS fin_journal_lines_account_code_fkey;
ALTER TABLE fin_accounts ALTER COLUMN code TYPE VARCHAR(64);
ALTER TABLE fin_journal_lines ALTER COLUMN account_code TYPE VARCHAR(64);
ALTER TABLE fin_journal_lines
  ADD CONSTRAINT fin_journal_lines_account_code_fkey
  FOREIGN KEY (account_code) REFERENCES fin_accounts (code) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- fin_accounts becomes the purpose-account table
--
-- The nine existing chart rows are the platform's own accounts, so they take PLATFORM_MAIN
-- and a NULL owner honestly — the "Main Platform Account" of the brief is that chart, not a
-- new row beside it. An owner-scoped account adds owner columns and points `balance_source`
-- at whichever table already holds its value; balances are never stored here.
-- ---------------------------------------------------------------------------
ALTER TABLE fin_accounts
  ADD COLUMN IF NOT EXISTS category         account_category NOT NULL DEFAULT 'PLATFORM_MAIN'::account_category,
  ADD COLUMN IF NOT EXISTS owner_kind       account_owner_kind,
  ADD COLUMN IF NOT EXISTS owner_id         UUID,
  ADD COLUMN IF NOT EXISTS status           purpose_account_status NOT NULL DEFAULT 'ACTIVE'::purpose_account_status,
  ADD COLUMN IF NOT EXISTS balance_source   VARCHAR(40) NOT NULL DEFAULT 'fin_journal_lines',
  ADD COLUMN IF NOT EXISTS suspended_reason VARCHAR(200),
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();

-- An owner is meaningless without its kind, and the platform's own accounts have neither.
ALTER TABLE fin_accounts ADD CONSTRAINT purpose_account_owner_shape CHECK (
  (owner_kind IS NULL AND owner_id IS NULL)
  OR (owner_kind IS NOT NULL AND owner_id IS NOT NULL)
);

-- Which table is authoritative is a short, fixed vocabulary, so a typo cannot invent a source
-- that silently reports zero.
ALTER TABLE fin_accounts ADD CONSTRAINT purpose_account_source_known CHECK (
  balance_source IN ('fin_journal_lines', 'users.diamond_balance', 'users.r_coin_balance', 'commission_entries')
);

-- Only an owner-scoped row is a purpose account; the chart stays unique by code alone.
ALTER TABLE fin_accounts ADD CONSTRAINT purpose_account_owner_kind_matches CHECK (
  owner_kind IS DISTINCT FROM 'PLATFORM'::account_owner_kind
);

CREATE UNIQUE INDEX IF NOT EXISTS purpose_account_owner_uq
  ON fin_accounts (owner_kind, owner_id, category, currency)
  WHERE owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS purpose_account_category_idx ON fin_accounts (category, status);

COMMENT ON TABLE fin_accounts IS
  'Purpose accounts: the platform chart of accounts plus one named account per owner and category. '
  'Balances live in the table named by balance_source, never in this one.';

-- ---------------------------------------------------------------------------
-- One currency per journal entry.
--
-- The existing balance trigger (0004) sums amount by direction across the whole entry with no
-- currency grouping, and postJournal does the same in TypeScript. Both were safe while every
-- account was PKR. Introducing diamond- and R-coin-denominated accounts makes them unsafe: a
-- 5,000-diamond debit against a 5,000-paisa credit would balance to the database while
-- inventing value. The unit is declared on the entry and every line must match it.
--
-- `amount_cents` keeps its name and its CHECK (> 0). For a `pkr` entry it is minor units; for
-- a `dmn` or `rcn` entry it is a whole coin count. BIGINT either way — the currency column is
-- what says which, and no report may add across the two.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_journal_line_currency_matches() RETURNS trigger AS $$
DECLARE
  entry_currency VARCHAR(3);
BEGIN
  SELECT currency INTO entry_currency FROM fin_journal_entries WHERE id = NEW.entry_id;
  IF NEW.currency <> entry_currency THEN
    RAISE EXCEPTION 'journal entry % is % but line % is %',
      NEW.entry_id, entry_currency, NEW.id, NEW.currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Deferred like the balance check: a header and its lines are written in one transaction, and
-- an immediate check would reject a valid entry mid-write.
DROP TRIGGER IF EXISTS fin_journal_lines_one_currency ON fin_journal_lines;
CREATE CONSTRAINT TRIGGER fin_journal_lines_one_currency
  AFTER INSERT OR UPDATE ON fin_journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fin_journal_line_currency_matches();

-- ---------------------------------------------------------------------------
-- account_holds — frozen and pending amounts as durable, explainable rows
--
-- The brief wants available / pending / frozen on every account. A mutable `frozen_balance`
-- column is a second balance that can drift from the reason it exists, so a hold is a row with
-- an amount, a reason and an author, and the frozen figure is the sum of the open ones. That
-- also gives a release a history, which is what an investigation asks for.
--
-- Until the ledger guards land in the service layer, a hold on a coin account does not stop a
-- spend — the spend path reads `users`, not this table. It is accurate as reporting and inert
-- as a control; section 8 of the brief is not satisfied by it alone.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_holds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_code  VARCHAR(64) NOT NULL REFERENCES fin_accounts (code) ON DELETE RESTRICT,
  kind          account_hold_kind NOT NULL,
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  currency      VARCHAR(3) NOT NULL,
  reason        VARCHAR(300) NOT NULL,
  status        account_hold_status NOT NULL DEFAULT 'OPEN',
  created_by    UUID REFERENCES admins (id) ON DELETE SET NULL,
  released_by   UUID REFERENCES admins (id) ON DELETE SET NULL,
  released_at   TIMESTAMPTZ,
  -- What the hold became: a settlement, a paid withdrawal, a reversal. Optional because a
  -- plain unfreeze converts nothing.
  converted_ref VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Only the dead ones carry their ending, and only a conversion names what it became.
  CHECK (status = 'OPEN' OR released_at IS NOT NULL),
  CHECK (status <> 'OPEN' OR released_at IS NULL),
  CHECK ((status = 'CONVERTED') = (converted_ref IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS account_hold_open_idx ON account_holds (account_code, status, created_at DESC);

COMMENT ON TABLE account_holds IS
  'Frozen and pending amounts held against a purpose account, each with the reason and the operator who set it.';

-- ---------------------------------------------------------------------------
-- idempotent_requests — the key that makes an account operation safe to retry
--
-- Gift sends already have a sender-scoped key (0023) and Stripe credits have
-- payment_proofs (provider, external_id); both stay. What had no key was the operator-side
-- money action: approve a settlement, pay a withdrawal, post an adjustment. An admin
-- double-clicking "approve" on a slow connection is the same class of bug those tables exist
-- to stop.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotent_requests (
  scope        VARCHAR(48) NOT NULL,
  key          VARCHAR(80) NOT NULL CHECK (key ~ '^[\w.-]{8,80}$'),
  -- The row the first attempt produced, so a replay can be answered with the real result.
  resource_ref VARCHAR(64),
  response     JSONB,
  created_by   UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The key is the whole point of the table, so its uniqueness lives in the constraint rather
  -- than in whichever INSERT path a caller took: two operators pressing approve at the same
  -- instant get one row between them, not two.
  PRIMARY KEY (scope, key)
);

COMMENT ON TABLE idempotent_requests IS
  'Replay guards for operator money actions; a second attempt with the same scope and key returns the first result.';

-- ---------------------------------------------------------------------------
-- transactions gains the reference and the account it moved
--
-- Section 4 asks every financial transaction for a reference and a ledger link. The UUID is
-- already unique but is not quotable on a support call, so `reference` is a derived label, and
-- `account_code` names the purpose account a movement hit — NULL on rows written before this
-- migration, which are reconstructed from sender and receiver instead. Both columns are
-- nullable or backfilled, so no existing write path changes behaviour.
-- ---------------------------------------------------------------------------
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(40);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_code VARCHAR(64) REFERENCES fin_accounts (code) ON DELETE SET NULL;

UPDATE transactions SET reference = 'TX-' || id::text WHERE reference IS NULL;
ALTER TABLE transactions ALTER COLUMN reference SET NOT NULL;
-- The default is not a convenience. `transactions` is written from six places in the ledger,
-- and a NOT NULL column with no default fails all of them — which is exactly what happened the
-- first time this migration was applied. Deriving it here means every writer gets a reference
-- whether or not it was updated to ask for one, and the T2 work can set real ones at its pace.
ALTER TABLE transactions ALTER COLUMN reference SET DEFAULT ('TX-' || gen_random_uuid()::text);
ALTER TABLE transactions ADD CONSTRAINT transaction_reference_uq UNIQUE (reference);

CREATE INDEX IF NOT EXISTS tx_account_idx ON transactions (account_code, created_at DESC);

-- ---------------------------------------------------------------------------
-- Backfill: one account per owner per category they can hold
--
-- Guarded by NOT EXISTS rather than ON CONFLICT because conflict inference on a partial index
-- is fussy. A user created after this run gets their two accounts lazily on first read
-- (purpose-account.service.ts), so this only has to cover the population that already exists.
--
-- Currency codes are three characters because fin_accounts.currency is VARCHAR(3): `dmn` and
-- `rcn` are coin counts, `pkr` is minor units.
-- ---------------------------------------------------------------------------
INSERT INTO fin_accounts (code, name, kind, currency, normal_side, category, owner_kind, owner_id, balance_source)
  SELECT 'USER_DIAMOND:' || u.id, u.username || ' — diamonds', 'ASSET', 'dmn', 'DEBIT',
         'USER_DIAMOND', 'USER', u.id, 'users.diamond_balance'
    FROM users u
   WHERE NOT EXISTS (SELECT 1 FROM fin_accounts f WHERE f.owner_kind = 'USER' AND f.owner_id = u.id AND f.category = 'USER_DIAMOND');

-- Every user is a potential host, and an empty R-coin account is the honest state of one who
-- has never received a gift. Splitting the two categories later would renumber history.
INSERT INTO fin_accounts (code, name, kind, currency, normal_side, category, owner_kind, owner_id, balance_source)
  SELECT 'HOST_RCOIN:' || u.id, u.username || ' — R-coin earnings', 'LIABILITY', 'rcn', 'CREDIT',
         'HOST_RCOIN', 'USER', u.id, 'users.r_coin_balance'
    FROM users u
   WHERE NOT EXISTS (SELECT 1 FROM fin_accounts f WHERE f.owner_kind = 'USER' AND f.owner_id = u.id AND f.category = 'HOST_RCOIN');

-- A BD_AGENT accrues into the same BD category as a BD_MANAGER; the distinction stays on
-- business_accounts.kind and is reachable through owner_id.
INSERT INTO fin_accounts (code, name, kind, currency, normal_side, category, owner_kind, owner_id, balance_source)
  SELECT CASE WHEN b.kind = 'COIN_SELLER' THEN 'COIN_SELLER:' ELSE 'BD_MANAGER:' END || b.id,
         b.display_name || CASE WHEN b.kind = 'COIN_SELLER' THEN ' — seller settlements' ELSE ' — BD commission' END,
         'LIABILITY', 'pkr', 'CREDIT',
         CASE WHEN b.kind = 'COIN_SELLER' THEN 'COIN_SELLER'::account_category ELSE 'BD_MANAGER'::account_category END,
         'BUSINESS', b.id, 'commission_entries'
    FROM business_accounts b
   WHERE NOT EXISTS (SELECT 1 FROM fin_accounts f WHERE f.owner_kind = 'BUSINESS' AND f.owner_id = b.id);

-- Born ledger-authoritative, because there is nothing else for one to read: agency commission
-- is computed today and stored nowhere (ledger.service.ts posts an AGENCY_COMMISSION row
-- without touching any balance). The account exists so that gap has an address.
INSERT INTO fin_accounts (code, name, kind, currency, normal_side, category, owner_kind, owner_id, balance_source)
  SELECT 'AGENCY:' || a.id, a.name || ' — agency earnings', 'LIABILITY', 'pkr', 'CREDIT',
         'AGENCY', 'AGENCY', a.id, 'fin_journal_lines'
    FROM agencies a
   WHERE NOT EXISTS (SELECT 1 FROM fin_accounts f WHERE f.owner_kind = 'AGENCY' AND f.owner_id = a.id);

-- The three platform-wide accounts that are not the chart of accounts.
INSERT INTO fin_accounts (code, name, kind, currency, normal_side, category, balance_source)
  SELECT v.code, v.name, v.kind::fin_account_kind, v.currency, v.normal_side::fin_direction, v.category::account_category,
         'fin_journal_lines'
    FROM (VALUES
      ('GAME_OPS:PLATFORM',          'Game operations pool',         'LIABILITY', 'pkr', 'CREDIT', 'GAME_OPS'),
      ('PROMOTIONAL:PLATFORM',       'Promotional and bonus budget',  'EXPENSE',   'pkr', 'DEBIT',  'PROMOTIONAL'),
      ('PENDING_SETTLEMENT:PLATFORM','Settlements awaiting payment',  'ASSET',     'pkr', 'DEBIT',  'PENDING_SETTLEMENT')
    ) AS v(code, name, kind, currency, normal_side, category)
   WHERE NOT EXISTS (SELECT 1 FROM fin_accounts f WHERE f.code = v.code);

-- ---------------------------------------------------------------------------
-- The switches section 5 asks for, defaulted to what the code hardcodes today, so adopting
-- them changes nothing until an operator moves a number.
-- ---------------------------------------------------------------------------
INSERT INTO system_config (key, value, description) VALUES
  ('accounts.withdrawal',
   '{"minRCoins": 100000, "feeBps": 0}'::jsonb,
   'Smallest R-coin cash-out accepted and the fee taken from it, in basis points. Replaces the MIN_WITHDRAW_RCOINS environment variable once the ledger reads this.'),
  ('accounts.promotional',
   '{"expiryDays": 30, "welcomeBonusDiamonds": 0}'::jsonb,
   'How long a promotional credit stays spendable and what a new account is granted. Zero disables the grant.'),
  ('accounts.agency',
   '{"defaultCommissionBps": 1000}'::jsonb,
   'Agency share of an assigned host''s gift earnings when the host row carries no agreed rate.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- coin_movements — one row per leg of a ledger transaction
--
-- This exists so that nothing has to re-derive what a transaction did. `transactions` records
-- a gift as ONE row with TWO legs (the sender's diamonds and the receiver's R-coins), an
-- ADMIN_ADJUSTMENT as one row whose sign lives only in `meta`, and an AGENCY_COMMISSION as a
-- row whose amount is notional. Any consumer that gets those three rules slightly wrong reports
-- a balance that disagrees with the wallet screen, and the disagreement is invisible because
-- both numbers look plausible.
--
-- So the rules are written once, here, and both `purpose_account_balances` and the statement
-- read them. Zero-amount legs are dropped so a caller can sum without filtering.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW coin_movements AS
SELECT * FROM (
      -- Diamonds arriving: top-ups, game prizes and refunds, positive corrections.
      SELECT t.id AS transaction_id,
             t.reference,
             t.created_at AS occurred_at,
             t.type AS movement_type,
             t.status,
             t.room_id,
             t.sender_id,
             t.receiver_id,
             t.note,
             t.receiver_id AS owner_id,
             'dmn'  AS unit,
             'IN'   AS direction,
             CASE WHEN t.type IN ('GIFT_SENT', 'AGENCY_COMMISSION') THEN 0
                  WHEN t.type = 'ADMIN_ADJUSTMENT' THEN
                    CASE WHEN t.meta->>'diamondDelta' ~ '^-?[0-9]+$'
                         THEN GREATEST((t.meta->>'diamondDelta')::int, 0) ELSE 0 END
                  ELSE t.amount_diamonds END AS amount_minor
        FROM transactions t
       WHERE t.receiver_id IS NOT NULL
      UNION ALL
      -- R-coins arriving: the receiver's half of a gift. Never a diamond figure.
      SELECT t.id, t.reference, t.created_at, t.type, t.status, t.room_id, t.sender_id, t.receiver_id, t.note,
             t.receiver_id, 'rcn', 'IN',
             CASE WHEN t.type = 'AGENCY_COMMISSION' THEN 0
                  WHEN t.type = 'ADMIN_ADJUSTMENT' THEN
                    CASE WHEN t.meta->>'rCoinDelta' ~ '^-?[0-9]+$'
                         THEN GREATEST((t.meta->>'rCoinDelta')::int, 0) ELSE 0 END
                  ELSE t.amount_r_coins END
        FROM transactions t
       WHERE t.receiver_id IS NOT NULL
      UNION ALL
      -- Diamonds leaving: gifts sent, store items, seat fees, entries, clawbacks.
      SELECT t.id, t.reference, t.created_at, t.type, t.status, t.room_id, t.sender_id, t.receiver_id, t.note,
             t.sender_id, 'dmn', 'OUT',
             CASE WHEN t.type = 'ADMIN_ADJUSTMENT' THEN 0 ELSE t.amount_diamonds END
        FROM transactions t
       WHERE t.sender_id IS NOT NULL
      UNION ALL
      -- R-coins leaving: withdrawals, once paid. The gift row's other leg, so it is excluded.
      SELECT t.id, t.reference, t.created_at, t.type, t.status, t.room_id, t.sender_id, t.receiver_id, t.note,
             t.sender_id, 'rcn', 'OUT',
             CASE WHEN t.type = 'GIFT_SENT' THEN 0 ELSE t.amount_r_coins END
        FROM transactions t
       WHERE t.sender_id IS NOT NULL
      UNION ALL
      -- A downward correction is an OUT leg on a row whose only side is the receiver, so it
      -- needs its own branch: without it a clawback reads as though the diamonds were never
      -- taken, and the account's balance then looks unexplained. Proved against a live account
      -- whose 3,203,900 clawback disappeared from the first version of this view.
      SELECT t.id, t.reference, t.created_at, t.type, t.status, t.room_id, t.sender_id, t.receiver_id, t.note,
             t.receiver_id, 'dmn', 'OUT',
             CASE WHEN t.meta->>'diamondDelta' ~ '^-?[0-9]+$'
                  THEN -LEAST((t.meta->>'diamondDelta')::int, 0) ELSE 0 END
        FROM transactions t
       WHERE t.receiver_id IS NOT NULL AND t.type = 'ADMIN_ADJUSTMENT'
      UNION ALL
      SELECT t.id, t.reference, t.created_at, t.type, t.status, t.room_id, t.sender_id, t.receiver_id, t.note,
             t.receiver_id, 'rcn', 'OUT',
             CASE WHEN t.meta->>'rCoinDelta' ~ '^-?[0-9]+$'
                  THEN -LEAST((t.meta->>'rCoinDelta')::int, 0) ELSE 0 END
        FROM transactions t
       WHERE t.receiver_id IS NOT NULL AND t.type = 'ADMIN_ADJUSTMENT'
     ) AS legs
 WHERE amount_minor > 0;

COMMENT ON VIEW coin_movements IS
  'Every coin leg of every ledger row, attributed to one owner, with the GIFT_SENT cross-leg and the ADMIN_ADJUSTMENT sign already resolved.';

-- ---------------------------------------------------------------------------
-- purpose_account_balances — the derived view every read goes through
--
-- Column meanings, because they are not the same for every category and a report that treats
-- them as one number will be wrong:
--   available  what the owner can spend or withdraw right now. Only the three categories with
--              a spendable balance are ever non-zero here; a payable is not spendable.
--   balance    the account's position. For a journal-derived account this is its normal-side
--              net, which for an agency is what it has earned and not yet taken.
--   pending    earmarked and not yet paid: open withdrawals for a host, accrued-unsettled
--              commission for a BD or seller, non-freeze holds elsewhere.
--   approved   accepted as a batch and awaiting payment (BD and seller only — section 2 of the
--              brief asks for pending and approved precisely because neither is collectable).
--   frozen     the sum of open FROZEN holds.
--
-- `source_row_present` is the reconciliation signal that belongs in the schema: the
-- authoritative row a balance claims to read still exists. Numeric drift between an account
-- and its source is a service-level check, because only the service knows the unit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW purpose_account_balances AS
WITH holds AS (
  SELECT account_code,
         COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'FROZEN'), 0)        AS frozen_minor,
         COALESCE(SUM(amount_minor) FILTER (WHERE kind <> 'FROZEN'), 0)       AS earmarked_minor
    FROM account_holds
   WHERE status = 'OPEN'
   GROUP BY account_code
),
coin AS (
  SELECT id AS owner_id, diamond_balance, r_coin_balance, created_at
    FROM users
),
open_withdrawals AS (
  SELECT user_id,
         COALESCE(SUM(amount_r_coins), 0) AS awaiting_payout,
         MAX(created_at) AS last_at
    FROM withdrawal_requests
   WHERE status IN ('PENDING', 'APPROVED')
   GROUP BY user_id
),
-- Lifetime totals per user. The leg rules — GIFT_SENT's cross-leg, ADMIN_ADJUSTMENT's signed
-- meta, AGENCY_COMMISSION's notional amount — are resolved once, in `coin_movements` above, so
-- this view and the account statement can never disagree about what a transaction did.
--
-- A PENDING withdrawal is escrow, not an outflow, so `status = 'COMPLETED'` excludes it here
-- and it surfaces in pending_minor instead. That pairing is the invariant the two must hold to
-- reconcile, because the current ledger already deducted it from `r_coin_balance`.
flows AS (
  SELECT owner_id,
         COALESCE(SUM(amount_minor) FILTER (WHERE unit = 'dmn' AND direction = 'IN'),  0) AS diamonds_in,
         COALESCE(SUM(amount_minor) FILTER (WHERE unit = 'rcn' AND direction = 'IN'),  0) AS rcoins_in,
         COALESCE(SUM(amount_minor) FILTER (WHERE unit = 'dmn' AND direction = 'OUT'), 0) AS diamonds_out,
         COALESCE(SUM(amount_minor) FILTER (WHERE unit = 'rcn' AND direction = 'OUT'), 0) AS rcoins_out,
         MIN(occurred_at) AS first_at,
         MAX(occurred_at) AS last_at
    FROM coin_movements
   WHERE status = 'COMPLETED'
   GROUP BY owner_id
),
-- What the platform owes a partner. Reversal semantics come from 0007, not 0004: a refund is
-- a status change on the original accrual because a mirrored row would collide with the very
-- UNIQUE (order, beneficiary, kind) that stops a commission being paid twice. So a REVERSED
-- line contributes nothing rather than something negative, and REJECTED never counted at all.
payable AS (
  SELECT beneficiary_id AS owner_id, beneficiary,
         COALESCE(SUM(amount_cents) FILTER (WHERE status = 'ACCRUED'), 0)  AS accrued_open_minor,
         COALESCE(SUM(amount_cents) FILTER (WHERE status IN ('ACCRUED', 'SETTLED')), 0) AS accrued_all_minor,
         COALESCE(SUM(amount_cents) FILTER (WHERE status = 'REVERSED'), 0) AS reversed_minor,
         MIN(created_at) AS first_at,
         MAX(created_at) AS last_at
    FROM commission_entries
   WHERE beneficiary_id IS NOT NULL
   GROUP BY beneficiary_id, beneficiary
),
batches AS (
  SELECT beneficiary_id AS owner_id, beneficiary,
         COALESCE(SUM(amount_cents) FILTER (WHERE status IN ('DRAFT', 'APPROVED')), 0) AS approved_open_minor,
         COALESCE(SUM(amount_cents) FILTER (WHERE status = 'PAID'), 0)                 AS paid_out_minor,
         MAX(updated_at) AS last_at
    FROM commission_settlements
   WHERE status <> 'VOID'
   GROUP BY beneficiary_id, beneficiary
),
journal AS (
  SELECT l.account_code,
         COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'DEBIT'), 0)  AS debits_minor,
         COALESCE(SUM(l.amount_cents) FILTER (WHERE l.direction = 'CREDIT'), 0) AS credits_minor,
         MIN(e.occurred_at) AS first_at,
         MAX(e.occurred_at) AS last_at
    FROM fin_journal_lines l
    JOIN fin_journal_entries e ON e.id = l.entry_id
   GROUP BY l.account_code
),
users_present  AS (SELECT id AS owner_id FROM users),
business_present AS (SELECT id AS owner_id FROM business_accounts),
agencies_present AS (SELECT id AS owner_id FROM agencies)
SELECT
  a.code AS account_code,
  a.name,
  a.category,
  a.owner_kind,
  a.owner_id,
  a.currency,
  a.status,
  a.balance_source,
  CASE
    WHEN a.category = 'USER_DIAMOND' THEN COALESCE(c.diamond_balance, 0)::bigint
    WHEN a.category = 'HOST_RCOIN'   THEN COALESCE(c.r_coin_balance, 0)::bigint
    -- An agency's position is collectable even though nothing writes to it yet; forcing that
    -- to zero would report the platform's gap as a fact about the agency.
    WHEN a.category = 'AGENCY'       THEN CASE a.normal_side WHEN 'DEBIT' THEN COALESCE(j.debits_minor, 0) - COALESCE(j.credits_minor, 0)
                                                             ELSE COALESCE(j.credits_minor, 0) - COALESCE(j.debits_minor, 0) END
    ELSE 0::bigint
  END AS available_minor,
  -- The account's whole position. For a source-derived account that is what the owner holds
  -- plus what is earmarked for them; for a journal account it is the normal-side net.
  CASE
    WHEN a.category = 'USER_DIAMOND' THEN COALESCE(c.diamond_balance, 0)::bigint
    WHEN a.category = 'HOST_RCOIN'   THEN COALESCE(c.r_coin_balance, 0)::bigint + COALESCE(ow.awaiting_payout, 0)::bigint
    WHEN a.category IN ('BD_MANAGER', 'COIN_SELLER') THEN COALESCE(p.accrued_all_minor, 0) - COALESCE(b.paid_out_minor, 0)
    WHEN a.normal_side = 'DEBIT'  THEN COALESCE(j.debits_minor, 0) - COALESCE(j.credits_minor, 0)
    ELSE COALESCE(j.credits_minor, 0) - COALESCE(j.debits_minor, 0)
  END AS balance_minor,
  CASE
    WHEN a.category = 'HOST_RCOIN'  THEN COALESCE(ow.awaiting_payout, 0)::bigint
    WHEN a.category IN ('BD_MANAGER', 'COIN_SELLER') THEN COALESCE(p.accrued_open_minor, 0)
    ELSE COALESCE(h.earmarked_minor, 0)
  END AS pending_minor,
  CASE WHEN a.category IN ('BD_MANAGER', 'COIN_SELLER') THEN COALESCE(b.approved_open_minor, 0)
       ELSE 0::bigint END AS approved_minor,
  COALESCE(h.frozen_minor, 0) AS frozen_minor,
  CASE
    WHEN a.category = 'USER_DIAMOND' THEN COALESCE(f.diamonds_in, 0)::bigint
    WHEN a.category = 'HOST_RCOIN'   THEN COALESCE(f.rcoins_in, 0)::bigint
    WHEN a.category IN ('BD_MANAGER', 'COIN_SELLER') THEN COALESCE(p.accrued_all_minor, 0) + COALESCE(p.reversed_minor, 0)
    WHEN a.normal_side = 'DEBIT'  THEN COALESCE(j.debits_minor, 0)
    ELSE COALESCE(j.credits_minor, 0)
  END AS lifetime_in_minor,
  CASE
    WHEN a.category = 'USER_DIAMOND' THEN COALESCE(f.diamonds_out, 0)::bigint
    WHEN a.category = 'HOST_RCOIN'   THEN COALESCE(f.rcoins_out, 0)::bigint
    -- Gross of reversals on both sides: an accrual that was credited and then taken back belongs
    -- in a lifetime total, and putting it on only one side would move the balance it cannot move.
    WHEN a.category IN ('BD_MANAGER', 'COIN_SELLER') THEN COALESCE(b.paid_out_minor, 0) + COALESCE(p.reversed_minor, 0)
    WHEN a.normal_side = 'DEBIT'  THEN COALESCE(j.credits_minor, 0)
    ELSE COALESCE(j.debits_minor, 0)
  END AS lifetime_out_minor,
  CASE
    WHEN a.owner_kind = 'USER'     THEN up.owner_id IS NOT NULL
    WHEN a.owner_kind = 'BUSINESS' THEN bp.owner_id IS NOT NULL
    WHEN a.owner_kind = 'AGENCY'   THEN ap.owner_id IS NOT NULL
    ELSE TRUE
  END AS source_row_present,
  CASE
    WHEN a.owner_kind = 'USER'     THEN LEAST(c.created_at, COALESCE(f.first_at, c.created_at), a.created_at)
    WHEN a.owner_kind = 'BUSINESS' THEN COALESCE(p.first_at, a.created_at)
    ELSE COALESCE(j.first_at, a.created_at)
  END AS opened_at,
  -- The most recent thing the account can prove happened, from whichever source it reads.
  CASE
    WHEN a.category = 'USER_DIAMOND' THEN GREATEST(f.last_at, c.created_at, a.updated_at)
    WHEN a.category = 'HOST_RCOIN'   THEN GREATEST(f.last_at, ow.last_at, c.created_at, a.updated_at)
    WHEN a.owner_kind = 'BUSINESS'   THEN GREATEST(p.last_at, b.last_at, a.updated_at)
    ELSE COALESCE(j.last_at, a.updated_at)
  END AS last_activity_at
FROM fin_accounts a
LEFT  JOIN holds h             ON h.account_code = a.code
LEFT  JOIN coin c              ON c.owner_id = a.owner_id AND a.owner_kind = 'USER'
LEFT  JOIN open_withdrawals ow ON ow.user_id = a.owner_id
LEFT  JOIN flows f             ON f.owner_id = a.owner_id
LEFT  JOIN payable p           ON p.owner_id = a.owner_id
                             AND ((a.category = 'BD_MANAGER' AND p.beneficiary = 'BD')
                               OR (a.category = 'COIN_SELLER' AND p.beneficiary = 'SELLER'))
LEFT  JOIN batches b           ON b.owner_id = a.owner_id
                             AND ((a.category = 'BD_MANAGER' AND b.beneficiary = 'BD')
                               OR (a.category = 'COIN_SELLER' AND b.beneficiary = 'SELLER'))
LEFT  JOIN journal j           ON j.account_code = a.code
LEFT  JOIN users_present up    ON up.owner_id = a.owner_id
LEFT  JOIN business_present bp ON bp.owner_id = a.owner_id
LEFT  JOIN agencies_present ap ON ap.owner_id = a.owner_id;

COMMENT ON VIEW purpose_account_balances IS
  'One row per purpose account. Available, pending, approved and frozen are derived from the '
  'account''s authoritative source, never stored beside it.';
