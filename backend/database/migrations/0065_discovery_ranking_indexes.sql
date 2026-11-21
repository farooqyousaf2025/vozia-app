-- 0065 — indexes for live room / host / agency discovery rankings.
-- No counters or money are written: ranking scores are derived from current presence and
-- the existing gift ledger at read time. These indexes keep the bounded public queries cheap.

CREATE INDEX IF NOT EXISTS rooms_active_region_host_idx
  ON rooms (region, host_id, id)
  WHERE status = 'ACTIVE' AND type = 'PUBLIC' AND host_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS room_participants_live_room_role_idx
  ON room_participants (room_id, role, user_id)
  WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS agency_hosts_active_agency_host_idx
  ON agency_hosts (agency_id, host_user_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS agency_hosts_active_host_agency_idx
  ON agency_hosts (host_user_id, agency_id)
  WHERE status = 'ACTIVE';
