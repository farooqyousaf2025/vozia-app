-- 0059 — durable agency-scoped announcements for the hosts assigned at publication time.
-- Recipient rows are a publication snapshot; reads additionally require the host to remain
-- actively assigned to the same agency, so a transfer or removal immediately revokes access.
CREATE TABLE IF NOT EXISTS agency_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id UUID NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title VARCHAR(100) NOT NULL,
  body VARCHAR(3000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(title)) BETWEEN 1 AND 100),
  CHECK (length(btrim(body)) BETWEEN 1 AND 3000)
);

CREATE INDEX IF NOT EXISTS agency_announcements_agency_created_idx
  ON agency_announcements (agency_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agency_announcement_recipients (
  announcement_id UUID NOT NULL REFERENCES agency_announcements(id) ON DELETE CASCADE,
  host_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  read_at TIMESTAMPTZ,
  PRIMARY KEY (announcement_id, host_user_id)
);

CREATE INDEX IF NOT EXISTS agency_announcement_recipients_host_idx
  ON agency_announcement_recipients (host_user_id, announcement_id);
