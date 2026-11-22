-- Multiple FCM registrations per member. Keep the legacy column as a rolling-upgrade fallback.
CREATE TABLE IF NOT EXISTS user_device_tokens (
  token        TEXT PRIMARY KEY CHECK (char_length(token) BETWEEN 20 AND 600),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_device_tokens_user_seen_idx
  ON user_device_tokens (user_id, last_seen_at DESC, created_at DESC);

-- Preserve every token already present on a member. The column remains for old app
-- versions until a later, separately reviewed compatibility cleanup.
INSERT INTO user_device_tokens (user_id, token)
SELECT id, device_token
  FROM users
 WHERE device_token IS NOT NULL
   AND btrim(device_token) <> ''
ON CONFLICT (token) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      updated_at = now(),
      last_seen_at = now();
