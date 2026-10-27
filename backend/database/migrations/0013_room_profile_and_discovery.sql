-- 0013 — Room profile fields and the discovery reads that need them.
--
-- Brief §3 asks a room to carry language, region and rules next to the title/description it
-- already has, and asks the lobby for search, trending and recently-active ordering. Nothing
-- here changes money or seats; it is the room's own profile plus indexes.
--
-- language/region are stored as normalized ISO tags ('en', 'US') rather than free text so a
-- filter is an exact comparison. The shape is checked here and the case is normalized in
-- room.service.ts; a full ISO registry would be a list to maintain for no benefit at this size.
-- rules is host-written text shown in the room, capped so one paste cannot bury the client.

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS language VARCHAR(16),
  ADD COLUMN IF NOT EXISTS region   VARCHAR(2),
  ADD COLUMN IF NOT EXISTS rules    VARCHAR(1000);

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_language_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_language_check
  CHECK (language IS NULL OR language ~ '^[a-z]{2}(-[a-z0-9]{2,8})*$');

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_region_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_region_check
  CHECK (region IS NULL OR region ~ '^[A-Z]{2}$');

-- Trending is "gifts in the last 24 hours", which reads transactions by room and time.
-- Without this index every lobby refresh would scan the ledger.
CREATE INDEX IF NOT EXISTS transactions_room_created_idx
  ON transactions (room_id, created_at) WHERE room_id IS NOT NULL;

-- The three lobby orderings all filter status + category and sort on activity or recency.
CREATE INDEX IF NOT EXISTS rooms_discovery_idx
  ON rooms (status, category, listener_count DESC, created_at DESC);

COMMENT ON COLUMN rooms.language IS 'ISO 639-1 primary subtag the room is spoken in, normalized to lower case; NULL means the host never said.';
COMMENT ON COLUMN rooms.region   IS 'ISO 3166-1 alpha-2 the room targets, upper case; NULL means unstated.';
COMMENT ON COLUMN rooms.rules    IS 'Host-written house rules, shown in the room and in the share sheet; NOT a moderation record.';
