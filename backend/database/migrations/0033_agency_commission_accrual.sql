-- 0033 — an agency's commission becomes money the platform owes, not a number in a note.
--
-- `ledger.service.ts` has computed an agency share of every gift its hosts received since the first
-- version of the ledger, and written it as its own `AGENCY_COMMISSION` ledger row whose amount is
-- notional: `coin_movements` deliberately counts it as zero on both sides (0029 makes that explicit),
-- because the R-coins it describes were never taken from the host. So the row answers "what did this
-- agency contribute to", and nothing answers "what does the platform owe this agency". `agencies`
-- gained a purpose account in 0029 whose comment says exactly that — "Born ledger-authoritative,
-- because there is nothing else for one to read" — and it has read `fin_journal_lines` ever since,
-- holding zero for every agency on the platform while the ledger rows it should be derived from piled
-- up underneath it.
--
-- This closes that in the only way the book can: the commission coins are priced at the same
-- `accounts.coinValue` face value that 0031 introduced for gift spreads and 0032 for withdrawal fees,
-- and posted as DEBIT `COMMISSION_EXPENSE` / CREDIT `AGENCY:<agency>`. The account stops being an
-- address with nothing at it, the balance view needs no change because it already reads journal
-- debits and credits for this category, and the entry is keyed on the commission transaction so a
-- replayed gift accrues once.
--
-- Three things the accrual needs that the platform did not have before:
--
--   * A rate that can be *absent*. `agency_hosts.commission_bps` and `agencies.commission_bps` were both
--     `NOT NULL DEFAULT 1000`, so a host with no agreed rate was indistinguishable from a host agreed
--     at 10.00%, the agency's own rate could never apply, and the `accounts.agency` fallback 0029
--     seeded was unreachable by construction. Both columns become nullable. The rows set back to NULL are the ones
--     still holding exactly the old column default: no code outside `seed.sql` has ever written this
--     column, and the seeded roster carries 1500 and 1200, so a row at 1000 has never been agreed to
--     anything. On the seeded agency, whose own rate is also the shipped default, the change alters
--     no amount — it only makes the reason readable.
--   * Somewhere to record a payout. `commission_settlements` cannot hold one: `beneficiary_id`
--     references `business_accounts`, and its CHECK refuses anything but SELLER and BD. An agency is
--     neither, so `agency_settlements` is its own table, and a batch books its money line only when it
--     is PAID — which is the rule 0032 established for withdrawals, and the reason a payable here
--     still says "owed" until the transfer is recorded rather than the moment an operator raises a
--     document.
--   * Somewhere to say which accruals a batch paid. An agency has no per-entry table whose status
--     column could flip: its entries *are* journal lines, and an immutable double entry cannot carry
--     a flag. `agency_settlement_items` makes the claim instead, in the shape
--     `commission_settlement_items` uses for SELLER and BD.
--
-- The backfill below prices history rather than forgiving it, in the same shape as 0031's. Where
-- `minorPerCoin` is 0 — the operator has decided the book does not value coins — it posts nothing and
-- the reconciler reports the rows as unbooked instead of inventing a rate.

-- ---------------------------------------------------------------------------
-- 1. A rate that can be absent.
--
-- Three levels have to be expressible for a rate to mean anything: what this host agreed, what this
-- agency agreed, and what the platform falls back to. The first two were both NOT NULL DEFAULT 1000,
-- which made every one of them look agreed and the fallback unreachable. Both become nullable, and a
-- row still holding the old column default is set to NULL: no code outside `seed.sql` has ever written
-- either column, and the seeded roster carries 1500, 1200 and 1500, so a row at 1000 has never been
-- agreed to anything. Where an agency's own rate is also 1000 the applied figure does not move — the
-- change only makes the *reason* readable.
-- ---------------------------------------------------------------------------
ALTER TABLE agency_hosts ALTER COLUMN commission_bps DROP DEFAULT;
ALTER TABLE agency_hosts ALTER COLUMN commission_bps DROP NOT NULL;

ALTER TABLE agencies ALTER COLUMN commission_bps DROP DEFAULT;
ALTER TABLE agencies ALTER COLUMN commission_bps DROP NOT NULL;

UPDATE agency_hosts SET commission_bps = NULL WHERE commission_bps = 1000;
UPDATE agencies     SET commission_bps = NULL WHERE commission_bps = 1000;

-- ---------------------------------------------------------------------------
-- 2. AGENCY accounts for everyone who arrived after 0029's seed.
--
-- `fin_journal_lines.account_code` references `fin_accounts (code)`, so an accrual for an agency
-- whose account row was never opened would fail at the line rather than at the intent. 0029 seeded
-- the agencies that existed then; this is the same statement, run again, and it is the only reason it
-- has to come before the backfill.
-- ---------------------------------------------------------------------------
INSERT INTO fin_accounts (code, name, kind, currency, normal_side, category, owner_kind, owner_id, balance_source)
  SELECT 'AGENCY:' || a.id, a.name || ' — agency earnings', 'LIABILITY', 'pkr', 'CREDIT',
         'AGENCY'::account_category, 'AGENCY'::account_owner_kind, a.id, 'fin_journal_lines'
    FROM agencies a
   WHERE NOT EXISTS (SELECT 1 FROM fin_accounts f WHERE f.owner_kind = 'AGENCY' AND f.owner_id = a.id);

-- ---------------------------------------------------------------------------
-- 3. The payout record.
--
-- `settlement_status_new` is reused rather than re-invented: DRAFT is finance raising a batch,
-- APPROVED is a different operator agreeing to it, PAID is the transfer being recorded, VOID is a
-- batch nobody paid. There is no journal line before PAID, so a VOID batch never needs a reversal —
-- nothing was ever booked that could be taken back.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agency_settlements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        VARCHAR(32)  NOT NULL UNIQUE,
  agency_id        UUID         NOT NULL REFERENCES agencies (id) ON DELETE RESTRICT,
  -- An agency's payable is always valued in money, never in coins: the coins left the host's wallet
  -- and never entered anyone else's.
  currency         VARCHAR(3)   NOT NULL DEFAULT 'pkr' CHECK (currency = 'pkr'),
  amount_minor     BIGINT       NOT NULL CHECK (amount_minor > 0),
  status           settlement_status_new NOT NULL DEFAULT 'DRAFT',
  period_from      TIMESTAMPTZ  NOT NULL,
  period_to        TIMESTAMPTZ  NOT NULL,
  payout_method    VARCHAR(24),
  payout_reference VARCHAR(120),
  -- The `PENDING_SETTLEMENT` hold this batch put on the agency's account. Raised with the batch,
  -- converted when it is paid and released when it is voided, so the account's `pending` figure and
  -- this row always describe the same claim.
  hold_id          UUID REFERENCES account_holds (id) ON DELETE SET NULL,
  created_by       UUID REFERENCES admins (id) ON DELETE SET NULL,
  approved_by      UUID REFERENCES admins (id) ON DELETE SET NULL,
  paid_at          TIMESTAMPTZ,
  note             VARCHAR(200),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (period_to > period_from),
  -- A batch nobody signed off is either still being prepared or has been given up on, and VOID is
  -- the second of those: requiring an approver for it would make the only honest outcome — raise,
  -- notice the window was wrong, void — impossible to record.
  CHECK (status IN ('DRAFT', 'VOID') OR approved_by IS NOT NULL),
  CHECK (status <> 'PAID' OR (paid_at IS NOT NULL AND payout_reference IS NOT NULL)),
  -- An operator who did not raise it approves it; the same two-pairs-of-hands rule
  -- `commission_settlements` enforces in code (`self_approval`).
  CHECK (approved_by IS NULL OR created_by IS NULL OR approved_by <> created_by)
);

CREATE INDEX IF NOT EXISTS agency_settlement_agency_idx
  ON agency_settlements (agency_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Which accruals a batch claims.
--
-- `UNIQUE (entry_id)` is the whole answer to "can this commission be settled twice": the first
-- batch to claim a journal entry wins, and a concurrent second one has nowhere to write. That is
-- the same trick `commission_settlement_items` plays for SELLER and BD, and the reason the claim is
-- a table rather than a column is in the header — a journal entry cannot carry a status of its own.
--
-- A VOID batch deletes its rows here, which puts the accruals back on the table for the next batch;
-- the batch keeps its own `amount_minor` as the record of what was raised and given up.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agency_settlement_items (
  settlement_id UUID   NOT NULL REFERENCES agency_settlements (id) ON DELETE CASCADE,
  entry_id      UUID   NOT NULL REFERENCES fin_journal_entries (id) ON DELETE RESTRICT,
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  included_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (settlement_id, entry_id),
  UNIQUE (entry_id)
);

-- ---------------------------------------------------------------------------
-- 4. Backfill the accruals the ledger has already paid out in coins.
-- ---------------------------------------------------------------------------
WITH rate AS (
  SELECT COALESCE(
           (SELECT (value->>'minorPerCoin')::BIGINT FROM system_config WHERE key = 'accounts.coinValue'),
           0
         ) AS minor
),
src AS (
  SELECT 'AGENCY_COMMISSION'::VARCHAR(24) AS kind,
         t.id::TEXT                        AS source_id,
         t.amount_r_coins * r.minor        AS owed_minor,
         'AGENCY:' || t.agency_id          AS agency_code,
         left('Agency commission on ledger row ' || t.reference, 300) AS memo
    FROM transactions t, rate r
   WHERE t.type = 'AGENCY_COMMISSION'
     AND t.status = 'COMPLETED'
     AND t.agency_id IS NOT NULL
     AND t.amount_r_coins > 0
     AND r.minor > 0
),
missing AS (
  SELECT s.*
    FROM src s
   WHERE NOT EXISTS (
     SELECT 1 FROM fin_journal_entries e
      WHERE e.source_kind = s.kind AND e.source_id = s.source_id
   )
),
entries AS (
  INSERT INTO fin_journal_entries (reference, source_kind, source_id, memo, currency)
       SELECT 'JR-BF-' || substr(md5(m.kind || m.source_id), 1, 24), m.kind, m.source_id, m.memo, 'pkr'
         FROM missing m
  RETURNING id, source_kind, source_id
)
INSERT INTO fin_journal_lines (entry_id, account_code, direction, amount_cents, currency)
       SELECT e.id, 'COMMISSION_EXPENSE', 'DEBIT'::fin_direction, m.owed_minor, 'pkr'
         FROM entries e JOIN missing m ON m.kind = e.source_kind AND m.source_id = e.source_id
        WHERE m.owed_minor > 0
       UNION ALL
       SELECT e.id, m.agency_code, 'CREDIT'::fin_direction, m.owed_minor, 'pkr'
         FROM entries e JOIN missing m ON m.kind = e.source_kind AND m.source_id = e.source_id
        WHERE m.owed_minor > 0;
