-- 0011_reversal_keeps_its_ledger_row.sql — a reversed order must still point at the coins.
--
-- 0004 wrote "transaction_id is set only while the order is CREDITED", which reads tidy and is
-- wrong: reversing an order means posting a compensating debit against the very ledger row the
-- credit created. If the reference is cleared, the reversal points at nothing and the audit
-- trail breaks exactly where finance needs it most. The real rule is that a ledger reference
-- appears when the coins go out and stays for the rest of the order's life.
--
-- The old constraint is dropped by reading its definition rather than its generated name,
-- because PostgreSQL numbers unnamed CHECKs and the number is not ours to guess.

DO $mig$
DECLARE old_constraint text;
BEGIN
  SELECT conname INTO old_constraint
    FROM pg_constraint
   WHERE conrelid = 'recharge_orders'::regclass
     AND contype = 'c'
     AND replace(pg_get_constraintdef(oid), ' ', '') LIKE '%transaction_idISNULL%'
     AND pg_get_constraintdef(oid) NOT LIKE '%REVERSED%';

  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE recharge_orders DROP CONSTRAINT %I', old_constraint);
  END IF;
END
$mig$;

ALTER TABLE recharge_orders ADD CONSTRAINT recharge_orders_transaction_only_after_credit
  CHECK (status IN ('CREDITED', 'REVERSED') OR transaction_id IS NULL);

-- A REVERSED row that does not say when, why, or how much is indistinguishable from a mistake.
ALTER TABLE recharge_orders DROP CONSTRAINT IF EXISTS recharge_orders_reversal_is_explained;
ALTER TABLE recharge_orders ADD CONSTRAINT recharge_orders_reversal_is_explained
  CHECK (status <> 'REVERSED' OR (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL));
