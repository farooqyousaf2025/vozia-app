-- The member behind a seller / BD account: one owner link, and the marker their approval earns.
--
-- An approved COIN_SELLER or BD_MANAGER application (0035) creates a `business_accounts` row, but
-- until now nothing on that row named the member who applied. The only connection was
-- `role_applications.business_account_id`, which the partner queue reads and the desk does not:
-- the operational surface (/api/business) signs in with a code and password the operations team
-- issued, so the Android app — which holds a member session, not a partner credential — had no way
-- to open the seller's or BD's own book.
--
-- `agencies.owner_user_id` (0035) already answers exactly this question for an agency, and
-- `requireAgencyOwner` resolves the caller's agency from it on every request. This migration gives
-- business accounts the same column so the same pattern can serve the partner desk: the member's
-- token is the credential, the database decides which account is theirs, and no id in a path or a
-- body can name somebody else's book.
--
-- One column, one index, one backfill
-- -----------------------------------
-- `owner_user_id` is nullable: accounts created by an operator before the application flow existed
-- (0004) have no applicant to name, and they keep working through the code+password sign-in exactly
-- as before. ON DELETE SET NULL rather than CASCADE — deleting a member must not delete the account
-- that holds the platform's cash book; it only unlinks the desk.
--
-- The backfill reads the grant that is actually live: APPROVED, never revoked, pointing at a
-- business account. DISTINCT ON keeps the first approval if an account was somehow named by two
-- applications, and the `owner_user_id IS NULL` guard makes the whole migration re-runnable without
-- ever overwriting a link a later approval wrote. Revoked grants are excluded, and revocation
-- already suspends the account itself (partner-application.service), so the desk's ACTIVE gate
-- refuses a revoked partner even where a stale link survives.
--
-- The account type the member is shown as
-- ---------------------------------------
-- `users.user_type` gains the three partner kinds. It stays a display marker — no gate reads it as
-- proof of a privilege (the grant row and the account row are the authority) — but an approved
-- seller should read as a seller, not as the HOST the old approval path mistakenly wrote. The
-- earning engine's eligibility CHECK is widened to match, so a rule may name the new markers
-- instead of silently paying nobody; `earning-rule.service.ts` validates against the same list.
--
-- The marker backfill itself lives in 0047: this runner applies each file inside one transaction,
-- and PostgreSQL forbids *using* an enum value in the same transaction that added it.
--
-- What this does NOT do
-- ---------------------
-- No balance moves, no status changes, no new credential. The code+password login keeps its own
-- semantics (including last_login_at); the member-session desk only reads the row. Nothing here
-- grants a permission: what the account may do still comes from its kind (rbac.service), exactly as
-- it does on /api/business.
-- ---------------------------------------------------------------------------

ALTER TABLE business_accounts
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS business_accounts_owner_idx
  ON business_accounts (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

UPDATE business_accounts b
   SET owner_user_id = ra.user_id
  FROM (
    SELECT DISTINCT ON (business_account_id) business_account_id, user_id
      FROM role_applications
     WHERE status = 'APPROVED'
       AND revoked_at IS NULL
       AND business_account_id IS NOT NULL
     ORDER BY business_account_id, created_at
  ) ra
 WHERE ra.business_account_id = b.id
   AND b.owner_user_id IS NULL;

ALTER TYPE user_type ADD VALUE IF NOT EXISTS 'COIN_SELLER';
ALTER TYPE user_type ADD VALUE IF NOT EXISTS 'BD_MANAGER';
ALTER TYPE user_type ADD VALUE IF NOT EXISTS 'BD_AGENT';

-- 0038 left this CHECK unnamed, so find it by its definition rather than by a generated name that
-- depends on how many other constraints the table happened to carry that day.
DO $$
DECLARE
  existing TEXT;
BEGIN
  SELECT conname INTO existing
    FROM pg_constraint
   WHERE conrelid = 'earning_rules'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%eligible_user_types%'
   LIMIT 1;

  IF existing IS NOT NULL AND existing <> 'earning_rules_user_types_check' THEN
    EXECUTE format('ALTER TABLE earning_rules DROP CONSTRAINT %I', existing);
    existing := NULL;
  END IF;

  IF existing IS NULL THEN
    ALTER TABLE earning_rules
      ADD CONSTRAINT earning_rules_user_types_check
      CHECK (eligible_user_types <@ ARRAY['HOST', 'USER', 'AGENCY_ADMIN', 'COIN_SELLER', 'BD_MANAGER', 'BD_AGENT']::text[]);
  END IF;
END $$;