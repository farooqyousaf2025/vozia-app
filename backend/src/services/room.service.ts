import { PoolClient } from 'pg';
import { many, one, query, withTransaction } from '../config/db';
import { DEFAULT_THEME, isTheme, THEME_SLUGS } from '../config/themes';
import { presenceKeys, redis } from '../config/redis';
import { ChatRow, ParticipantRow, RoomRow, SeatRow, UserRow } from '../types/db';
import { hashSecret, randomRoomNumber, verifySecret } from '../utils/crypto';
import { ApiError } from '../utils/http';
import { readConfig } from './business.service';
import {
  ChatMessageDto,
  MiniUser,
  ParticipantDto,
  RoomDto,
  SeatDto,
  toChatMessage,
  toMiniUser,
  toParticipant,
  toRoom,
  toSeat,
} from '../utils/serialize';
import {
  AccessLevel,
  ensureLivekitRoom,
  issueRoomToken,
  LivekitAccess,
  mutePublishedAudio,
  removeLivekitParticipant,
  setPublishPermission,
} from './livekit.service';

/**
 * The most seats the schema will accept (0012_room_seat_policy.sql): a host seat plus 63
 * speakers. This is a ceiling, not a capacity — the capacity a host may ask for is the
 * administrator's `rooms.seats` setting, and a room's own `seat_capacity` is what governs its
 * seats once it exists.
 */
export const SEAT_CEILING = 64;

/** The `system_config` key the administrator owns. */
export const SEAT_POLICY_KEY = 'rooms.seats';

export type SeatPolicy = {
  /** Speaker seats a new room gets when the host does not choose. */
  speakerSeats: number;
  /** The largest speaker count a host may pick. */
  maxSpeakerSeats: number;
};

/** What migration 0012 seeds; also the fallback if the row is missing or malformed. */
const DEFAULT_SEAT_POLICY: SeatPolicy = { speakerSeats: 15, maxSpeakerSeats: 32 };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** A config JSONB field may be anything; a seat count must be a whole number of at least one. */
function wholeNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/**
 * The administrator's seat policy, read per request and clamped to {@link SEAT_CEILING}.
 *
 * Capacity is deliberately not a constant: the platform default is 15 speaker seats and the
 * administrator may move it, so every path that counts seats asks the database. The clamp is what
 * keeps a hand-edited config row from asking for more seats than the CHECK constraint will take.
 */
export async function seatPolicy(): Promise<SeatPolicy> {
  const raw = await readConfig<Record<string, unknown>>(SEAT_POLICY_KEY, DEFAULT_SEAT_POLICY);
  const speakerSeats = clamp(
    wholeNumber(raw.speakerSeats, DEFAULT_SEAT_POLICY.speakerSeats),
    1,
    SEAT_CEILING - 1,
  );
  const maxSpeakerSeats = clamp(
    wholeNumber(raw.maxSpeakerSeats, DEFAULT_SEAT_POLICY.maxSpeakerSeats),
    speakerSeats,
    SEAT_CEILING - 1,
  );
  return { speakerSeats, maxSpeakerSeats };
}

export type SeatLimits = {
  /** The smallest room the platform will make: the host plus one speaker. */
  min: number;
  /** Seats in a room created without an explicit capacity — speaker seats plus the host seat. */
  default: number;
  /** The largest seat count a host may ask for. */
  max: number;
  policy: SeatPolicy;
};

export async function seatLimits(): Promise<SeatLimits> {
  const policy = await seatPolicy();
  return {
    min: 2,
    default: clamp(policy.speakerSeats + 1, 2, SEAT_CEILING),
    max: clamp(policy.maxSpeakerSeats + 1, 2, SEAT_CEILING),
    policy,
  };
}

/** The seat count a room is actually created with, whatever a caller asked for. */
export async function resolveSeatCapacity(requested: number | undefined): Promise<number> {
  const limits = await seatLimits();
  const asked = requested === undefined ? NaN : Math.floor(requested);
  return Number.isFinite(asked) ? clamp(asked, limits.min, limits.max) : limits.default;
}

const SEAT_SELECT = `
  SELECT rs.id, rs.room_id, rs.seat_index, rs.user_id, rs.status, rs.is_muted, rs.is_speaker,
         u.username, u.avatar_url
    FROM room_seats rs
    LEFT JOIN users u ON u.id = rs.user_id
   WHERE rs.room_id = $1
   ORDER BY rs.seat_index`;

const PARTICIPANT_SELECT = `
  SELECT p.id, p.room_id, p.user_id, p.role, p.seat_index, p.hand_raised, p.joined_at,
         u.username, u.avatar_url
    FROM room_participants p
    JOIN users u ON u.id = p.user_id
   WHERE p.room_id = $1 AND p.left_at IS NULL`;

const ROOM_SELECT = `
  SELECT r.*, u.username AS host_username, u.avatar_url AS host_avatar_url
    FROM rooms r
    JOIN users u ON u.id = r.host_id`;

async function run(client: PoolClient | undefined, text: string, params: readonly unknown[] = []) {
  // pg's signatures want a mutable any[]; copying keeps the readonly contract local.
  return client ? client.query(text, [...params]) : query(text, params);
}

export async function fetchSeats(roomId: string, client?: PoolClient): Promise<SeatDto[]> {
  const res = await run(client, SEAT_SELECT, [roomId]);
  return (res.rows as SeatRow[]).map(toSeat);
}

export async function fetchParticipants(roomId: string, client?: PoolClient): Promise<ParticipantRow[]> {
  const res = await run(client, `${PARTICIPANT_SELECT} ORDER BY p.joined_at`, [roomId]);
  return res.rows as ParticipantRow[];
}

export async function fetchMiniUser(userId: string): Promise<MiniUser | null> {
  const row = await one<{ id: string; username: string; avatar_url: string | null; vip_level: number }>(
    'SELECT id, username, avatar_url, vip_level FROM users WHERE id = $1',
    [userId],
  );
  return row ? toMiniUser(row) : null;
}

export async function fetchAudience(roomId: string, limit = 120): Promise<MiniUser[]> {
  const rows = await many<ParticipantRow & { user_id: string }>(
    `${PARTICIPANT_SELECT} AND p.role = 'AUDIENCE' ORDER BY p.joined_at DESC LIMIT $2`,
    [roomId, limit],
  );
  return rows.map((r) => ({ id: r.user_id, username: r.username ?? 'unknown', avatarUrl: r.avatar_url ?? null }));
}

export async function loadRoom(roomId: string, client?: PoolClient): Promise<RoomRow> {
  const res = await run(client, `${ROOM_SELECT} WHERE r.id = $1`, [roomId]);
  const row = (res.rows as RoomRow[])[0];
  if (!row) throw ApiError.notFound('Room not found', 'room_not_found');
  return row;
}

function assertActive(room: RoomRow): void {
  if (room.status !== 'ACTIVE') throw ApiError.conflict('This room is closed', 'room_closed');
}

async function loadUser(userId: string, client?: PoolClient): Promise<UserRow> {
  const res = await run(client, 'SELECT * FROM users WHERE id = $1', [userId]);
  const user = (res.rows as UserRow[])[0];
  if (!user) throw ApiError.notFound('User not found');
  if (user.status === 'BANNED') throw ApiError.forbidden('Account is banned', 'account_banned');
  return user;
}

/** Room-scoped moderator ban. Expired rows are dropped here, as nothing else prunes them. */
async function assertNotBanned(roomId: string, userId: string): Promise<void> {
  await query(
    'DELETE FROM room_bans WHERE room_id = $1 AND user_id = $2 AND expires_at IS NOT NULL AND expires_at <= now()',
    [roomId, userId],
  );
  const banned = await one<{ room_id: string }>('SELECT room_id FROM room_bans WHERE room_id = $1 AND user_id = $2', [
    roomId,
    userId,
  ]);
  if (banned) throw ApiError.forbidden('A moderator removed you from this room', 'room_banned');
}

export type RoomWithState = {
  room: RoomDto;
  seats: SeatDto[];
  audience: MiniUser[];
  handRaises: ParticipantDto[];
  livekitRoomName: string;
  hostId: string;
};

async function snapshot(room: RoomRow, client?: PoolClient): Promise<RoomWithState> {
  const [seats, participants] = await Promise.all([
    fetchSeats(room.id, client),
    fetchParticipants(room.id, client),
  ]);
  const dtos = participants.map(toParticipant);
  return {
    room: toRoom(room),
    seats,
    audience: dtos.filter((p) => p.role === 'AUDIENCE').map((p) => p.user),
    handRaises: dtos.filter((p) => p.handRaised),
    livekitRoomName: room.livekit_room_name,
    hostId: room.host_id,
  };
}

/**
 * The room a client sees when it opens one: seat grid, audience strip, recent
 * chat, and the hand-raise queue the host works through.
 */
/** Cheap seat+presence snapshot used for every realtime broadcast. */
export async function seatSnapshot(roomId: string): Promise<{ seats: SeatDto[]; audience: MiniUser[]; present: number }> {
  const [seats, participants] = await Promise.all([fetchSeats(roomId), fetchParticipants(roomId)]);
  const dtos = participants.map(toParticipant);
  const audience = dtos.filter((p) => p.role === 'AUDIENCE').map((p) => p.user);
  const seated = seats.filter((s) => s.user).map((s) => s.user as MiniUser);
  return { seats, audience: [...seated, ...audience], present: seated.length + audience.length };
}

export async function getRoomDetail(roomId: string): Promise<
  RoomWithState & { chat: ChatMessageDto[]; listenerCount: number }
> {
  const room = await loadRoom(roomId);
  const base = await snapshot(room);

  const [chatRows, uniqueListeners] = await Promise.all([
    many<ChatRow>(
      `SELECT c.*, u.username, u.avatar_url FROM chat_messages c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.room_id = $1 ORDER BY c.created_at DESC LIMIT 60`,
      [roomId],
    ),
    redis.pfcount(presenceKeys.roomListeners(roomId)),
  ]);

  const seated = base.seats.filter((s) => s.user).map((s) => s.user as MiniUser);
  const present = seated.length + base.audience.length;
  await query('UPDATE rooms SET listener_count = $2 WHERE id = $1', [roomId, present]).catch(() => undefined);

  return {
    ...base,
    audience: [...seated, ...base.audience],
    chat: chatRows.reverse().map(toChatMessage),
    listenerCount: Math.max(present, uniqueListeners),
  };
}

/**
 * What the lobby may order by. `popular` is the old `category=POPULAR` behaviour: lifetime
 * gift value. `trending` is the same idea over 24 hours — a room that is busy *now* — and
 * reads the ledger, which is why 0013 put an index on `(room_id, created_at)`.
 */
export type RoomSort = 'popular' | 'trending' | 'recent';

/** Gifts sent into a room in the last 24 hours; the trending signal. */
const TRENDING_JOIN = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(t.amount_diamonds), 0)::bigint AS recent_gift_value
      FROM transactions t
     WHERE t.room_id = r.id
       AND t.type = 'GIFT_SENT'
       AND t.created_at > now() - INTERVAL '24 hours'
  ) recent ON TRUE`;

const discoveryOrder = (sort: RoomSort | undefined, category: string | undefined): string => {
  if (sort === 'trending') return 'recent.recent_gift_value DESC, r.listener_count DESC, r.created_at DESC';
  if (sort === 'recent') return 'r.created_at DESC';
  if (sort === 'popular') return 'r.total_gift_value DESC, r.listener_count DESC, r.created_at DESC';
  // No explicit sort: keep what each tab always did, so an old client is unaffected.
  return category === 'POPULAR'
    ? 'r.total_gift_value DESC, r.listener_count DESC, r.created_at DESC'
    : 'r.listener_count DESC, r.created_at DESC';
};

export async function listRooms(opts: {
  category?: string;
  status?: 'ACTIVE' | 'CLOSED';
  limit: number;
  search?: string;
  sort?: RoomSort;
  language?: string | null;
  region?: string | null;
}): Promise<RoomDto[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  where.push(`r.status = $${params.push(opts.status ?? 'ACTIVE')}`);
  if (opts.category && opts.category !== 'POPULAR') {
    where.push(`r.category = $${params.push(opts.category)}`);
  }
  if (opts.language) where.push(`r.language = $${params.push(opts.language)}`);
  if (opts.region) where.push(`r.region = $${params.push(opts.region)}`);
  if (opts.search) {
    params.push(`%${opts.search}%`);
    where.push(`(r.title ILIKE $${params.length} OR CAST(r.room_number AS TEXT) LIKE $${params.length})`);
  }
  params.push(opts.limit);
  const limitParam = params.length;

  const order = discoveryOrder(opts.sort, opts.category);
  const from = opts.sort === 'trending' ? `${ROOM_SELECT}${TRENDING_JOIN}` : ROOM_SELECT;

  const rooms = await many<RoomRow>(
    `${from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${limitParam}`,
    params,
  );
  return rooms.map(toRoom);
}

/**
 * Quick Join: the busiest public room the caller is not already standing in and has not been
 * banned from. Deliberately not "a random room" — the button promises a room with people in it,
 * and the answer is a room id the client then joins through the normal `POST /:id/join`, so a
 * password-protected room can never be selected (and never bypassed) by this shortcut.
 */
export async function quickJoinRoom(userId: string): Promise<RoomDto> {
  const row = await one<RoomRow>(
    `${ROOM_SELECT}
      WHERE r.status = 'ACTIVE' AND r.type = 'PUBLIC' AND r.host_id <> $1
        AND NOT EXISTS (SELECT 1 FROM room_bans b WHERE b.room_id = r.id AND b.user_id = $1)
        AND NOT EXISTS (SELECT 1 FROM room_participants p
                         WHERE p.room_id = r.id AND p.user_id = $1 AND p.left_at IS NULL)
      ORDER BY r.listener_count DESC, r.created_at DESC
      LIMIT 1`,
    [userId],
  );
  if (!row) throw ApiError.notFound('No public room is open right now', 'nothing_to_join');
  return toRoom(row);
}

/** My Room: what the caller hosts, open rooms first, then the recently closed ones. */
export async function listHostedRooms(userId: string, limit: number): Promise<RoomDto[]> {
  const rows = await many<RoomRow>(
    `${ROOM_SELECT} WHERE r.host_id = $1
      ORDER BY (r.status = 'ACTIVE') DESC, r.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map(toRoom);
}

/** The lobby list plus each room's seat rows. Takes exactly what `listRooms` takes. */
export async function listRoomStates(opts: Parameters<typeof listRooms>[0]): Promise<
  Array<RoomDto & { seats: SeatDto[] }>
> {
  const rooms = await listRooms(opts);
  if (!rooms.length) return [];
  const ids = rooms.map((r) => r.id);
  const seatRows = await many<SeatRow>(
    `${SEAT_SELECT.replace('WHERE rs.room_id = $1', 'WHERE rs.room_id = ANY($1::uuid[])')}`,
    [ids],
  );
  const grouped = new Map<string, SeatDto[]>();
  for (const row of seatRows) {
    const bucket = grouped.get(row.room_id) ?? [];
    bucket.push(toSeat(row));
    grouped.set(row.room_id, bucket);
  }
  return rooms.map((room) => ({ ...room, seats: grouped.get(room.id) ?? [] }));
}

export type CreateRoomInput = {
  title: string;
  description?: string;
  category: RoomRow['category'];
  type: RoomRow['type'];
  password?: string;
  /** Omitted, or outside the admin's policy, and the platform default wins. */
  seatCapacity?: number;
  coverUrl?: string;
  theme?: string;
  /** ISO 639-1 tag, normalized and validated by `normalizeLanguage`. */
  language?: string | null;
  /** ISO 3166-1 alpha-2, normalized by `normalizeRegion`. */
  region?: string | null;
  rules?: string | null;
};

export async function createRoom(hostUserId: string, input: CreateRoomInput): Promise<RoomDto & { seats: SeatDto[] }> {
  const user = await loadUser(hostUserId);
  const seatCapacity = await resolveSeatCapacity(input.seatCapacity);
  const passwordHash = input.type === 'PRIVATE' ? hashSecret(input.password ?? String(randomRoomNumber())) : null;
  if (input.type === 'PRIVATE' && !input.password) {
    throw ApiError.badRequest('Private rooms need a password', 'password_required');
  }

  const roomId = await withTransaction(async (client) => {
    let inserted: RoomRow | undefined;
    // room_number is UNIQUE; retry a handful of times on the birthday-collision case.
    for (let attempt = 0; attempt < 8 && !inserted; attempt += 1) {
      const roomNumber = randomRoomNumber();
      try {
        const res = await client.query<RoomRow>(
          `INSERT INTO rooms (room_number, title, description, cover_url, host_id, type, password_hash,
                              seat_capacity, status, category, livekit_room_name, theme,
                              language, region, rules)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$10,$11,$12,$13,$14)
           RETURNING *`,
          [
            roomNumber,
            input.title,
            input.description ?? null,
            input.coverUrl ?? null,
            hostUserId,
            input.type,
            passwordHash,
            seatCapacity,
            input.category,
            // Not `'voiza-room-' || $1::text`: reusing $1 in an integer and a text
            // context makes PostgreSQL refuse the statement ("inconsistent types
            // deduced for parameter $1").
            `voiza-room-${roomNumber}`,
            input.theme && isTheme(input.theme) ? input.theme : DEFAULT_THEME,
            normalizeLanguage(input.language),
            normalizeRegion(input.region),
            normalizeRules(input.rules),
          ],
        );
        inserted = res.rows[0];
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err; // unique_violation
      }
    }
    if (!inserted) throw ApiError.conflict('Could not allocate a room number, try again');

    // Pre-materialise every seat so locking never races seat creation.
    for (let index = 0; index < seatCapacity; index += 1) {
      await client.query(
        `INSERT INTO room_seats (room_id, seat_index, user_id, status, is_speaker, is_muted)
         VALUES ($1,$2,$3,$4,$5,FALSE)`,
        [
          inserted.id,
          index,
          index === 0 ? hostUserId : null,
          index === 0 ? 'OCCUPIED' : 'EMPTY',
          index === 0,
        ],
      );
    }

    await client.query(
      `INSERT INTO room_participants (room_id, user_id, role, seat_index)
       VALUES ($1,$2,'HOST',0) ON CONFLICT DO NOTHING`,
      [inserted.id, hostUserId],
    );

    if (user.user_type === 'USER') {
      await client.query("UPDATE users SET user_type = 'HOST' WHERE id = $1", [hostUserId]);
    }
    return inserted.id;
  });

  const room = await loadRoom(roomId);
  await ensureLivekitRoom(room.livekit_room_name, { maxParticipants: 1000 });
  return { ...toRoom(room), seats: await fetchSeats(roomId) };
}

export type JoinResult = {
  room: RoomDto;
  seats: SeatDto[];
  audience: MiniUser[];
  livekit: LivekitAccess;
  reconnected: boolean;
};

export async function joinRoom(
  userId: string,
  roomId: string,
  password?: string,
): Promise<JoinResult> {
  const room = await loadRoom(roomId);
  assertActive(room);
  const user = await loadUser(userId);
  await assertNotBanned(roomId, userId);

  if (room.type === 'PRIVATE') {
    if (!password) throw ApiError.forbidden('This room is password protected', 'password_required');
    if (!verifySecret(password, room.password_hash)) {
      throw ApiError.forbidden('Wrong room password', 'password_invalid');
    }
  }

  const alreadySeated = await one<{ seat_index: number }>(
    'SELECT seat_index FROM room_seats WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );

  const role = room.host_id === userId ? 'HOST' : alreadySeated ? 'SPEAKER' : 'AUDIENCE';
  await one(
    `INSERT INTO room_participants (room_id, user_id, role, seat_index)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (room_id, user_id) WHERE (left_at IS NULL)
     DO UPDATE SET role = EXCLUDED.role, seat_index = EXCLUDED.seat_index`,
    [roomId, userId, role, alreadySeated?.seat_index ?? null],
  );
  await redis.pfadd(presenceKeys.roomListeners(roomId), userId);

  const seats = await fetchSeats(roomId);
  const level: AccessLevel = room.host_id === userId ? 'host' : alreadySeated ? 'speaker' : 'audience';
  const livekit = await issueRoomToken({
    roomName: room.livekit_room_name,
    identity: userId,
    username: user.username,
    level,
    metadata: { userType: user.user_type, seatIndex: alreadySeated?.seat_index ?? null, roomId },
  });

  const audience = await fetchAudience(roomId);
  return {
    room: toRoom(room),
    seats,
    audience,
    livekit,
    reconnected: Boolean(alreadySeated),
  };
}

export async function getLivekitAccess(userId: string, roomId: string): Promise<LivekitAccess> {
  const room = await loadRoom(roomId);
  assertActive(room);
  const user = await loadUser(userId);
  const seat = await one<{ seat_index: number; is_muted: boolean }>(
    'SELECT seat_index, is_muted FROM room_seats WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
  const level: AccessLevel = room.host_id === userId ? 'host' : seat ? 'speaker' : 'audience';
  return issueRoomToken({
    roomName: room.livekit_room_name,
    identity: userId,
    username: user.username,
    level,
    metadata: { seatIndex: seat?.seat_index ?? null, selfMuted: seat?.is_muted ?? false },
  });
}

export async function leaveRoom(userId: string, roomId: string): Promise<{ ok: true }> {
  const room = await loadRoom(roomId);
  await query('UPDATE room_participants SET left_at = now() WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL', [
    roomId,
    userId,
  ]);
  // Stepping out empties the seat so the next guest can take it, but ownership
  // of the room stays with the host — leaving is not the same as closing.
  await query(
    `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
      WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId],
  );
  await removeLivekitParticipant(room.livekit_room_name, userId);
  await recomputeListenerCount(roomId);
  return { ok: true };
}

/** Takes an EMPTY seat. Serialised on the seat row so two taps cannot both win. */
export async function takeSeat(userId: string, roomId: string, seatIndex: number): Promise<{ seats: SeatDto[] }> {
  const room = await loadRoom(roomId);
  assertActive(room);
  if (seatIndex >= room.seat_capacity) throw ApiError.badRequest('No such seat in this room');

  await withTransaction(async (client) => {
    const seatRes = await client.query<SeatRow>(
      'SELECT * FROM room_seats WHERE room_id = $1 AND seat_index = $2 FOR UPDATE',
      [roomId, seatIndex],
    );
    const seat = seatRes.rows[0];
    if (!seat) throw ApiError.notFound('Seat not found', 'seat_not_found');
    if (seat.status !== 'EMPTY') {
      throw ApiError.conflict(
        seat.status === 'LOCKED' ? 'That seat is locked by the host' : 'That seat is taken',
        seat.status === 'LOCKED' ? 'seat_locked' : 'seat_taken',
      );
    }
    if (seatIndex === 0 && room.host_id !== userId) {
      throw ApiError.forbidden('Only the host can sit in the host seat', 'seat_reserved');
    }

    // Step out of any previous seat first (CHECK constraint: OCCUPIED <=> user).
    await client.query(
      `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
        WHERE room_id = $1 AND user_id = $2`,
      [roomId, userId],
    );
    await client.query(
      `UPDATE room_seats SET user_id = $2, status = 'OCCUPIED', is_speaker = TRUE, is_muted = FALSE
        WHERE room_id = $1 AND seat_index = $3`,
      [roomId, userId, seatIndex],
    );
    await client.query(
      `UPDATE room_participants SET role = $3, seat_index = $4, hand_raised = FALSE
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, userId, room.host_id === userId ? 'HOST' : 'SPEAKER', seatIndex],
    );
  });

  // A client that is already in the SFU as a listener never re-dials when it
  // sits down, so the stored grant has to move with the seat.
  await setPublishPermission(room.livekit_room_name, userId, true);
  return { seats: await fetchSeats(roomId) };
}

export async function vacateSeat(userId: string, roomId: string): Promise<{ seats: SeatDto[] }> {
  const room = await loadRoom(roomId);
  const seat = await one<{ seat_index: number }>('SELECT seat_index FROM room_seats WHERE room_id = $1 AND user_id = $2', [
    roomId,
    userId,
  ]);
  if (!seat) throw ApiError.badRequest('You are not seated', 'not_seated');

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
        WHERE room_id = $1 AND seat_index = $2`,
      [roomId, seat.seat_index],
    );
    await client.query(
      `UPDATE room_participants SET role = 'AUDIENCE', seat_index = NULL WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, userId],
    );
  });
  await setPublishPermission(room.livekit_room_name, userId, false);
  return { seats: await fetchSeats(roomId) };
}

export async function setSeatLock(
  actorId: string,
  roomId: string,
  seatIndex: number,
  locked: boolean,
  opts: { asAdmin?: boolean } = {},
): Promise<{ seats: SeatDto[] }> {
  const room = await loadRoom(roomId);
  if (!opts.asAdmin && room.host_id !== actorId) throw ApiError.forbidden('Only the host can lock seats');
  if (seatIndex === 0 && !opts.asAdmin) throw ApiError.badRequest('The host seat cannot be locked');

  const occupied = await one<{ user_id: string }>(
    'SELECT user_id FROM room_seats WHERE room_id = $1 AND seat_index = $2',
    [roomId, seatIndex],
  );
  if (locked && occupied?.user_id) throw ApiError.conflict('Vacate the seat before locking it', 'seat_occupied');

  await query(
    `UPDATE room_seats SET status = $3 WHERE room_id = $1 AND seat_index = $2`,
    [roomId, seatIndex, locked ? 'LOCKED' : 'EMPTY'],
  );
  return { seats: await fetchSeats(roomId) };
}

/**
 * Mute is a two-sided action: the seat flag tells every client to draw the icon,
 * and the LiveKit participant permission stops the audio at the SFU so a hacked
 * client cannot keep talking over the host's decision.
 */
export async function setSeatMute(
  actorId: string,
  roomId: string,
  seatIndex: number,
  muted: boolean,
  opts: { asAdmin?: boolean } = {},
): Promise<{ seats: SeatDto[]; self: boolean }> {
  const room = await loadRoom(roomId);
  const seat = await one<{ user_id: string | null }>('SELECT user_id FROM room_seats WHERE room_id = $1 AND seat_index = $2', [
    roomId,
    seatIndex,
  ]);
  if (!seat) throw ApiError.notFound('Seat not found', 'seat_not_found');

  const isHost = room.host_id === actorId;
  const isSelf = seat.user_id === actorId;
  if (!opts.asAdmin) {
    if (!isHost && !isSelf) throw ApiError.forbidden('You do not control this seat');
    if (isSelf && !isHost && !muted) throw ApiError.forbidden('Only the host can unmute you');
  }

  await query('UPDATE room_seats SET is_muted = $3 WHERE room_id = $1 AND seat_index = $2', [
    roomId,
    seatIndex,
    muted,
  ]);
  if (seat.user_id) {
    const hasLiveAudio = await mutePublishedAudio(room.livekit_room_name, seat.user_id, muted);
    // Nothing to mute (connected but silent, or already gone) -> lock the right to
    // publish instead. Revoking it destroys live tracks that cannot be restored by
    // un-revoking, so it is only the fallback, never the path for a member who speaks.
    if (!hasLiveAudio) await setPublishPermission(room.livekit_room_name, seat.user_id, !muted);
  }
  return { seats: await fetchSeats(roomId), self: isSelf && !isHost };
}

/**
 * Ops-console silence: every occupied seat, host included. Only seats whose flag
 * actually changes are touched, so repeating the call cannot drop a member's live
 * tracks twice via the publish-permission fallback below.
 */
export async function setAllSeatsMuted(roomId: string, muted: boolean): Promise<{ seats: SeatDto[]; affected: number }> {
  const room = await loadRoom(roomId);
  const seats = await fetchSeats(roomId);
  const targets = seats.filter((s) => s.user && s.status === 'OCCUPIED' && s.isMuted !== muted);

  for (const seat of targets) {
    const userId = seat.user!.id;
    await query('UPDATE room_seats SET is_muted = $3 WHERE room_id = $1 AND seat_index = $2', [
      roomId,
      seat.seatIndex,
      muted,
    ]);
    const hasLiveAudio = await mutePublishedAudio(room.livekit_room_name, userId, muted);
    if (!hasLiveAudio) await setPublishPermission(room.livekit_room_name, userId, !muted);
  }
  return { seats: await fetchSeats(roomId), affected: targets.length };
}

export async function kickSeat(
  actorId: string,
  roomId: string,
  seatIndex: number,
  opts: { asAdmin?: boolean } = {},
): Promise<{ seats: SeatDto[]; kickedUserId: string | null }> {
  const room = await loadRoom(roomId);
  if (!opts.asAdmin && room.host_id !== actorId) throw ApiError.forbidden('Only the host can remove guests');
  if (seatIndex === 0 && !opts.asAdmin) throw ApiError.badRequest('The host seat cannot be removed');

  const seat = await one<{ user_id: string | null }>('SELECT user_id FROM room_seats WHERE room_id = $1 AND seat_index = $2', [
    roomId,
    seatIndex,
  ]);
  if (!seat?.user_id) return { seats: await fetchSeats(roomId), kickedUserId: null };

  const targetId = seat.user_id;
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
        WHERE room_id = $1 AND seat_index = $2`,
      [roomId, seatIndex],
    );
    await client.query(
      `UPDATE room_participants SET role = 'AUDIENCE', seat_index = NULL, hand_raised = FALSE
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, targetId],
    );
  });

  // Down to audience: take the microphone away at the SFU as well.
  await setPublishPermission(room.livekit_room_name, targetId, false);

  return { seats: await fetchSeats(roomId), kickedUserId: targetId };
}

export async function setHandRaised(
  userId: string,
  roomId: string,
  raise: boolean,
): Promise<{ raised: boolean }> {
  const seat = await one<{ seat_index: number }>('SELECT seat_index FROM room_seats WHERE room_id = $1 AND user_id = $2', [
    roomId,
    userId,
  ]);
  if (seat) throw ApiError.badRequest('You already have a seat', 'already_seated');

  const res = await one<{ updated: boolean }>(
    `UPDATE room_participants SET hand_raised = $3
      WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL
      RETURNING TRUE AS updated`,
    [roomId, userId, raise],
  );
  if (!res) throw ApiError.badRequest('Join the room first', 'not_in_room');
  return { raised: raise };
}

export async function appendChat(roomId: string, userId: string, content: string): Promise<ChatMessageDto> {
  const row = await one<ChatRow>(
    `INSERT INTO chat_messages (room_id, user_id, message_type, content)
     VALUES ($1,$2,'TEXT',$3)
     RETURNING *`,
    [roomId, userId, content],
  );
  const joined = await one<ChatRow>(
    `SELECT c.*, u.username, u.avatar_url FROM chat_messages c
     LEFT JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
    [row!.id],
  );
  return toChatMessage(joined!);
}

/** System line used for gift announcements so chat survives a reconnect. */
export async function appendSystemChat(roomId: string, content: string): Promise<ChatMessageDto> {
  const row = await one<ChatRow>(
    "INSERT INTO chat_messages (room_id, user_id, message_type, content) VALUES ($1,NULL,'SYSTEM',$2) RETURNING *",
    [roomId, content],
  );
  return toChatMessage(row!);
}

/**
 * Moderator announcement. `user_id` stays NULL because an admin is not a `users`
 * row — the operator's name goes into the text so the line is attributable in the
 * app, whose SYSTEM style already reads as an official notice.
 */
export async function appendModeratorChat(
  roomId: string,
  operator: string,
  content: string,
): Promise<ChatMessageDto> {
  const row = await one<ChatRow>(
    "INSERT INTO chat_messages (room_id, user_id, message_type, content) VALUES ($1,NULL,'SYSTEM',$2) RETURNING *",
    [roomId, `Moderator ${operator}: ${content}`.slice(0, 500)],
  );
  return toChatMessage(row!);
}

/**
 * Room-scoped removal that also blocks re-entry, which a plain disconnect does not:
 * the guest could simply tap the room again. `minutes` null means permanent.
 */
export async function banFromRoom(
  roomId: string,
  userId: string,
  opts: { adminId?: string | null; reason?: string | null; minutes?: number | null } = {},
): Promise<{ seats: SeatDto[]; wasPresent: boolean; expiresAt: string | null }> {
  const room = await loadRoom(roomId);
  if (room.host_id === userId) throw ApiError.badRequest('The host cannot be banned from their own room', 'host_ban');

  const expiresAt = opts.minutes ? new Date(Date.now() + opts.minutes * 60_000) : null;
  await one(
    `INSERT INTO room_bans (room_id, user_id, banned_by, reason, expires_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (room_id, user_id) DO UPDATE
       SET banned_by = EXCLUDED.banned_by, reason = EXCLUDED.reason,
           expires_at = EXCLUDED.expires_at, created_at = now()`,
    [roomId, userId, opts.adminId ?? null, opts.reason ?? null, expiresAt],
  );

  const kick = await disconnectFromRoom(roomId, userId);
  return { ...kick, expiresAt: expiresAt ? expiresAt.toISOString() : null };
}

export async function unbanFromRoom(roomId: string, userId: string): Promise<{ removed: boolean }> {
  const res = await query('DELETE FROM room_bans WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
  return { removed: Boolean(res.rowCount) };
}

export async function listRoomBans(roomId: string): Promise<
  Array<{ userId: string; username: string; reason: string | null; expiresAt: string | null; createdAt: string }>
> {
  const rows = await many<{
    user_id: string;
    username: string | null;
    reason: string | null;
    expires_at: Date | null;
    created_at: Date;
  }>(
    `SELECT b.user_id, u.username, b.reason, b.expires_at, b.created_at
       FROM room_bans b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.room_id = $1 AND (b.expires_at IS NULL OR b.expires_at > now())
      ORDER BY b.created_at DESC LIMIT 50`,
    [roomId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username ?? 'unknown',
    reason: r.reason,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export async function closeRoom(
  roomId: string,
  actorId: string | null,
  opts: { asAdmin?: boolean } = {},
): Promise<{ room: RoomDto }> {
  const room = await loadRoom(roomId);
  if (!opts.asAdmin && (!actorId || room.host_id !== actorId)) {
    throw ApiError.forbidden('Only the host can close this room');
  }

  const present = await fetchParticipants(roomId);

  await query("UPDATE rooms SET status = 'CLOSED', closed_at = now() WHERE id = $1", [roomId]);
  await query(
    `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
      WHERE room_id = $1`,
    [roomId],
  );
  await query('UPDATE room_participants SET left_at = now() WHERE room_id = $1 AND left_at IS NULL', [roomId]);

  // Drop everyone from the SFU: closing a room must actually stop the audio.
  await Promise.all(
    present.map((p) => removeLivekitParticipant(room.livekit_room_name, p.user_id).catch(() => undefined)),
  );

  return { room: toRoom(await loadRoom(roomId)) };
}

/**
 * Restyle a room: the theme slug picks the wallpaper and accent clients paint
 * behind the seat grid. Host-only unless an admin console is acting.
 */
export async function setRoomTheme(
  roomId: string,
  theme: string,
  actorId: string | null,
  opts: { asAdmin?: boolean } = {},
): Promise<{ room: RoomDto }> {
  if (!isTheme(theme)) {
    throw ApiError.badRequest(`theme must be one of: ${THEME_SLUGS.join(', ')}`, 'theme_unknown');
  }
  const room = await loadRoom(roomId);
  if (!opts.asAdmin && (!actorId || room.host_id !== actorId)) {
    throw ApiError.forbidden('Only the host can restyle this room', 'not_host');
  }
  await query('UPDATE rooms SET theme = $2 WHERE id = $1', [roomId, theme]);
  return { room: toRoom(await loadRoom(roomId)) };
}

/**
 * Language and region are ISO tags, not free text, because the lobby filters them with `=`:
 * 'EN' and 'en' must not become two different rooms. A tag that is not well-formed is refused
 * instead of stored — a filter value nobody can type again silently hides the room forever.
 */
export function normalizeLanguage(value: string | null | undefined): string | null {
  const tag = (value ?? '').trim().toLowerCase();
  if (!tag) return null;
  if (!/^[a-z]{2}(-[a-z0-9]{2,8})*$/.test(tag)) {
    throw ApiError.badRequest("language must be an ISO 639-1 tag, e.g. 'en' or 'en-US'", 'language_invalid');
  }
  return tag;
}

export function normalizeRegion(value: string | null | undefined): string | null {
  const tag = (value ?? '').trim().toUpperCase();
  if (!tag) return null;
  if (!/^[A-Z]{2}$/.test(tag)) {
    throw ApiError.badRequest("region must be an ISO 3166-1 alpha-2 code, e.g. 'US'", 'region_invalid');
  }
  return tag;
}

/** House rules are host-written prose; the cap is the column's, enforced here so the client gets a 400, not a 500. */
export function normalizeRules(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (text.length > RULES_MAX_LENGTH) {
    throw ApiError.badRequest(`rules must be ${RULES_MAX_LENGTH} characters or fewer`, 'rules_too_long');
  }
  return text;
}

export const RULES_MAX_LENGTH = 1000;

export type UpdateRoomInput = {
  title?: string;
  description?: string | null;
  category?: RoomRow['category'];
  coverUrl?: string | null;
  language?: string | null;
  region?: string | null;
  rules?: string | null;
};

/**
 * Edit the room's own profile. Host-only — an operator uses the admin console, which records
 * its actions in `admin_audit`, and this route must not become a second, unaudited way in.
 *
 * A field that is absent is left alone; an empty string clears it. The category may change
 * while the room is live: `ambientEffect` is derived from it on every payload, so the clients
 * pick up the new look on the next seat or listener broadcast.
 */
export async function updateRoom(
  roomId: string,
  actorId: string | null,
  patch: UpdateRoomInput,
): Promise<{ room: RoomDto }> {
  const room = await loadRoom(roomId);
  if (!actorId || room.host_id !== actorId) {
    throw ApiError.forbidden('Only the host can edit this room', 'not_host');
  }
  assertActive(room);

  const sets: string[] = [];
  const params: unknown[] = [roomId];
  const put = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (patch.title !== undefined) put('title', patch.title);
  if (patch.description !== undefined) put('description', trimOrNull(patch.description, 200, 'description'));
  if (patch.category !== undefined) put('category', patch.category);
  if (patch.coverUrl !== undefined) put('cover_url', trimOrNull(patch.coverUrl, 500, 'coverUrl'));
  if (patch.language !== undefined) put('language', normalizeLanguage(patch.language));
  if (patch.region !== undefined) put('region', normalizeRegion(patch.region));
  if (patch.rules !== undefined) put('rules', normalizeRules(patch.rules));
  if (!sets.length) throw ApiError.badRequest('Nothing to change', 'empty_update');

  await query(`UPDATE rooms SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  return { room: toRoom(await loadRoom(roomId)) };
}

function trimOrNull(value: string | null | undefined, max: number, field: string): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (text.length > max) throw ApiError.badRequest(`${field} must be ${max} characters or fewer`, `${field}_too_long`);
  return text;
}

/**
 * Delete eligible rooms only. "Eligible" is deliberately narrow: the host asks, the room is
 * already closed, and nothing about it is history anyone can still point at — nobody but the
 * host ever stood in it and no ledger row names it. `transactions.room_id` is `ON DELETE SET
 * NULL` and `chat_messages`/`room_participants` cascade, so deleting an attended room would
 * quietly re-file money under "no room" and erase the conversation it happened in. A room with
 * a past gets closed and stays; that is what the 409 says.
 *
 * The host's own `room_participants` row does not count as a visitor — creation writes it, so
 * without the `role <> 'HOST'` filter no room on the platform would ever qualify.
 */
export async function deleteRoom(roomId: string, actorId: string | null): Promise<{ deletedRoomId: string }> {
  const room = await loadRoom(roomId);
  if (!actorId || room.host_id !== actorId) {
    throw ApiError.forbidden('Only the host can delete this room', 'not_host');
  }
  if (room.status !== 'CLOSED') {
    throw ApiError.conflict('Close the room before deleting it', 'room_active');
  }

  const history = await one<{ members: string; ledger: string }>(
    `SELECT
       (SELECT COUNT(*) FROM room_participants WHERE room_id = $1 AND role <> 'HOST')::text AS members,
       (SELECT COUNT(*) FROM transactions WHERE room_id = $1)::text AS ledger`,
    [roomId],
  );
  if (!history) throw ApiError.notFound('Room not found', 'room_not_found');
  if (Number(history.members) > 0 || Number(history.ledger) > 0) {
    throw ApiError.conflict(
      `This room has history (${history.members} member row(s), ${history.ledger} ledger row(s)); closed rooms are kept`,
      'room_has_history',
    );
  }

  await withTransaction(async (client) => {
    // Seats and bans cascade; the LiveKit room is already empty after a close.
    await client.query('DELETE FROM rooms WHERE id = $1', [roomId]);
  });
  return { deletedRoomId: roomId };
}

/**
 * Hard removal used by moderation: the guest loses their seat (if any), their
 * presence row, and their SFU connection in one call.
 */
export async function disconnectFromRoom(roomId: string, userId: string): Promise<{ seats: SeatDto[]; wasPresent: boolean }> {
  const room = await loadRoom(roomId);
  const seat = await one<{ seat_index: number }>('SELECT seat_index FROM room_seats WHERE room_id = $1 AND user_id = $2', [
    roomId,
    userId,
  ]);
  const present = await one<{ id: string }>(
    'SELECT id FROM room_participants WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL',
    [roomId, userId],
  );

  if (seat) {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
          WHERE room_id = $1 AND seat_index = $2`,
        [roomId, seat.seat_index],
      );
    });
  }
  if (present) {
    await query('UPDATE room_participants SET left_at = now() WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL', [
      roomId,
      userId,
    ]);
  }
  await removeLivekitParticipant(room.livekit_room_name, userId);
  await recomputeListenerCount(roomId);
  return { seats: await fetchSeats(roomId), wasPresent: Boolean(present || seat) };
}

export async function recomputeListenerCount(roomId: string): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT user_id FROM room_participants WHERE room_id = $1 AND left_at IS NULL
     ) x`,
    [roomId],
  );
  const count = Number(row?.n ?? 0);
  await query('UPDATE rooms SET listener_count = $2 WHERE id = $1', [roomId, count]);
  return count;
}
