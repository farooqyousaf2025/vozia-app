-- 0056 — support read-only agency host activity windows without scanning all room history.
CREATE INDEX IF NOT EXISTS rooms_host_created_idx
  ON rooms (host_id, created_at DESC);

CREATE INDEX IF NOT EXISTS room_participants_joined_idx
  ON room_participants (joined_at DESC, room_id, user_id);
