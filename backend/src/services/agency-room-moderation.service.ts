import { many, one, query, withTransaction } from '../config/db';
import { ApiError } from '../utils/http';
import { disconnectFromRoom, fetchSeats } from './room.service';
import { SeatDto } from '../utils/serialize';
import { mutePublishedAudio, setPublishPermission } from './livekit.service';

type AgencyRoomScope = {
  agency_id: string;
  room_id: string;
  host_user_id: string;
  livekit_room_name: string;
};

async function assignedRoom(actorUserId: string, agencyId: string, roomId: string): Promise<AgencyRoomScope> {
  const scope = await one<AgencyRoomScope>(
    `SELECT a.id AS agency_id, r.id AS room_id, r.host_id AS host_user_id,
            r.livekit_room_name
       FROM agencies a
       JOIN agency_hosts ah ON ah.agency_id = a.id
       JOIN rooms r ON r.host_id = ah.host_user_id
      WHERE a.owner_user_id = $1 AND a.id = $2 AND a.status = 'ACTIVE'
        AND ah.status = 'ACTIVE' AND r.id = $3 AND r.status = 'ACTIVE'
      LIMIT 1`,
    [actorUserId, agencyId, roomId],
  );
  if (!scope) {
    throw ApiError.forbidden('You may moderate only active rooms owned by hosts currently assigned to your agency', 'agency_room_scope_denied');
  }
  return scope;
}

async function assertTarget(scope: AgencyRoomScope, targetUserId: string): Promise<void> {
  if (targetUserId === scope.host_user_id) {
    throw ApiError.forbidden('Agency moderators cannot moderate the room owner', 'agency_host_protected');
  }
  const present = await one<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM room_participants WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL
       UNION ALL
       SELECT 1 FROM room_seats WHERE room_id = $1 AND user_id = $2
     ) AS present`,
    [scope.room_id, targetUserId],
  );
  if (!present?.present) throw ApiError.notFound('The target is not currently in this room', 'room_target_not_present');
}

async function audit(scope: AgencyRoomScope, actorUserId: string, targetUserId: string, action: string, reason?: string | null, details: Record<string, unknown> = {}) {
  await query(
    `INSERT INTO agency_room_moderation_audit
       (agency_id, actor_user_id, room_id, host_user_id, target_user_id, action, reason, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [scope.agency_id, actorUserId, scope.room_id, scope.host_user_id, targetUserId, action, reason ?? null, JSON.stringify(details)],
  );
}

export async function agencyMuteRoomMember(actorUserId: string, agencyId: string, roomId: string, targetUserId: string, muted: boolean): Promise<{ seats: SeatDto[] }> {
  const scope = await assignedRoom(actorUserId, agencyId, roomId);
  await assertTarget(scope, targetUserId);
  const seat = await one<{ seat_index: number }>(
    'SELECT seat_index FROM room_seats WHERE room_id = $1 AND user_id = $2 AND status = \'OCCUPIED\'',
    [roomId, targetUserId],
  );
  if (!seat) throw ApiError.badRequest('Only a seated speaker can be muted by agency moderation', 'target_not_seated');
  await query('UPDATE room_seats SET is_muted = $3 WHERE room_id = $1 AND seat_index = $2', [roomId, seat.seat_index, muted]);
  const hasLiveAudio = await mutePublishedAudio(scope.livekit_room_name, targetUserId, muted);
  if (!hasLiveAudio) await setPublishPermission(scope.livekit_room_name, targetUserId, !muted);
  await audit(scope, actorUserId, targetUserId, muted ? 'MUTE' : 'UNMUTE');
  return { seats: await fetchSeats(roomId) };
}

export async function agencyKickRoomMember(actorUserId: string, agencyId: string, roomId: string, targetUserId: string, reason?: string | null): Promise<{ seats: SeatDto[]; wasPresent: boolean }> {
  const scope = await assignedRoom(actorUserId, agencyId, roomId);
  await assertTarget(scope, targetUserId);
  const result = await disconnectFromRoom(roomId, targetUserId);
  await audit(scope, actorUserId, targetUserId, 'KICK', reason);
  return result;
}

export async function agencyBanRoomMember(actorUserId: string, agencyId: string, roomId: string, targetUserId: string, reason?: string | null, minutes?: number | null): Promise<{ seats: SeatDto[]; wasPresent: boolean; expiresAt: string | null }> {
  const scope = await assignedRoom(actorUserId, agencyId, roomId);
  await assertTarget(scope, targetUserId);
  const expiresAt = minutes ? new Date(Date.now() + minutes * 60_000) : null;
  await withTransaction(async (client) => {
    const existingBan = await client.query<{ banned_by: string | null; banned_by_agency_user_id: string | null }>(
      'SELECT banned_by, banned_by_agency_user_id FROM room_bans WHERE room_id = $1 AND user_id = $2 FOR UPDATE',
      [roomId, targetUserId],
    );
    if (existingBan.rows[0]?.banned_by) {
      throw ApiError.forbidden('An operator-issued room ban cannot be replaced by an agency moderator', 'operator_ban_protected');
    }
    await client.query(
      `INSERT INTO room_bans (room_id, user_id, banned_by, banned_by_agency_user_id, reason, expires_at)
       VALUES ($1,$2,NULL,$3,$4,$5)
       ON CONFLICT (room_id, user_id) DO UPDATE
         SET banned_by_agency_user_id = EXCLUDED.banned_by_agency_user_id,
             reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, created_at = now()`,
      [roomId, targetUserId, actorUserId, reason ?? null, expiresAt],
    );
    await client.query(
      `INSERT INTO agency_room_moderation_audit
         (agency_id, actor_user_id, room_id, host_user_id, target_user_id, action, reason, details)
       VALUES ($1,$2,$3,$4,$5,'BAN',$6,$7::jsonb)`,
      [scope.agency_id, actorUserId, roomId, scope.host_user_id, targetUserId, reason ?? null, JSON.stringify({ minutes: minutes ?? null })],
    );
  });
  const result = await disconnectFromRoom(roomId, targetUserId);
  return { ...result, expiresAt: expiresAt?.toISOString() ?? null };
}

export async function agencyUnbanRoomMember(actorUserId: string, agencyId: string, roomId: string, targetUserId: string): Promise<{ removed: boolean }> {
  const scope = await assignedRoom(actorUserId, agencyId, roomId);
  if (targetUserId === scope.host_user_id) throw ApiError.forbidden('Agency moderators cannot act on the room owner', 'agency_host_protected');
  return withTransaction(async (client) => {
    const deleted = await client.query(
      'DELETE FROM room_bans WHERE room_id = $1 AND user_id = $2 AND banned_by_agency_user_id IS NOT NULL',
      [roomId, targetUserId],
    );
    if (deleted.rowCount) {
      await client.query(
        `INSERT INTO agency_room_moderation_audit
           (agency_id, actor_user_id, room_id, host_user_id, target_user_id, action)
         VALUES ($1,$2,$3,$4,$5,'UNBAN')`,
        [scope.agency_id, actorUserId, roomId, scope.host_user_id, targetUserId],
      );
    }
    return { removed: Boolean(deleted.rowCount) };
  });
}

export async function listAgencyRoomModerationAudit(actorUserId: string, agencyId: string, roomId: string, limit = 50) {
  const scope = await assignedRoom(actorUserId, agencyId, roomId);
  return many(
    `SELECT id, target_user_id AS "targetUserId", action, reason, details, created_at AS "createdAt"
       FROM agency_room_moderation_audit
      WHERE agency_id = $1 AND room_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [scope.agency_id, roomId, limit],
  );
}
