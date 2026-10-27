-- 0005_business_audit.sql — make the business domain attributable and readable.
--
-- 0004 created the books; this adds the two things every mutation in them needs: a way to
-- name a BD/seller actor in the audit trail (0003 only had `admin_id`, and a coin seller is
-- deliberately not an admin), and the joined view the finance report is built on.

ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES business_accounts (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS admin_audit_business_idx ON admin_audit (business_id, created_at DESC);

-- An audit row now has two possible actors; exactly one of them must be set, or the entry
-- records nothing but the action.
ALTER TABLE admin_audit DROP CONSTRAINT IF EXISTS admin_audit_actor_present;
ALTER TABLE admin_audit ADD CONSTRAINT admin_audit_actor_present CHECK (admin_id IS NOT NULL OR business_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- business_recharge_report — one row per recharge order, with the money already split.
--
-- §25 asks for collections, coin issuance, provider fees, seller commission, BD commission
-- and platform revenue to be separately identifiable. They are named here rather than left
-- to be re-derived in the panel, because the derivation is the part that goes wrong.
-- ---------------------------------------------------------------------------
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
  -- A reversal is stored as its own positive row pointing back at what it cancels, so the
  -- readable figure is the signed sum, not a sum minus another sum.
  COALESCE(SUM(CASE WHEN ce.reversal_of_id IS NOT NULL THEN -ce.amount_cents ELSE ce.amount_cents END)
           FILTER (WHERE ce.beneficiary = 'SELLER' AND ce.status <> 'REJECTED'), 0)
    AS seller_commission_cents,
  COALESCE(SUM(CASE WHEN ce.reversal_of_id IS NOT NULL THEN -ce.amount_cents ELSE ce.amount_cents END)
           FILTER (WHERE ce.beneficiary = 'BD' AND ce.status <> 'REJECTED'), 0)
    AS bd_commission_cents,
  -- What the platform keeps is what it collected, less the provider fee it paid to collect
  -- it and less every partner share it owes. Nothing here is a coin balance.
  o.amount_cents - o.fee_cents
    - COALESCE(SUM(CASE WHEN ce.reversal_of_id IS NOT NULL THEN -ce.amount_cents ELSE ce.amount_cents END)
               FILTER (WHERE ce.beneficiary IN ('SELLER','BD') AND ce.status <> 'REJECTED'), 0)
    AS platform_revenue_cents,
  COUNT(ce.id) FILTER (WHERE ce.status <> 'REJECTED') AS commission_entry_count
FROM recharge_orders o
  JOIN business_accounts s ON s.id = o.seller_id
  LEFT JOIN business_accounts b ON b.id = o.bd_id
  JOIN users u ON u.id = o.user_id
  LEFT JOIN commission_entries ce ON ce.recharge_order_id = o.id
GROUP BY
  o.id, s.id, s.code, s.display_name, b.id, b.code, b.display_name, u.id, u.username;
