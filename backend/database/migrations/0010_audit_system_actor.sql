-- 0010_audit_system_actor.sql — let a machine sign for what it did.
--
-- A provider confirmation credits coins with nobody at a keyboard: neither an admin row nor a
-- partner row can honestly be named as the actor, and blaming the seller whose order it was
-- would be a false record. So the entry names the process that ran instead. The point of the
-- 0005 constraint was never "a human must press the button" — it was "no anonymous write".

ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS actor_system VARCHAR(64);

CREATE INDEX IF NOT EXISTS admin_audit_system_idx ON admin_audit (actor_system, created_at DESC);

ALTER TABLE admin_audit DROP CONSTRAINT IF EXISTS admin_audit_system_not_blank;
ALTER TABLE admin_audit ADD CONSTRAINT admin_audit_system_not_blank
  CHECK (actor_system IS NULL OR length(btrim(actor_system)) > 0);

ALTER TABLE admin_audit DROP CONSTRAINT IF EXISTS admin_audit_actor_present;
ALTER TABLE admin_audit ADD CONSTRAINT admin_audit_actor_present
  CHECK (admin_id IS NOT NULL OR business_id IS NOT NULL OR actor_system IS NOT NULL);
