-- Master agencies and sub-agencies: one parent link, one allocation rate.
--
-- The delivery brief asks for a Master Agency that registers hosts, manages sub-agency
-- relationships and sees "Sub-Agency allocation", and a Sub-Agency that sees its own hosts and
-- "its own commission allocation" while being refused the master's screens. Until now `agencies`
-- was flat: every agency was a top-level roster, and the only hierarchy in the product was the
-- BD/seller one in `business_accounts` (0004, corrected by 0006).
--
-- Two columns express the whole relationship
-- -----------------------------------------
-- `parent_agency_id` is the relationship. NULL means master; a value means sub. There is deliberately
-- no `kind` column beside it: a stored kind and a stored parent can disagree, and the screen that
-- read the kind would then promise a permission the link does not give. Kind is derived, exactly as
-- the QA marking in 0039 derives a money row's status from its owners instead of copying a flag.
--
-- `parent_override_bps` is the allocation: the share of *this sub-agency's* accrued commission that
-- its master keeps. It lives on the sub, not on the master, for the same reason
-- `agency_hosts.commission_bps` lives on the membership — two subs under one master are two
-- negotiations, and a single dial on the master could not say that. NULL and 0 both mean the master
-- takes nothing, but they are not the same decision: NULL is "no override was ever agreed", 0 is
-- "agreed, and it is nothing". The column is only meaningful on a sub; the trigger refuses it on a
-- master, because a master has no parent to give a share to.
--
-- Depth is two, and the database says so
-- --------------------------------------
-- The brief names exactly two levels. A CHECK cannot read the parent row, so — following 0006 — the
-- rule is a trigger: a parent must itself be a master, which makes a grandchild impossible and a
-- cycle unreachable. The one shape that rule alone does not catch is demoting an agency that already
-- has children, so the trigger checks that too. Suspending a master is not blocked here: suspension
-- is a decision about that agency, and the existing gift path does not read agency status when it
-- accrues, so this migration does not quietly change what a suspension means.
--
-- What this does NOT do
-- ---------------------
-- No balance moves and no history is rewritten. Every existing agency keeps parent NULL, so all 20
-- rows stay masters and every commission already booked is untouched. The split itself is posted by
-- the gift path as a second balanced journal entry (DEBIT the sub's purpose account, CREDIT the
-- master's), and because `purpose_account_balances` derives an AGENCY position from journal lines
-- rather than storing one, both payables move with no view change and no second source of truth.
-- ---------------------------------------------------------------------------

ALTER TABLE agencies
  ADD COLUMN IF NOT EXISTS parent_agency_id   UUID,
  ADD COLUMN IF NOT EXISTS parent_override_bps INT;

ALTER TABLE agencies
  DROP CONSTRAINT IF EXISTS agencies_parent_override_bps_check;
ALTER TABLE agencies
  ADD CONSTRAINT agencies_parent_override_bps_check
  CHECK (parent_override_bps IS NULL OR parent_override_bps BETWEEN 0 AND 10000);

-- RESTRICT, not SET NULL: deleting a master must not silently promote its subs to masters and
-- erase the allocation they were negotiated under. Nothing in the product deletes an agency today
-- (revoke suspends it), so this costs no existing behaviour and closes the hole for whatever does.
ALTER TABLE agencies
  DROP CONSTRAINT IF EXISTS agencies_parent_agency_id_fkey;
ALTER TABLE agencies
  ADD CONSTRAINT agencies_parent_agency_id_fkey
  FOREIGN KEY (parent_agency_id) REFERENCES agencies (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS agencies_parent_idx
  ON agencies (parent_agency_id) WHERE parent_agency_id IS NOT NULL;

COMMENT ON COLUMN agencies.parent_agency_id IS
  'NULL = master agency. A value = sub-agency of that master. Depth is two; the trigger enforces it.';
COMMENT ON COLUMN agencies.parent_override_bps IS
  'Share of this sub-agency''s accrued commission its master keeps, in bps. NULL/0 = nothing. Only meaningful when parent_agency_id is set.';

CREATE OR REPLACE FUNCTION agency_parent_rule() RETURNS trigger AS $$
DECLARE
  parent_parent UUID;
  parent_status agency_status;
  child_count   INT;
BEGIN
  IF NEW.parent_agency_id IS NULL THEN
    IF NEW.parent_override_bps IS NOT NULL THEN
      RAISE EXCEPTION 'a master agency has no parent to give an override to (%)', NEW.name
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.parent_agency_id = NEW.id THEN
    RAISE EXCEPTION 'an agency cannot be its own master (%)', NEW.name
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT a.parent_agency_id, a.status INTO parent_parent, parent_status
    FROM agencies a WHERE a.id = NEW.parent_agency_id;
  -- The FK already refuses a missing parent; this keeps the message readable if it is ever deferred.
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'agency % has no master %', NEW.name, NEW.parent_agency_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF parent_parent IS NOT NULL THEN
    RAISE EXCEPTION 'a sub-agency cannot take sub-agencies: % is already under another agency', NEW.name
      USING ERRCODE = 'check_violation';
  END IF;

  IF parent_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a % agency cannot take sub-agencies', parent_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Demotion: an agency that already has children cannot become somebody's sub, because that would
  -- put its children at depth three without their own rows ever being validated.
  SELECT COUNT(*) INTO child_count FROM agencies WHERE parent_agency_id = NEW.id;
  IF child_count > 0 THEN
    RAISE EXCEPTION '% already has % sub-agencies and cannot itself become one', NEW.name, child_count
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agencies_parent_rule ON agencies;
CREATE TRIGGER agencies_parent_rule
  BEFORE INSERT OR UPDATE OF parent_agency_id, parent_override_bps ON agencies
  FOR EACH ROW EXECUTE FUNCTION agency_parent_rule();