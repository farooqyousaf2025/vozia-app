-- 0032 — a withdrawal is not paid because the book said so.
--
-- The pipeline had three states and used two of them. A host asks for R-coins, the escrow leaves
-- `users.r_coin_balance` at that moment, an operator approves the request, and the same approval
-- flips the `transactions` row of type WITHDRAWAL to COMPLETED — which is the ledger saying the
-- money went out, with no row anywhere that says who sent it, when, or under what reference. The
-- database enum has had `PAID` since schema.sql:56; nothing has ever written it.
--
-- That gap is not cosmetic. `purpose_account_balances` reports an open withdrawal as `pending`
-- (PENDING or APPROVED) while `coin_movements` counts the outflow only from a COMPLETED ledger row,
-- so the moment the old approval ran, the same R-coins were both still owed and already gone: the
-- account's `opening + ΣIN − ΣOUT` identity started disagreeing by exactly that amount, and the
-- reconciler reported the disagreement as an unexplained opening rather than as the missing step it
-- was. `GET /api/admin/accounts/reconcile` named the second half directly —
-- `withdrawal_paid_step_missing`, an ERROR on every approved withdrawal in the system.
--
-- So the outflow is recognised where the money actually leaves: approval means "we will pay this",
-- payment means "this was sent", and payment needs evidence. A payout reference is what makes the
-- row defensible to the host who calls a week later, which is why it is a column with a constraint
-- rather than a note in `payout_details` that any update can overwrite. The R-coins the platform
-- keeps as its fee become a journal entry, priced like every other coin take by the face value
-- 0031 introduced.
--
-- `fee_r_coins` is stored at request time rather than derived at payment, so the number the host was
-- shown when they tapped Withdraw is the number the platform charges even if the dial moves while
-- the request sits in the queue. `minRCoins` and `feeBps` themselves live in `system_config`
-- (`accounts.withdrawal`, seeded by 0029 with the note "Replaces the MIN_WITHDRAW_RCOINS environment
-- variable once the ledger reads this"); this is the change that lets the ledger read it.

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS fee_r_coins INT NOT NULL DEFAULT 0;

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS paid_by UUID REFERENCES admins (id) ON DELETE SET NULL;

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS payout_reference VARCHAR(120);

ALTER TABLE withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_fee_within_amount;

ALTER TABLE withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_fee_within_amount
  CHECK (fee_r_coins >= 0 AND fee_r_coins <= amount_r_coins);

-- The state and its evidence cannot disagree. `paid_by` is deliberately absent: the audit trail
-- records who pressed Pay, and an operator account that is later disabled must not blank a payment
-- that happened.
ALTER TABLE withdrawal_requests
  DROP CONSTRAINT IF EXISTS withdrawal_requests_paid_step_evidence;

ALTER TABLE withdrawal_requests
  ADD CONSTRAINT withdrawal_requests_paid_step_evidence
  CHECK (status <> 'PAID' OR (paid_at IS NOT NULL AND payout_reference IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Restate history the way the ledger already describes it.
--
-- An APPROVED request whose WITHDRAWAL row is COMPLETED is a payout that was booked but never
-- recorded. Reverting the ledger row to PENDING would rewrite what the wallet already did — the
-- R-coins left the host's balance when they asked, and `transactions` is the append-only record of
-- that — so the request row is the one that moves. `paid_at` takes the approval timestamp because
-- that is the last time the system genuinely knew anything, and the reference says plainly that it
-- is a restatement rather than a bank identifier.
-- ---------------------------------------------------------------------------
UPDATE withdrawal_requests w
   SET status = 'PAID'::withdrawal_status,
       paid_at = COALESCE(w.reviewed_at, w.created_at),
       paid_by = w.reviewed_by,
       payout_reference = 'restated by migration 0032: ledger row already COMPLETED'
  FROM transactions t
 WHERE t.type = 'WITHDRAWAL'
   AND t.status = 'COMPLETED'
   AND t.meta->>'withdrawalId' = w.id::text
   AND w.status = 'APPROVED';
