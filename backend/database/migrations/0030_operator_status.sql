-- 0030_operator_status.sql — an operator is switched off, never deleted.
--
-- Two facts about the schema that existed before this file decided the shape of the operator
-- lifecycle:
--
--   * `admin_audit.admin_id` is `REFERENCES admins(id) ON DELETE SET NULL`, and
--     `admin_audit_actor_present` then requires every audit row to still name an actor. The FK
--     offers to erase the name and the check refuses to let it go, so deleting an operator who
--     has ever written anything fails with 23514 — `backend/scripts/account-e2e.cjs` pins that
--     behaviour. A delete is therefore not an option for the one account type that has touched
--     money, and pretending otherwise in a UI would offer a button that can only ever error.
--   * The twelve-hour operator token is signed, not session-backed, so a row that says
--     "inactive" has to be read on every request for disabling to mean anything. That read
--     already happens (`requireAdminOperator` re-reads the operator row because the role inside
--     the token is who they were at sign-in), so this column is enforced by the same path the
--     role is, rather than by a new one.
--
-- So this adds a switch, not a bin. `disabled_at` is the timestamp the audit trail will be
-- asked about; attribution of *who* switched it off stays in `admin_audit`, where the history
-- of an action lives, rather than in one overwritten column on the row.
--
-- The biconditional is the part that matters: a row that is active with a disabled time, or
-- inactive without one, is a record nobody can interpret, and both are reachable by a service
-- that writes one field and forgets the other.

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

ALTER TABLE admins
  DROP CONSTRAINT IF EXISTS admins_disabled_flag_matches_timestamp;

ALTER TABLE admins
  ADD CONSTRAINT admins_disabled_flag_matches_timestamp
  CHECK (is_active = (disabled_at IS NULL));
