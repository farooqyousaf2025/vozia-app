-- 0053 — explicit system ownership for operator-created rooms.
-- Member-owned rooms retain their existing owner; no member account is fabricated for operators.
ALTER TABLE rooms
  ALTER COLUMN host_id DROP NOT NULL;

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS owner_type VARCHAR(12) NOT NULL DEFAULT 'MEMBER',
  ADD COLUMN IF NOT EXISTS owner_admin_id UUID REFERENCES admins(id) ON DELETE RESTRICT;

DO $$ BEGIN
  ALTER TABLE rooms
    ADD CONSTRAINT rooms_owner_type_check
    CHECK (owner_type IN ('MEMBER', 'SYSTEM'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE rooms
    ADD CONSTRAINT rooms_owner_identity_check
    CHECK (
      (owner_type = 'MEMBER' AND host_id IS NOT NULL AND owner_admin_id IS NULL)
      OR
      (owner_type = 'SYSTEM' AND host_id IS NULL AND owner_admin_id IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS rooms_owner_admin_idx
  ON rooms (owner_admin_id) WHERE owner_type = 'SYSTEM';

COMMENT ON COLUMN rooms.owner_type IS
  'MEMBER rooms are owned by host_id; SYSTEM rooms are operator-owned and have no member host.';
