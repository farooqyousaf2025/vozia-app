-- 0057 — verified host attendance from LiveKit participant presence events.
-- Room creation itself does not count as attendance. Rows are written only after the
-- authenticated host is confirmed by a LiveKit participant_joined webhook.
-- SET NULL preserves the record if a room or user is later removed.
CREATE TABLE IF NOT EXISTS room_host_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES rooms (id) ON DELETE SET NULL,
  room_number INT NOT NULL,
  room_title VARCHAR(60) NOT NULL,
  host_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  host_username VARCHAR(40) NOT NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_out_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS room_host_checkins_open_uq
  ON room_host_checkins (room_id, host_user_id)
  WHERE room_id IS NOT NULL AND host_user_id IS NOT NULL AND checked_out_at IS NULL;

CREATE INDEX IF NOT EXISTS room_host_checkins_host_time_idx
  ON room_host_checkins (host_user_id, checked_in_at DESC);

CREATE INDEX IF NOT EXISTS room_host_checkins_time_idx
  ON room_host_checkins (checked_in_at DESC);

COMMENT ON TABLE room_host_checkins IS
  'Host check-ins confirmed by LiveKit participant_joined events; no self-reported hours or inferred attendance.';
