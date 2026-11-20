-- Platform-wide fallback entrance ride. A member's own valid equipped ride takes precedence.
-- Removing a catalogue row clears this pointer without touching purchase receipts or ownership.
CREATE TABLE IF NOT EXISTS entrance_ride_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  default_ride_key VARCHAR(40) NULL REFERENCES profile_rides(key) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO entrance_ride_settings (singleton, default_ride_key)
VALUES (TRUE, NULL)
ON CONFLICT (singleton) DO NOTHING;
