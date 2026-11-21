-- Durable operational alert lifecycle. One active row per fingerprint; a later recurrence creates a new event.
CREATE TABLE IF NOT EXISTS platform_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('WARNING','CRITICAL')),
  service text NOT NULL,
  metric text NOT NULL,
  message text NOT NULL,
  value numeric,
  threshold numeric,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RESOLVED')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_alert_events_one_active_fingerprint
  ON platform_alert_events (fingerprint) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS platform_alert_events_history
  ON platform_alert_events (last_seen_at DESC, severity, status);
