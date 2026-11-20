-- 0050 — member-uploaded proof of payment for seller marketplace orders.
--
-- 0041 built the receipt table around a seller handing over a bank slip: `uploaded_by` points at
-- `business_accounts`, and that remains true for seller uploads and seller payouts. The member
-- marketplace adds the mirror image — a buyer uploads the screenshot of the cash they sent to a
-- seller — and a member id cannot be written into a business-account foreign key.
--
-- This column is additive. Existing rows keep their seller uploader, new seller uploads keep
-- writing `uploaded_by`, and member uploads write `uploaded_by_user_id` instead. The check makes
-- "who handed over these bytes?" a database fact rather than a convention, so an ambiguous or
-- anonymous receipt can never be filed. Nothing here changes the evidence rule: a receipt is still
-- read by a person, and it still never credits a coin.

ALTER TABLE payment_receipts
  ADD COLUMN IF NOT EXISTS uploaded_by_user_id UUID REFERENCES users (id) ON DELETE RESTRICT;

DO $$ BEGIN
  ALTER TABLE payment_receipts
    ADD CONSTRAINT payment_receipts_uploader_present
    CHECK (num_nonnulls(uploaded_by, uploaded_by_user_id) = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN payment_receipts.uploaded_by_user_id IS
  'Migration 0050: the member who attached proof of payment to their own marketplace order. Exactly one of uploaded_by and uploaded_by_user_id is set.';
