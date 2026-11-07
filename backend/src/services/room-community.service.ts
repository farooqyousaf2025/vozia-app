import { many, one, query, withTransaction } from '../config/db';
import { RoomRow, SeatRow } from '../types/db';
import { ApiError } from '../utils/http';
import { MiniUser, RoomDto, SeatDto, toMiniUser, toRoom } from '../utils/serialize';
import { setPublishPermission } from './livekit.service';
import { fetchSeats, loadRoom, ROOM_SELECT, takeSeat, ANNOUNCEMENT_MAX_LENGTH } from './room.service';

/**
 * The room controls a host owns beyond mute/kick: a pinned notice, an approval queue for the
 * microphone, direct invitations, favourite rooms and handing the room over.
 *
 * It lives beside `room.service` rather than inside it because none of this is part of keeping
 * seats consistent. The approval queue in particular is a small state machine of its own, and
 * keeping it separate makes the seat invariants easier to read.
 */

export const TRANSFER_NOTE_MAX_LENGTH = 200;

/** Empty means "remove the banner"; the host clears a notice by saving a blank line. */
export function normalizeAnnouncement(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw ApiError.badRequest('announcement must be a string');
  const text = value.trim();
  if (!text) return null;
  if (text.length > ANNOUNCEMENT_MAX_LENGTH) {
    throw ApiError.badRequest(
      `announcement must be ${ANNOUNCEMENT_MAX_LENGTH} characters or fewer`,
      'announcement_too_long',
    );
  }
  return text;
}

export function normalizeTransferNote(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw ApiError.badRequest('note must be a string');
  const text = value.trim();
  if (!text) return null;
  if (text.length > TRANSFER_NOTE_MAX_LENGTH) {
    throw ApiError.badRequest(`note must be ${TRANSFER_NOTE_MAX_LENGTH} characters or fewer`, 'note_too_long');
  }
  return text;
}

export type SpeakerRequestDto = {
  id: string;
  roomId: string;
  seatIndex: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';
  createdAt: string;
  user: MiniUser;
};

type SpeakerRequestRow = {
  id: string;
  room_id: string;
  user_id: string;
  seat_index: number;
  status: SpeakerRequestDto['status'];
  created_at: Date;
  username: string;
  avatar_url: string | null;
  vip_level: number;
  xp: string | number;
  profile_frame_key: string | null;
  profile_frame_expires_at: Date | null;
};

const SPEAKER_REQUEST_SELECT = `
  SELECT r.*, u.username, u.avatar_url, u.vip_level, u.xp,
         u.profile_frame_key, u.profile_frame_expires_at
    FROM room_speaker_requests r
    JOIN users u ON u.id = r.user_id`;

function toSpeakerRequest(row: SpeakerRequestRow): SpeakerRequestDto {
  return {
    id: row.id,
    roomId: row.room_id,
    seatIndex: row.seat_index,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    // `r.*` wins the `id` column, so the joined member has to be named from `user_id`; reading
    // `row.id` here would hand the client the request's uuid as the speaker's identity.
    user: toMiniUser({ ...row, id: row.user_id }),
  };
}

// ---------------------------------------------------------------------------
// Pinned announcement
// ---------------------------------------------------------------------------

/**
 * Host-only, unless an operator is clearing it. The timestamp moves on a clear as well, so a
 * client can tell "the host removed the notice" from "the notice was never there".
 */
export async function setAnnouncement(
  roomId: string,
  actorId: string | null,
  value: unknown,
  opts: { asAdmin?: boolean } = {},
): Promise<RoomDto> {
  const room = await loadRoom(roomId);
  if (!opts.asAdmin && (!actorId || room.host_id !== actorId)) {
    throw ApiError.forbidden('Only the host can pin a notice', 'not_host');
  }
  if (room.status !== 'ACTIVE') throw ApiError.conflict('This room is closed', 'room_closed');

  const announcement = normalizeAnnouncement(value);
  await query(
    `UPDATE rooms SET announcement = $2, announcement_updated_at = now(), updated_at = now()
      WHERE id = $1`,
    [roomId, announcement],
  );
  return toRoom(await loadRoom(roomId));
}

// ---------------------------------------------------------------------------
// Speaker approval
// ---------------------------------------------------------------------------

/**
 * Turning approval off cancels the queue rather than leaving requests that can never be answered.
 * A member whose request vanished simply taps a seat again and sits immediately.
 */
export async function setSpeakerApproval(
  roomId: string,
  actorId: string,
  required: boolean,
): Promise<{ room: RoomDto; cancelled: number }> {
  const room = await loadRoom(roomId);
  if (room.host_id !== actorId) throw ApiError.forbidden('Only the host can change this', 'not_host');
  if (room.status !== 'ACTIVE') throw ApiError.conflict('This room is closed', 'room_closed');

  const cancelled = await withTransaction(async (client) => {
    await client.query(
      'UPDATE rooms SET speaker_approval_required = $2, updated_at = now() WHERE id = $1',
      [roomId, required],
    );
    if (required) return 0;
    const res = await client.query(
      `UPDATE room_speaker_requests
          SET status = 'CANCELLED', decided_by = $2, decided_at = now()
        WHERE room_id = $1 AND status = 'PENDING'`,
      [roomId, actorId],
    );
    return res.rowCount ?? 0;
  });

  return { room: toRoom(await loadRoom(roomId)), cancelled };
}

export type SeatTakeOutcome =
  | { kind: 'seated'; seats: SeatDto[] }
  | { kind: 'requested'; request: SpeakerRequestDto; hostId: string };

/**
 * `POST /rooms/:id/seat` behind the approval switch.
 *
 * The host (and seat 0) keep the original behaviour. Every other member either sits immediately
 * when approval is off, or files one PENDING request — two taps return the same request thanks to
 * the partial unique index, so a client that retries after a timeout is not queued twice.
 */
export async function takeSeatOrRequest(
  userId: string,
  roomId: string,
  seatIndex: number,
): Promise<SeatTakeOutcome> {
  const room = await loadRoom(roomId);
  if (room.status !== 'ACTIVE') throw ApiError.conflict('This room is closed', 'room_closed');
  if (seatIndex >= room.seat_capacity) throw ApiError.badRequest('No such seat in this room');
  if (seatIndex === 0 && room.host_id !== userId) {
    throw ApiError.forbidden('Only the host can sit in the host seat', 'seat_reserved');
  }
  if (room.host_id === userId || !room.speaker_approval_required) {
    return { kind: 'seated', seats: (await takeSeat(userId, roomId, seatIndex)).seats };
  }
  if (seatIndex === 0) throw ApiError.badRequest('The host seat is not requestable', 'seat_reserved');

  const present = await one<{ id: string }>(
    'SELECT id FROM room_participants WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL',
    [roomId, userId],
  );
  if (!present) throw ApiError.badRequest('Join the room first', 'not_in_room');

  const seat = await one<{ status: SeatRow['status'] }>(
    'SELECT status FROM room_seats WHERE room_id = $1 AND seat_index = $2',
    [roomId, seatIndex],
  );
  if (!seat) throw ApiError.notFound('Seat not found', 'seat_not_found');
  if (seat.status !== 'EMPTY') {
    throw ApiError.conflict(
      seat.status === 'LOCKED' ? 'That seat is locked by the host' : 'That seat is taken',
      seat.status === 'LOCKED' ? 'seat_locked' : 'seat_taken',
    );
  }

  const existing = await one<SpeakerRequestRow>(
    `${SPEAKER_REQUEST_SELECT}
      WHERE r.room_id = $1 AND r.user_id = $2 AND r.status = 'PENDING'`,
    [roomId, userId],
  );
  if (existing) return { kind: 'requested', request: toSpeakerRequest(existing), hostId: room.host_id };

  const inserted = await one<{ id: string }>(
    `INSERT INTO room_speaker_requests (room_id, user_id, seat_index)
     VALUES ($1, $2, $3)
     ON CONFLICT (room_id, user_id) WHERE status = 'PENDING' DO NOTHING
     RETURNING id`,
    [roomId, userId, seatIndex],
  );
  const requestId =
    inserted?.id ??
    (
      await one<{ id: string }>(
        `SELECT id FROM room_speaker_requests
          WHERE room_id = $1 AND user_id = $2 AND status = 'PENDING'`,
        [roomId, userId],
      )
    )?.id;
  const row = requestId ? await one<SpeakerRequestRow>(`${SPEAKER_REQUEST_SELECT} WHERE r.id = $1`, [requestId]) : null;
  if (!row) throw ApiError.conflict('Could not file the speaker request', 'speaker_request_failed');
  return { kind: 'requested', request: toSpeakerRequest(row), hostId: room.host_id };
}

export async function listSpeakerRequests(roomId: string, actorId: string): Promise<SpeakerRequestDto[]> {
  const room = await loadRoom(roomId);
  if (room.host_id !== actorId) throw ApiError.forbidden('Only the host can see the queue', 'not_host');
  const rows = await many<SpeakerRequestRow>(
    `${SPEAKER_REQUEST_SELECT}
      WHERE r.room_id = $1 AND r.status = 'PENDING'
      ORDER BY r.created_at`,
    [roomId],
  );
  return rows.map(toSpeakerRequest);
}

export async function cancelSpeakerRequest(userId: string, roomId: string): Promise<{ cancelled: number }> {
  const res = await query(
    `UPDATE room_speaker_requests
        SET status = 'CANCELLED', decided_by = $2, decided_at = now()
      WHERE room_id = $1 AND user_id = $2 AND status = 'PENDING'`,
    [roomId, userId],
  );
  return { cancelled: res.rowCount ?? 0 };
}

/**
 * Approve seats the requester at the seat they asked for. If somebody else took it while the
 * request waited, the host gets a normal `seat_taken` conflict and can reject instead — silently
 * moving the member to another seat would make the notification a lie.
 */
export async function approveSpeakerRequest(
  roomId: string,
  actorId: string,
  requestId: string,
): Promise<{ userId: string; seatIndex: number; request: SpeakerRequestDto; seats: SeatDto[] }> {
  const room = await loadRoom(roomId);
  if (room.host_id !== actorId) throw ApiError.forbidden('Only the host can approve a seat', 'not_host');
  if (room.status !== 'ACTIVE') throw ApiError.conflict('This room is closed', 'room_closed');

  const decided = await withTransaction(async (client) => {
    const request = (
      await client.query<SpeakerRequestRow>(
        'SELECT * FROM room_speaker_requests WHERE id = $1 AND room_id = $2 FOR UPDATE',
        [requestId, roomId],
      )
    ).rows[0];
    if (!request) throw ApiError.notFound('Speaker request not found', 'speaker_request_not_found');
    if (request.status !== 'PENDING') {
      throw ApiError.conflict('This request was already decided', 'speaker_request_decided');
    }

    const seat = (
      await client.query<SeatRow>('SELECT * FROM room_seats WHERE room_id = $1 AND seat_index = $2 FOR UPDATE', [
        roomId,
        request.seat_index,
      ])
    ).rows[0];
    if (!seat) throw ApiError.notFound('Seat not found', 'seat_not_found');
    if (seat.status !== 'EMPTY') {
      throw ApiError.conflict(
        seat.status === 'LOCKED' ? 'That seat is locked by the host' : 'That seat was taken',
        seat.status === 'LOCKED' ? 'seat_locked' : 'seat_taken',
      );
    }

    const present = await client.query(
      'SELECT id FROM room_participants WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL',
      [roomId, request.user_id],
    );
    if (present.rowCount === 0) {
      await client.query(
        `UPDATE room_speaker_requests SET status = 'EXPIRED', decided_by = $2, decided_at = now() WHERE id = $1`,
        [requestId, actorId],
      );
      throw ApiError.conflict('The member left the room', 'requester_left');
    }

    await client.query(
      `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
        WHERE room_id = $1 AND user_id = $2`,
      [roomId, request.user_id],
    );
    await client.query(
      `UPDATE room_seats SET user_id = $3, status = 'OCCUPIED', is_speaker = TRUE, is_muted = FALSE
        WHERE room_id = $1 AND seat_index = $2`,
      [roomId, request.seat_index, request.user_id],
    );
    await client.query(
      `UPDATE room_participants SET role = 'SPEAKER', seat_index = $3, hand_raised = FALSE
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, request.user_id, request.seat_index],
    );
    await client.query(
      `UPDATE room_speaker_requests SET status = 'APPROVED', decided_by = $2, decided_at = now() WHERE id = $1`,
      [requestId, actorId],
    );
    return { userId: request.user_id, seatIndex: request.seat_index };
  });

  await setPublishPermission(room.livekit_room_name, decided.userId, true);
  const row = await one<SpeakerRequestRow>(`${SPEAKER_REQUEST_SELECT} WHERE r.id = $1`, [requestId]);
  return { ...decided, request: toSpeakerRequest(row!), seats: await fetchSeats(roomId) };
}

export async function rejectSpeakerRequest(
  roomId: string,
  actorId: string,
  requestId: string,
): Promise<{ userId: string; request: SpeakerRequestDto }> {
  const room = await loadRoom(roomId);
  if (room.host_id !== actorId) throw ApiError.forbidden('Only the host can reject a seat', 'not_host');

  const row = await one<{ user_id: string }>(
    `UPDATE room_speaker_requests
        SET status = 'REJECTED', decided_by = $3, decided_at = now()
      WHERE id = $1 AND room_id = $2 AND status = 'PENDING'
      RETURNING user_id`,
    [requestId, roomId, actorId],
  );
  if (!row) {
    const exists = await one<{ id: string }>(
      'SELECT id FROM room_speaker_requests WHERE id = $1 AND room_id = $2',
      [requestId, roomId],
    );
    if (!exists) throw ApiError.notFound('Speaker request not found', 'speaker_request_not_found');
    throw ApiError.conflict('This request was already decided', 'speaker_request_decided');
  }
  const decided = await one<SpeakerRequestRow>(`${SPEAKER_REQUEST_SELECT} WHERE r.id = $1`, [requestId]);
  return { userId: row.user_id, request: toSpeakerRequest(decided!) };
}

// ---------------------------------------------------------------------------
// Host invitation
// ---------------------------------------------------------------------------

/**
 * A host may seat a member who is already in the audience without waiting for a request. This is
 * the "speaker invitation" half of the brief: the host decides, the member does not have to ask.
 * The member can still step down with the normal leave route.
 */
export async function inviteToSeat(
  roomId: string,
  actorId: string,
  seatIndex: number,
  targetUserId: string,
): Promise<{ seats: SeatDto[]; userId: string; seatIndex: number }> {
  const room = await loadRoom(roomId);
  if (room.host_id !== actorId) throw ApiError.forbidden('Only the host can invite a speaker', 'not_host');
  if (room.status !== 'ACTIVE') throw ApiError.conflict('This room is closed', 'room_closed');
  if (seatIndex === 0) throw ApiError.badRequest('The host seat cannot be handed out', 'seat_reserved');
  if (seatIndex >= room.seat_capacity) throw ApiError.badRequest('No such seat in this room');
  if (targetUserId === actorId) throw ApiError.badRequest('You already own the room', 'self_invite');

  const target = await one<{ id: string; status: string }>('SELECT id, status FROM users WHERE id = $1', [targetUserId]);
  if (!target || target.status !== 'ACTIVE') throw ApiError.notFound('User not found', 'user_not_found');
  const banned = await one<{ room_id: string }>('SELECT room_id FROM room_bans WHERE room_id = $1 AND user_id = $2', [
    roomId,
    targetUserId,
  ]);
  if (banned) throw ApiError.forbidden('That member is banned from this room', 'room_banned');
  const present = await one<{ id: string }>(
    'SELECT id FROM room_participants WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL',
    [roomId, targetUserId],
  );
  if (!present) throw ApiError.badRequest('That member is not in the room', 'not_in_room');

  await withTransaction(async (client) => {
    const seat = (
      await client.query<SeatRow>('SELECT * FROM room_seats WHERE room_id = $1 AND seat_index = $2 FOR UPDATE', [
        roomId,
        seatIndex,
      ])
    ).rows[0];
    if (!seat) throw ApiError.notFound('Seat not found', 'seat_not_found');
    if (seat.status !== 'EMPTY') {
      throw ApiError.conflict(
        seat.status === 'LOCKED' ? 'That seat is locked by the host' : 'That seat is taken',
        seat.status === 'LOCKED' ? 'seat_locked' : 'seat_taken',
      );
    }

    await client.query(
      `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
        WHERE room_id = $1 AND user_id = $2`,
      [roomId, targetUserId],
    );
    await client.query(
      `UPDATE room_seats SET user_id = $3, status = 'OCCUPIED', is_speaker = TRUE, is_muted = FALSE
        WHERE room_id = $1 AND seat_index = $2`,
      [roomId, seatIndex, targetUserId],
    );
    await client.query(
      `UPDATE room_participants SET role = 'SPEAKER', seat_index = $3, hand_raised = FALSE
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, targetUserId, seatIndex],
    );
    // If they had asked, the invitation answers the request.
    await client.query(
      `UPDATE room_speaker_requests SET status = 'APPROVED', decided_by = $3, decided_at = now()
        WHERE room_id = $1 AND user_id = $2 AND status = 'PENDING'`,
      [roomId, targetUserId, actorId],
    );
  });

  await setPublishPermission(room.livekit_room_name, targetUserId, true);
  return { seats: await fetchSeats(roomId), userId: targetUserId, seatIndex };
}

// ---------------------------------------------------------------------------
// Ownership transfer
// ---------------------------------------------------------------------------

/**
 * Hand the room to another member. The target must already be inside: an owner who is not present
 * cannot moderate, and a transfer to an absent phone would leave the room effectively unhosted.
 *
 * The old host steps down to the audience; the new host takes seat 0. Every step runs in one
 * transaction after locking the room row, so two simultaneous transfers cannot both win. The live
 * SFU grant moves with it, and short-lived tokens mean the old host's host-scoped token expires on
 * its own; the microphone is revoked immediately.
 */
export async function transferRoomOwnership(
  roomId: string,
  actorId: string,
  targetUserId: string,
  note?: unknown,
): Promise<{ room: RoomDto; previousHostId: string; host: MiniUser }> {
  const room = await loadRoom(roomId);
  if (room.host_id !== actorId) throw ApiError.forbidden('Only the host can transfer the room', 'not_host');
  if (room.status !== 'ACTIVE') throw ApiError.conflict('This room is closed', 'room_closed');
  if (targetUserId === actorId) throw ApiError.badRequest('You already own the room', 'self_transfer');

  const target = await one<{
    id: string;
    username: string;
    avatar_url: string | null;
    vip_level: number;
    xp: string | number;
    profile_frame_key: string | null;
    profile_frame_expires_at: Date | null;
    status: string;
  }>(
    `SELECT id, username, avatar_url, vip_level, xp, profile_frame_key, profile_frame_expires_at, status
       FROM users WHERE id = $1`,
    [targetUserId],
  );
  if (!target || target.status !== 'ACTIVE') throw ApiError.notFound('User not found', 'user_not_found');
  const banned = await one<{ room_id: string }>('SELECT room_id FROM room_bans WHERE room_id = $1 AND user_id = $2', [
    roomId,
    targetUserId,
  ]);
  if (banned) throw ApiError.forbidden('That member is banned from this room', 'room_banned');

  const transferNote = normalizeTransferNote(note);
  const previousHostId = room.host_id;

  await withTransaction(async (client) => {
    const locked = (
      await client.query<RoomRow>('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [roomId])
    ).rows[0];
    if (!locked || locked.host_id !== actorId) {
      throw ApiError.conflict('The room changed hands while you were transferring it', 'room_changed_hands');
    }

    const present = (
      await client.query(
        'SELECT id FROM room_participants WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL',
        [roomId, targetUserId],
      )
    ).rows[0];
    if (!present) throw ApiError.badRequest('That member is not in the room', 'not_in_room');

    await client.query(
      `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
        WHERE room_id = $1 AND user_id = ANY($2::uuid[])`,
      [roomId, [actorId, targetUserId]],
    );
    await client.query('UPDATE rooms SET host_id = $2, updated_at = now() WHERE id = $1', [roomId, targetUserId]);
    await client.query(
      `UPDATE room_seats SET user_id = $2, status = 'OCCUPIED', is_speaker = TRUE, is_muted = FALSE
        WHERE room_id = $1 AND seat_index = 0`,
      [roomId, targetUserId],
    );
    await client.query(
      `UPDATE room_participants SET role = 'AUDIENCE', seat_index = NULL, hand_raised = FALSE
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, actorId],
    );
    await client.query(
      `UPDATE room_participants SET role = 'HOST', seat_index = 0, hand_raised = FALSE
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, targetUserId],
    );
    await client.query(
      `INSERT INTO room_ownership_transfers (room_id, from_user_id, to_user_id, note)
       VALUES ($1, $2, $3, $4)`,
      [roomId, actorId, targetUserId, transferNote],
    );
  });

  await setPublishPermission(room.livekit_room_name, targetUserId, true);
  await setPublishPermission(room.livekit_room_name, previousHostId, false);

  return {
    room: toRoom(await loadRoom(roomId)),
    previousHostId,
    host: toMiniUser(target),
  };
}

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

export async function addFavorite(userId: string, roomId: string): Promise<{ favorited: true }> {
  const room = await one<{ id: string; status: string }>('SELECT id, status FROM rooms WHERE id = $1', [roomId]);
  if (!room) throw ApiError.notFound('Room not found', 'room_not_found');
  await query(
    `INSERT INTO room_favorites (user_id, room_id) VALUES ($1, $2)
     ON CONFLICT (user_id, room_id) DO NOTHING`,
    [userId, roomId],
  );
  return { favorited: true };
}

export async function removeFavorite(userId: string, roomId: string): Promise<{ favorited: false }> {
  await query('DELETE FROM room_favorites WHERE user_id = $1 AND room_id = $2', [userId, roomId]);
  return { favorited: false };
}

export async function favoriteState(userId: string, roomId: string): Promise<{ favorited: boolean }> {
  const row = await one<{ user_id: string }>('SELECT user_id FROM room_favorites WHERE user_id = $1 AND room_id = $2', [
    userId,
    roomId,
  ]);
  return { favorited: Boolean(row) };
}

/**
 * Saved rooms, open ones first. Closed rooms stay in the list — a favourite is a bookmark, and
 * silently dropping it when the host closes for the night would be surprising.
 */
export async function listFavoriteRooms(userId: string, limit: number, offset: number): Promise<RoomDto[]> {
  const rows = await many<RoomRow>(
    `${ROOM_SELECT}
      JOIN room_favorites f ON f.room_id = r.id
     WHERE f.user_id = $1
     ORDER BY (r.status = 'ACTIVE') DESC, f.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return rows.map(toRoom);
}
