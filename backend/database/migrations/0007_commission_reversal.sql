-- 0007_commission_reversal.sql — how a reversed commission is actually recorded.
--
-- 0004 gave `commission_entries` a self-referencing `reversal_of_id`, meaning a refund booked
-- a second, mirrored line. That cannot work: the key that stops the platform paying a
-- commission twice is UNIQUE (recharge_order_id, beneficiary, beneficiary_id, kind), and a
-- mirrored row has exactly those four values. A duplicate commission line is the bug; a
-- duplicate reversal line is the same bug wearing the other hat.
--
-- So a reversal is a state change on the original accrual, and the money movement it implies
-- lives in the journal, which is where every other value flow is recorded.

-- The report view reads the old column, so it has to go before the column does and come back
-- afterwards with the new definition.
DROP VIEW IF EXISTS business_recharge_report;

ALTER TABLE commission_entries DROP COLUMN IF EXISTS reversal_of_id;
ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE commission_entries ADD COLUMN IF NOT EXISTS reversal_reason VARCHAR(200);

CREATE INDEX IF NOT EXISTS commission_entry_status_idx ON commission_entries (status, created_at DESC);

-- Rebuild the report so a reversed accrual reads as zero without a mirror row.
CREATE OR REPLACE VIEW business_recharge_report AS
SELECT
  o.id,
  o.reference,
  o.status,
  o.created_at,
  o.updated_at,
  o.verified_at,
  o.diamonds,
  o.amount_cents,
  o.currency,
  o.fee_cents,
  o.payment_method,
  o.provider,
  o.external_id,
  o.transaction_id,
  o.rules_snapshot,
  s.id                AS seller_id,
  s.code              AS seller_code,
  s.display_name      AS seller_name,
  b.id                AS bd_id,
  b.code              AS bd_code,
  b.display_name      AS bd_name,
  u.id                AS user_id,
  u.username          AS username,
  COALESCE(SUM(ce.amount_cents) FILTER (WHERE ce.beneficiary = 'SELLER' AND ce.status NOT IN ('REJECTED','REVERSED')), 0)
    AS seller_commission_cents,
  COALESCE(SUM(ce.amount_cents) FILTER (WHERE ce.beneficiary = 'BD' AND ce.status NOT IN ('REJECTED','REVERSED')), 0)
    AS bd_commission_cents,
  o.amount_cents - o.fee_cents
    - COALESCE(SUM(ce.amount_cents) FILTER (WHERE ce.beneficiary IN ('SELLER','BD') AND ce.status NOT IN ('REJECTED','REVERSED')), 0)
    AS platform_revenue_cents,
  COUNT(ce.id) FILTER (WHERE ce.status NOT IN ('REJECTED','REVERSED')) AS commission_entry_count
FROM recharge_orders o
  JOIN business_accounts s ON s.id = o.seller_id
  LEFT JOIN business_accounts b ON b.id = o.bd_id
  JOIN users u ON u.id = o.user_id
  LEFT JOIN commission_entries ce ON ce.recharge_order_id = o.id
GROUP BY
  o.id, s.id, s.code, s.display_name, b.id, b.code, b.display_name, u.id, u.username;

-- The order-value ceiling has to ignore reversed accruals too, or a fully refunded order would
-- still be counted against its own collection forever.
CREATE OR REPLACE FUNCTION commission_within_order_value() RETURNS trigger AS $$
DECLARE
  accrued BIGINT;
  order_value BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_cents), 0) INTO accrued
    FROM commission_entries
   WHERE recharge_order_id = NEW.recharge_order_id
     AND status NOT IN ('REJECTED', 'REVERSED');

  SELECT amount_cents INTO order_value FROM recharge_orders WHERE id = NEW.recharge_order_id;

  IF accrued > order_value THEN
    RAISE EXCEPTION 'order % allocates % of commission against a collection of %',
      NEW.recharge_order_id, accrued, order_value
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
