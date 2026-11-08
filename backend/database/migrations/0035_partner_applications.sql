-- 0035 — a privileged role is granted by an operator, never taken by an account.
--
-- Three of the four roles this product sells already had a home in the schema and none of them had
-- a front door. A coin seller or BD representative existed only as a row an operator typed into
-- `business_accounts` (`POST /api/admin/business/accounts`); an agency existed as a *roster* —
-- `agencies` plus `agency_hosts` — that no code has ever inserted into, because
-- `agency-admin.routes.ts` is read-and-rate-only; and `users.user_type` became 'HOST' as a side
-- effect of `room.service.ts:515`, which promotes whoever creates a room. That last one is the
-- reason the column cannot be trusted as a grant today: it records "has opened a room", not
-- "the platform decided this account may earn as a host".
--
-- So the application row becomes the place the decision is written down, and the row whose status is
-- `APPROVED` *is* the grant. Its status is the live state of that role for that account: an operator
-- who withdraws it moves the row to `REVOKED`, which is why the state machine has a successor to
-- `APPROVED` rather than a second table saying the same thing twice. What the approval created stays
-- where the rest of the product already reads it — `users.user_type` as a display marker, a new
-- `agencies` row, a `business_accounts` row — because those tables carry the suspension, credential
-- and settlement behaviour that already depends on them, and a fourth copy of "is this a host" is how
-- two answers to one question get written. The grant columns are pointers to whichever object this
-- approval created, and the CHECK below makes an approved application that created nothing
-- impossible to store.
--
-- Five rules are enforced by the database rather than by the service, because each is a way for the
-- queue to lie about a decision:
--   * a decided row names the operator and the moment, an undecided row names neither — asked of each
--     field separately, so a half-written row that names a reviewer but carries no timestamp is
--     refused as what it is;
--   * a rejection states its reason, an info-request states what was missing, and a revocation states
--     what it withdrew: "we looked and no" is not something an applicant can act on, and it is the
--     first thing they will call about;
--   * the grant pointers match the role — AGENCY at an agency, COIN_SELLER and BD_MANAGER at a
--     business account, HOST at neither — and they are set only by a row that was approved;
--   * one live application per (account, role), open *or granted*, so a double-tapped form, a
--     resubmitted one and a second approval are all the same single queue item. `REVOKED` and
--     `CANCELLED` sit outside that index, which is what lets an account that was turned down or
--     switched off apply again;
--   * `revoked_*` is filled exactly when the status says it is.
--
-- The live-state rule needs the partial unique index, not a check-then-insert: two concurrent POSTs
-- read "nothing live" together, and the second insert then fails on the index with 23505, which the
-- service names as a conflict. That is why no idempotency-key column was added — the shape of the row
-- already prevents the duplicate, and a replayed request key would only have duplicated it.
--
-- `roles.hostApplicationRequired` ships switched off. Turning room creation into a privilege is a
-- behaviour change for every existing account, every seeded demo host and every room fixture in the
-- suites, so it is the operator's call, not a migration's; the flag is read by the backend on each
-- create-room request and the gate lives in `room.service.ts`, next to the promotion it replaces.
-- `partner.sellerLimits` is what a newly approved coin seller starts with, so granting the role never
-- grants an unlimited account.

DO $$ BEGIN
  CREATE TYPE partner_role AS ENUM ('HOST', 'AGENCY', 'COIN_SELLER', 'BD_MANAGER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- PENDING and INFO_REQUESTED are open: the applicant still owns the row, and answering an
  -- information request returns it to PENDING for the operator to look at again.
  -- APPROVED is the live grant. REJECTED, CANCELLED and REVOKED are closed.
  CREATE TYPE application_status AS ENUM (
    'PENDING',
    'INFO_REQUESTED',
    'APPROVED',
    'REJECTED',
    'CANCELLED',
    'REVOKED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS role_applications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role                partner_role NOT NULL,
  status              application_status NOT NULL DEFAULT 'PENDING',
  -- The answers, keyed by the field names of the form spec the backend served for this role. Never a
  -- column per field: the four forms share no fields, and asking one more question should not need a
  -- schema change. Only the service's normalised output reaches this column, so a client cannot add a
  -- field by sending one.
  data                JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  -- Which version of the server's form spec the answers were accepted under. When the questions
  -- change, an old row stays readable instead of failing against a spec it was never asked.
  form_version        INT NOT NULL DEFAULT 1 CHECK (form_version > 0),
  decision_note       VARCHAR(500),
  info_request_note   VARCHAR(500),
  reviewed_by         UUID REFERENCES admins (id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  agency_id           UUID REFERENCES agencies (id) ON DELETE SET NULL,
  business_account_id UUID REFERENCES business_accounts (id) ON DELETE SET NULL,
  -- A grant is withdrawn by a different pair of hands from the ones that issued it, and later than it
  -- was issued, so the approval's `reviewed_*` columns cannot carry it. Who, when and why are the
  -- three an account holder is owed when their host status disappears.
  revoked_by          UUID REFERENCES admins (id) ON DELETE SET NULL,
  revoked_at          TIMESTAMPTZ,
  revoke_reason       VARCHAR(500),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE role_applications
  DROP CONSTRAINT IF EXISTS role_applications_decision_evidence;

-- Asked of each field separately rather than of the pair: a row that names a reviewer but carries no
-- timestamp is half-written by a service that updated one column and forgot the other, and an
-- equality against `(both are set)` reads it as undecided and lets it stand.
ALTER TABLE role_applications
  ADD CONSTRAINT role_applications_decision_evidence
  CHECK (
    (status IN ('APPROVED', 'REJECTED', 'INFO_REQUESTED', 'REVOKED')) = (reviewed_by IS NOT NULL)
    AND (status IN ('APPROVED', 'REJECTED', 'INFO_REQUESTED', 'REVOKED')) = (reviewed_at IS NOT NULL)
  );

ALTER TABLE role_applications
  DROP CONSTRAINT IF EXISTS role_applications_decision_says_why;

ALTER TABLE role_applications
  ADD CONSTRAINT role_applications_decision_says_why
  CHECK (
    (status <> 'REJECTED' OR length(btrim(coalesce(decision_note, ''))) > 0)
    AND (status <> 'INFO_REQUESTED' OR length(btrim(coalesce(info_request_note, ''))) > 0)
  );

ALTER TABLE role_applications
  DROP CONSTRAINT IF EXISTS role_applications_revocation_evidence;

ALTER TABLE role_applications
  ADD CONSTRAINT role_applications_revocation_evidence
  CHECK (
    (status = 'REVOKED') = (revoked_by IS NOT NULL)
    AND (status = 'REVOKED') = (revoked_at IS NOT NULL)
    AND (status <> 'REVOKED' OR length(btrim(coalesce(revoke_reason, ''))) > 0)
  );

-- The grant an approval created must be the kind this role grants, and must still be pointed at after
-- a revocation — the row is the record of what was switched off. HOST is the only role whose grant is
-- a marker on the applicant's own row, so it is the only one that points at nothing here.
ALTER TABLE role_applications
  DROP CONSTRAINT IF EXISTS role_applications_grant_shape;

ALTER TABLE role_applications
  ADD CONSTRAINT role_applications_grant_shape
  CHECK (
    (
      status NOT IN ('APPROVED', 'REVOKED')
      AND agency_id IS NULL
      AND business_account_id IS NULL
    )
    OR (
      status IN ('APPROVED', 'REVOKED')
      AND (
        (role = 'HOST' AND agency_id IS NULL AND business_account_id IS NULL)
        OR (role = 'AGENCY' AND agency_id IS NOT NULL AND business_account_id IS NULL)
        OR (role IN ('COIN_SELLER', 'BD_MANAGER') AND business_account_id IS NOT NULL AND agency_id IS NULL)
      )
    )
  );

-- One live application per account and role: nobody holds two queue items for the same role, and
-- nobody holds a grant and a fresh application at once. A row that was rejected, cancelled or revoked
-- is out of the index, so an account may apply again — that second application is a separate
-- judgement about a separate moment, and it is history rather than a live state.
CREATE UNIQUE INDEX IF NOT EXISTS role_application_live_idx
  ON role_applications (user_id, role)
  WHERE status IN ('PENDING', 'INFO_REQUESTED', 'APPROVED');

CREATE INDEX IF NOT EXISTS role_application_queue_idx ON role_applications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS role_application_mine_idx  ON role_applications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS role_application_role_idx  ON role_applications (role, status);

-- ---------------------------------------------------------------------------
-- The grant pointer has to name the right kind of thing.
--
-- A CHECK cannot read another table, so the two rules that make `agency_id` and
-- `business_account_id` trustworthy are a trigger, which is how 0006 expressed the same shape of
-- rule for `business_accounts.parent_id`. Both matter because the revoke path and the "is this
-- account already a host" test follow the pointer rather than re-deriving it: a COIN_SELLER
-- application pointing at a BD account would hand out seller rights through an agent's row, and an
-- AGENCY application pointing at somebody else's agency would let an approval switch off a roster its
-- applicant never owned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION role_application_grant_matches_role() RETURNS trigger AS $$
DECLARE
  account_kind business_account_kind;
  agency_owner UUID;
BEGIN
  IF NEW.business_account_id IS NOT NULL THEN
    SELECT kind INTO account_kind FROM business_accounts WHERE id = NEW.business_account_id;
    IF account_kind::TEXT <> NEW.role::TEXT THEN
      RAISE EXCEPTION 'a % application cannot grant business account % (kind %)',
        NEW.role, NEW.business_account_id, account_kind
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.agency_id IS NOT NULL THEN
    SELECT owner_user_id INTO agency_owner FROM agencies WHERE id = NEW.agency_id;
    IF agency_owner IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'application % cannot grant agency %, which is owned by another account',
        NEW.id, NEW.agency_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS role_applications_grant_matches_role ON role_applications;
CREATE TRIGGER role_applications_grant_matches_role
  BEFORE INSERT OR UPDATE OF agency_id, business_account_id, role ON role_applications
  FOR EACH ROW EXECUTE FUNCTION role_application_grant_matches_role();

INSERT INTO system_config (key, value, description) VALUES
  ('roles.hostApplicationRequired',
   '{"enabled": false}'::jsonb,
   'When enabled, opening a room requires an approved HOST application; when disabled, any account may host a room and creating one still marks the account as a host, which is the behaviour every existing fixture and demo account relies on.'),
  ('partner.sellerLimits',
   '{"maxOrderDiamonds": 100000, "dailyDiamondLimit": 1000000, "dailyOrderLimit": 200}'::jsonb,
   'The recharge limits an approved coin-seller application starts a business account with, so the grant is not unlimited the moment it is switched on. An operator narrows them per account afterwards with PATCH /api/admin/business/accounts/:id.')
ON CONFLICT (key) DO NOTHING;
