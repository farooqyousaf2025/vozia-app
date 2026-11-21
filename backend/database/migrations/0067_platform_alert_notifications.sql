-- Admin inbox notifications for critical platform operations alerts.
-- Only the in-app channel is enabled in this phase; external delivery adapters remain
-- unavailable until an administrator explicitly configures supported provider credentials.
CREATE TABLE IF NOT EXISTS platform_alert_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_event_id uuid NOT NULL REFERENCES platform_alert_events(id) ON DELETE CASCADE,
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'IN_APP' CHECK (channel IN ('IN_APP')),
  severity text NOT NULL CHECK (severity IN ('WARNING','CRITICAL')),
  title varchar(160) NOT NULL,
  message varchar(1000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (alert_event_id, admin_id, channel)
);
CREATE INDEX IF NOT EXISTS platform_alert_notifications_inbox
  ON platform_alert_notifications (admin_id, read_at, created_at DESC);
