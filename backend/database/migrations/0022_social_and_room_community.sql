-- 0022 — The social layer, and the three room controls a host owns.
--
-- The platform already knows how to sell a gift, seat a speaker and run a battle. What it did
-- not have is the quieter half of a party app: who follows whom, who wants nothing to do with
-- whom, who was reported, which rooms a member keeps coming back to, and a host's ability to
-- approve a microphone instead of handing one out on a first-tap basis.
--
-- Four rules shape this migration:
--
--   * **Follows and blocks are edges, not counters.** `users` gains no denormalised columns;
--     both counts are `COUNT(*)` over an indexed edge table, so a block that deletes a follow
--     can never leave a stale number behind. The pair is the primary key, which also makes
--     "follow twice" a no-op instead of a duplicate row.
--   * **A block is symmetric at the query layer.** Only the blocker writes the row, but every
--     interaction check asks `blocker = a AND blocked = b OR blocker = b AND blocked = a`.
--     Gifts and follows therefore stop in both directions without the victim having to block
--     back. Blocking also deletes any follow edges between the pair in the same transaction.
--   * **A report is an operator's work queue, not an automatic verdict.** Reporting never
--     changes an account's status; it writes a `PENDING` row with a reason, and only an
--     operator can move it to `ACTIONED` / `DISMISSED` / `REVIEWED`. One open report per
--     reporter/target pair is allowed, so a repeat tap does not flood the queue.
--   * **Speaker requests and ownership transfer are host decisions.** A room may opt into
--     approval (`rooms.speaker_approval_required`); the default is off so existing clients keep
--     the tap-to-sit behaviour they shipped with. Ownership transfer is recorded in its own
--     table rather than overwriting `rooms.host_id` silently — a room that changes hands should
--     still have a history to point at.

-- ---------------------------------------------------------------------------
-- follows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_follows (
  follower_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  followee_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT user_follows_not_self CHECK (follower_id <> followee_id)
);

-- "Who follows me" is the list a profile screen renders; the PK already answers "who do I follow".
CREATE INDEX IF NOT EXISTS user_follows_followee_idx ON user_follows (followee_id, created_at DESC);

COMMENT ON TABLE user_follows IS 'Directed follow edges. Both counts are computed over this table; no counter on users.';

-- ---------------------------------------------------------------------------
-- blocks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Optional and private to the operator queue; never shown to the blocked account.
  reason     VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT user_blocks_not_self CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks (blocked_id, created_at DESC);

COMMENT ON TABLE user_blocks IS
  'One-directional rows read symmetrically by the service: gifts and follows stop in both directions.';

-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_reports (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_user_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The room the incident happened in, when the reporter was in one. Kept nullable: a report
  -- filed from a profile is just as valid, and SET NULL keeps the report after the room is gone.
  room_id        UUID        REFERENCES rooms (id) ON DELETE SET NULL,
  reason         VARCHAR(24) NOT NULL
                 CHECK (reason IN ('HARASSMENT', 'SPAM', 'FRAUD', 'UNDERAGE', 'VIOLENCE', 'OTHER')),
  details        VARCHAR(500),
  status         VARCHAR(12) NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED')),
  reviewed_by    UUID        REFERENCES admins (id) ON DELETE SET NULL,
  reviewed_at    TIMESTAMPTZ,
  resolution     VARCHAR(300),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_reports_not_self CHECK (reporter_id <> target_user_id)
);

CREATE INDEX IF NOT EXISTS user_reports_status_idx   ON user_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS user_reports_target_idx   ON user_reports (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_reports_reporter_idx ON user_reports (reporter_id, created_at DESC);

-- One open report per pair. Dismissing or actioning a report frees the pair to report again,
-- because the partial index only covers PENDING rows.
CREATE UNIQUE INDEX IF NOT EXISTS user_reports_open_uq
  ON user_reports (reporter_id, target_user_id) WHERE status = 'PENDING';

COMMENT ON TABLE user_reports IS
  'Operator work queue. Reporting never changes users.status; only a review decision does (optionally).';

-- ---------------------------------------------------------------------------
-- favorites
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_favorites (
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  room_id    UUID        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, room_id)
);

CREATE INDEX IF NOT EXISTS room_favorites_room_idx ON room_favorites (room_id, created_at DESC);

COMMENT ON TABLE room_favorites IS 'A member''s saved rooms. Deleting a room drops its favorites with it.';

-- ---------------------------------------------------------------------------
-- speaker requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_speaker_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     UUID        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The seat the member asked for. Seat 0 is the host's and is never requestable.
  seat_index  INT         NOT NULL CHECK (seat_index BETWEEN 1 AND 63),
  status      VARCHAR(12) NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED')),
  -- The host who decided. SET NULL so a deleted account does not erase the request.
  decided_by  UUID        REFERENCES users (id) ON DELETE SET NULL,
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS room_speaker_requests_room_idx
  ON room_speaker_requests (room_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS room_speaker_requests_user_idx
  ON room_speaker_requests (user_id, created_at DESC);

-- A member may hold at most one open request per room. Tapping "request mic" twice is idempotent
-- rather than a second queue item.
CREATE UNIQUE INDEX IF NOT EXISTS room_speaker_requests_pending_uq
  ON room_speaker_requests (room_id, user_id) WHERE status = 'PENDING';

COMMENT ON TABLE room_speaker_requests IS
  'Only written while rooms.speaker_approval_required is true (except host invitations, which seat directly).';

-- ---------------------------------------------------------------------------
-- ownership transfers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_ownership_transfers (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      UUID        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  from_user_id UUID        REFERENCES users (id) ON DELETE SET NULL,
  to_user_id   UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  note         VARCHAR(200),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS room_ownership_transfers_room_idx
  ON room_ownership_transfers (room_id, created_at DESC);

COMMENT ON TABLE room_ownership_transfers IS
  'Append-only record of a room changing hands. rooms.host_id holds the current owner.';

-- ---------------------------------------------------------------------------
-- rooms: pinned announcement + the speaker-approval switch
-- ---------------------------------------------------------------------------
-- A pinned notice is host prose, short on purpose: it sits above the chat, not in it. Cleared by
-- writing NULL, which is how the client knows to hide the banner rather than show leftover text.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS announcement VARCHAR(300);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS announcement_updated_at TIMESTAMPTZ;

-- Off by default. Existing rooms and existing clients keep tap-to-sit; a host who wants a
-- microphone queue turns it on per room. The column is not a global feature flag on purpose —
-- a quiz room and a lounge want different answers.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS speaker_approval_required BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN rooms.announcement IS
  'Host-pinned notice shown above chat; NULL means no banner. An operator may also clear it.';
COMMENT ON COLUMN rooms.speaker_approval_required IS
  'true turns POST /api/rooms/:id/seat into a request the host must approve.';
