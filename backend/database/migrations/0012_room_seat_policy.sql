-- 0012_room_seat_policy.sql — seat capacity becomes an administrator setting.
--
-- The programme asks for "a default of 15 speaker seats, configurable by the administrator" and
-- forbids hardcoding capacity. Until now the number lived in three places that disagreed: the
-- schema CHECK capped a room at 12 seats, `room_seats.seat_index` stopped at 11, and
-- `MAX_SEATS` in room.service.ts answered for 9 — so a 15-speaker room was impossible and each
-- client guessed its own ceiling (the Android slider offered 1..12, the grid drew 9).
--
-- The ceiling and the policy are different things, and a CHECK constraint cannot read
-- `system_config`. So this migration widens both CHECKs to the absolute limit the platform will
-- ever allow (64 seats: one host seat plus 63 speakers) and makes the admin-owned `rooms.seats`
-- row decide the usable number inside it. The service re-reads that row and clamps what it finds,
-- so an out-of-range or hand-edited value can never become a room.
--
-- `seat_capacity` loses its column DEFAULT. Every insert goes through `createRoom`, which resolves
-- the policy before it writes, so a default would only ever be a second, silent number — one that
-- a raw INSERT could pick up and disagree with the admin's setting.
--
-- Existing rooms keep the seats they were created with: `room_seats` rows are pre-materialised at
-- creation, so growing a live room would hand out microphones nobody approved.

ALTER TABLE rooms ALTER COLUMN seat_capacity DROP DEFAULT;

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_seat_capacity_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_seat_capacity_check CHECK (seat_capacity BETWEEN 1 AND 64);

ALTER TABLE room_seats DROP CONSTRAINT IF EXISTS room_seats_seat_index_check;
ALTER TABLE room_seats ADD CONSTRAINT room_seats_seat_index_check CHECK (seat_index >= 0 AND seat_index <= 63);

INSERT INTO system_config (key, value, description) VALUES
  ('rooms.seats',
   '{"speakerSeats": 15, "maxSpeakerSeats": 32}'::jsonb,
   'Speaker seats a new room gets by default, and the most a host may choose. Seat 0 is the host seat, so N speaker seats means N+1 seats in the room.')
ON CONFLICT (key) DO NOTHING;
