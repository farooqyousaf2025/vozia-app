-- 0052 — identify the current disposable LiveKit session for each permanent room.
-- The SID fences delayed room_finished webhooks from clearing presence in a newer session.
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS livekit_session_sid VARCHAR(128);

COMMENT ON COLUMN rooms.livekit_session_sid IS
  'Current LiveKit media-session SID. NULL means no session is currently recorded; this is not the Vozia room lifecycle.';
