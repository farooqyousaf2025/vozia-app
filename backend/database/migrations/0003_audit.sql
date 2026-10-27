-- 0003_audit.sql — the audit trail the admin surface needs.
--
-- Programme §10 requires every administrative mutation to be attributable, and §15 repeats
-- it. Until now the back office changed gifts, balances, VIP tiers and withdrawals with no
-- record of who did it, which is the one thing an operator dispute cannot survive.
--
-- Append-only by convention and by grant: nothing in the backend updates or deletes these
-- rows, and `target_id` is TEXT rather than a UUID so a game definition, a gift and a room
-- can all be named by one column.

CREATE TABLE IF NOT EXISTS admin_audit (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID REFERENCES admins (id) ON DELETE SET NULL,
  -- Stable verb the console filters on: 'GIFT_CREATE', 'BALANCE_ADJUST', 'GAME_RULES_UPDATE', ...
  action      VARCHAR(48) NOT NULL,
  target_type VARCHAR(32),
  target_id   TEXT,
  summary     VARCHAR(500) NOT NULL,
  -- Before/after or the full patch. Never a secret: operators' tokens and OTPs do not belong here.
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_time_idx   ON admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_admin_idx  ON admin_audit (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_target_idx ON admin_audit (target_type, target_id);
