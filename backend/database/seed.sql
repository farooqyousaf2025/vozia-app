-- =============================================================================
-- Voiza demo seed (optional). Run after schema.sql:
--   psql "$DATABASE_URL" -f backend/database/seed.sql
-- Creates one agency, two hosts, one filler listener and three live rooms with
-- their seat rows, so a fresh install has content on the home feed.
-- All demo accounts log in through the mock OTP flow (OTP_MOCK_CODE=123456).
-- =============================================================================

BEGIN;

-- Demo users ------------------------------------------------------------------
INSERT INTO users (id, phone, username, avatar_url, bio, user_type, diamond_balance, r_coin_balance, is_verified)
VALUES
  ('00000000-0000-0000-0000-0000000000a1', '+15550000001', 'nova_host',  '/avatars/host-nova.png',  'Nightly party host', 'HOST', 20000, 850000, TRUE),
  ('00000000-0000-0000-0000-0000000000a2', '+15550000002', 'echo_dj',    '/avatars/host-echo.png',  'Vinyl & deep house',      'HOST', 15000, 402000, TRUE),
  ('00000000-0000-0000-0000-0000000000a3', '+15550000003', 'agency_max', NULL,                       'Agency owner',            'AGENCY_ADMIN', 50000, 1200000, TRUE),
  ('00000000-0000-0000-0000-0000000000a4', '+15550000004', 'guest_04',   NULL,                       NULL,                      'USER', 5000, 0, FALSE)
ON CONFLICT (phone) DO NOTHING;

-- Agency + roster -------------------------------------------------------------
INSERT INTO agencies (id, name, owner_user_id, commission_bps, status, contact_phone)
VALUES ('11111111-1111-1111-1111-1111111111a1', 'Aurora Live',
        '00000000-0000-0000-0000-0000000000a3', 1500, 'ACTIVE', '+15550000003')
ON CONFLICT (name) DO NOTHING;

INSERT INTO agency_hosts (agency_id, host_user_id, commission_bps, status)
VALUES
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a1', 1500, 'ACTIVE'),
  ('11111111-1111-1111-1111-1111111111a1', '00000000-0000-0000-0000-0000000000a2', 1200, 'ACTIVE')
ON CONFLICT (agency_id, host_user_id) DO NOTHING;

-- Rooms -----------------------------------------------------------------------
INSERT INTO rooms (id, room_number, title, description, host_id, type, seat_capacity, status, category, livekit_room_name, listener_count, total_gift_value)
VALUES
  ('22222222-2222-2222-2222-222222222201', 100001, 'Midnight Karaoke Lounge', 'Sing with us, seats open!',
   '00000000-0000-0000-0000-0000000000a1', 'PUBLIC',  9, 'ACTIVE', 'MUSIC', 'voiza-room-100001', 42, 12800),
  ('22222222-2222-2222-2222-222222222202', 100002, 'Deep House Vinyl Bar',    'DJ on the mic, requests welcome',
   '00000000-0000-0000-0000-0000000000a2', 'PUBLIC',  9, 'ACTIVE', 'PARTY', 'voiza-room-100002', 17, 4400),
  ('22222222-2222-2222-2222-222222222203', 100003, 'VIP Truth or Dare',       'Password: 8888',
   '00000000-0000-0000-0000-0000000000a1', 'PRIVATE', 9, 'ACTIVE', 'CHAT',  'voiza-room-100003', 6, 900)
ON CONFLICT (room_number) DO NOTHING;

-- Seat rows (0 = host seat, 1..8 speakers). password_hash for room 3 is the
-- scrypt hash for "8888", produced by the backend at runtime — left NULL here so
-- the demo private room is openable; set it via the admin panel to test locking.
DO $$
DECLARE r RECORD; i INT;
BEGIN
  FOR r IN SELECT id, host_id FROM rooms WHERE status = 'ACTIVE' LOOP
    i := 0;
    WHILE i < 9 LOOP
      INSERT INTO room_seats (room_id, seat_index, user_id, status, is_speaker, is_muted)
      VALUES (r.id, i, CASE WHEN i = 0 THEN r.host_id ELSE NULL END,
              CASE WHEN i = 0 THEN 'OCCUPIED'::seat_status ELSE 'EMPTY'::seat_status END,
              i = 0, FALSE)
      ON CONFLICT (room_id, seat_index) DO NOTHING;
      i := i + 1;
    END LOOP;
  END LOOP;
END $$;

-- Host presence rows so the audience strip is populated on first load ---------
INSERT INTO room_participants (room_id, user_id, role, seat_index)
SELECT r.id, r.host_id, 'HOST', 0 FROM rooms r
WHERE r.status = 'ACTIVE' AND r.host_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;
