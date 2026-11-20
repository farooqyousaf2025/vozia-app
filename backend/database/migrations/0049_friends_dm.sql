-- 0049 — Friends and direct messages.
--
-- A friend edge is a mutual, explicit relationship on top of the existing follow graph: two
-- accounts that have accepted a request. Direct messages exist only between friends, and
-- "do not contact again" is a one-directional flag the addressee sets to stop further
-- requests from a given requester. Nothing here denormalises counts onto users.

CREATE TABLE IF NOT EXISTS friend_requests (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  addressee_id  UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status        VARCHAR(12) NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at  TIMESTAMPTZ,
  CONSTRAINT friend_requests_not_self CHECK (requester_id <> addressee_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_pending_uq
  ON friend_requests (requester_id, addressee_id) WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS friend_requests_addressee_idx
  ON friend_requests (addressee_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS friend_requests_requester_idx
  ON friend_requests (requester_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS friend_contact_blocks (
  blocker_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT friend_contact_blocks_not_self CHECK (blocker_id <> blocked_id)
);

CREATE TABLE IF NOT EXISTS friendships (
  user_a_id  UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_b_id  UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a_id, user_b_id),
  CONSTRAINT friendships_ordered CHECK (user_a_id < user_b_id)
);

CREATE INDEX IF NOT EXISTS friendships_b_idx ON friendships (user_b_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_b_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at  TIMESTAMPTZ,
  UNIQUE (user_a_id, user_b_id),
  CONSTRAINT conversations_ordered CHECK (user_a_id < user_b_id)
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  content         VARCHAR(2000) NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  read_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS direct_messages_conv_idx
  ON direct_messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS direct_messages_unread_idx
  ON direct_messages (conversation_id, sender_id) WHERE read_at IS NULL;