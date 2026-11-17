-- 0041 — payment receipts: the document a manual settlement is judged on.
--
-- Money between a member and a coin seller does not travel through the platform's rails. The
-- programme settled that on 2026-11-09: coins are bought from a seller and R-coins are sold to
-- one, and the cash is handed over outside the app, the same way a withdrawal is paid from a
-- bank screen nobody scripts can see. That leaves the platform with one question it cannot
-- answer from its own database — did the cash actually move? — and a receipt is the artefact a
-- human uses to answer it.
--
-- So a receipt is evidence, never a trigger. Nothing in this file credits coins, expires, or
-- replaces `AWAITING_VERIFICATION`; it gives the finance operator something to look at before
-- they make the decision they were always going to make. The order still moves on a person's
-- approval, which is the rule that keeps "the seller says it is paid" from being a payment.
--
-- ---------------------------------------------------------------------------
-- Why this is its own table and not another media_assets row
-- ---------------------------------------------------------------------------
-- `media_assets` is the operator's art library and it has two properties that are exactly wrong
-- for a bank slip. Its `uploaded_by` is `UUID REFERENCES admins (id)`, and a coin seller is
-- deliberately NOT in `admins` (see 0004: putting a partner credential there would make every
-- `requireAdmin` route reachable with it). And its bytes live under `/uploads`, which `app.ts`
-- mounts with `express.static` and no authentication — harmless for a gift icon, not for a
-- screenshot showing a name and an account number. Files written here are served only through
-- routes that check a permission, and nothing in the media library can delete them.

CREATE TABLE IF NOT EXISTS payment_receipts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The money record this document belongs to. Exactly one: a receipt uploaded against
  -- something else is not evidence for anything.
  order_id      UUID REFERENCES recharge_orders (id) ON DELETE RESTRICT,
  withdrawal_id UUID REFERENCES withdrawal_requests (id) ON DELETE RESTRICT,
  -- Who handed it over. On a recharge this is that order's seller; on a withdrawal it is the
  -- seller the member chose to buy their R-coins, so the uploader is always the one who is
  -- supposed to have moved the cash.
  uploaded_by   UUID NOT NULL REFERENCES business_accounts (id) ON DELETE RESTRICT,
  -- Kept only so a queue can show what the file was called. Never used to build a path, and
  -- never trusted: the type and the byte budget below come from the bytes themselves.
  file_name     VARCHAR(120) NOT NULL,
  stored_name   VARCHAR(80)  NOT NULL UNIQUE,
  content_type  VARCHAR(64)  NOT NULL,
  byte_size     INTEGER      NOT NULL CHECK (byte_size > 0),
  sha256        CHAR(64)     NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(order_id, withdrawal_id) = 1)
);

-- Both queues read by their own target, newest first.
CREATE INDEX IF NOT EXISTS payment_receipts_order_idx
  ON payment_receipts (order_id, created_at DESC) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_receipts_withdrawal_idx
  ON payment_receipts (withdrawal_id, created_at DESC) WHERE withdrawal_id IS NOT NULL;
-- The same photograph attached to the same order twice is one document, not two.
CREATE UNIQUE INDEX IF NOT EXISTS payment_receipts_order_sha_idx
  ON payment_receipts (order_id, sha256) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_receipts_withdrawal_sha_idx
  ON payment_receipts (withdrawal_id, sha256) WHERE withdrawal_id IS NOT NULL;

COMMENT ON TABLE payment_receipts IS 'Bank slips and transfer screenshots for manual settlements, written by coin sellers and read only through permission-checked routes. Evidence for a human; never a trigger for a credit.';
COMMENT ON COLUMN payment_receipts.stored_name IS 'Server-chosen file name under the receipts directory, which express never serves statically.';
COMMENT ON COLUMN payment_receipts.sha256 IS 'Content hash, used to refuse the same document twice on one record. Not a signature — nothing here is trusted because it matches.';

-- ---------------------------------------------------------------------------
-- The seller the member chose for an R-coin payout
-- ---------------------------------------------------------------------------
-- A member who sells R-coins to a coin seller is still taking money out of the platform, so the
-- record stays `withdrawal_requests`: the fee dial decided at request time, the `payout_reference`
-- the host's phone call is answered with, and the `withdrawal:review` permission that releases it
-- are all already there, and a second cash-out door would have needed all three again.
--
-- `payout_method` is a plain VARCHAR(24) with no CHECK (only the controller's enum has ever
-- constrained it), so 'SELLER' needs no migration. This column does, because "which seller" is an
-- authority question, not a free-text one: it is what lets the payout queue say whose receipt is
-- missing without reading a JSON blob, and it is what refuses a receipt from a seller who was
-- never assigned the request.
ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS seller_id UUID REFERENCES business_accounts (id) ON DELETE SET NULL;

-- The queue a seller opens is "payouts waiting on me", which is this partial index.
CREATE INDEX IF NOT EXISTS withdrawal_seller_pending_idx
  ON withdrawal_requests (seller_id, status, created_at DESC) WHERE seller_id IS NOT NULL;

COMMENT ON COLUMN withdrawal_requests.seller_id IS 'Migration 0041: the coin seller who agreed to pay this member in cash. NULL on every rail the platform pays directly.';
