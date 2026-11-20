-- 0051 — scoped agency room moderation attribution.
-- Agency actions remain distinct from operator moderation and never touch financial ledgers.
ALTER TABLE room_bans
  ADD COLUMN IF NOT EXISTS banned_by_agency_user_id UUID REFERENCES users (id) ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE room_bans
    ADD CONSTRAINT room_bans_single_moderator_actor
    CHECK (num_nonnulls(banned_by, banned_by_agency_user_id) <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS agency_room_moderation_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID REFERENCES agencies (id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  room_id UUID,
  host_user_id UUID,
  target_user_id UUID,
  action VARCHAR(16) NOT NULL CHECK (action IN ('MUTE', 'UNMUTE', 'KICK', 'BAN', 'UNBAN')),
  reason VARCHAR(200),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agency_room_moderation_audit_agency_idx
  ON agency_room_moderation_audit (agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agency_room_moderation_audit_room_idx
  ON agency_room_moderation_audit (room_id, created_at DESC);
