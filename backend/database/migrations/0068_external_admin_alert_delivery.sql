-- External admin alert delivery: provider credentials stay in deployment secrets, never system_config.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS email varchar(254);
CREATE UNIQUE INDEX IF NOT EXISTS admins_email_unique ON admins (lower(email)) WHERE email IS NOT NULL AND email <> '';

ALTER TABLE platform_alert_notifications
  DROP CONSTRAINT IF EXISTS platform_alert_notifications_channel_check;
ALTER TABLE platform_alert_notifications
  ADD CONSTRAINT platform_alert_notifications_channel_check CHECK (channel IN ('IN_APP','EMAIL','WEBHOOK'));

ALTER TABLE platform_alert_notifications
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'PENDING'
    CHECK (delivery_status IN ('PENDING','DELIVERED','RETRY','FAILED','SKIPPED')),
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error varchar(1000);

UPDATE platform_alert_notifications
   SET delivery_status = 'DELIVERED', delivered_at = COALESCE(delivered_at, created_at)
 WHERE channel = 'IN_APP' AND delivery_status = 'PENDING';

CREATE INDEX IF NOT EXISTS platform_alert_notifications_delivery_queue
  ON platform_alert_notifications (next_attempt_at, created_at)
  WHERE channel <> 'IN_APP' AND delivery_status IN ('PENDING','RETRY');
