import { Request, Response } from 'express';
import { one, query, withTransaction } from '../config/db';
import { presenceKeys, redis, refreshRoomLivePresence } from '../config/redis';
import { RoomRow } from '../types/db';
import { asyncHandler } from '../utils/http';
import { LivekitWebhookEvent, verifyWebhook } from '../services/livekit.service';
import { emitToRoom } from '../services/socket.service';
import { recomputeListenerCount } from '../services/room.service';

/**
 * LiveKit webhooks are the reconciliation path: they tell us what happened when
 * a phone died mid-party and no leave call ever reached the API.
 */
export const webhook = asyncHandler(async (req: Request, res: Response) => {
  const event = await verifyWebhook(req.rawBody ?? (req.body as Buffer), req.headers.authorization);

  // Acknowledge first: LiveKit retries and eventually disables a slow webhook.
  res.sendStatus(200);
  reconcile(event).catch((err) => console.error('[livekit:webhook] reconcile failed', (err as Error).message));
});

async function reconcile(event: LivekitWebhookEvent): Promise<void> {
  const roomName = event.room?.name;
  if (!roomName) return;
  const room = await one<RoomRow & { livekit_session_sid: string | null }>(
    'SELECT * FROM rooms WHERE livekit_room_name = $1',
    [roomName],
  );
  if (!room) return;

  switch (event.event) {
    case 'room_finished': {
      // The room's media session is disposable; the PostgreSQL room remains ACTIVE.
      // A delayed finish event from an older SID must not clear presence in a replacement session.
      const finishedSid = event.room?.sid;
      if (!finishedSid || (room.livekit_session_sid && finishedSid !== room.livekit_session_sid)) {
        console.info('[livekit:webhook] ignored stale/unidentified room_finished', room.id, finishedSid ?? 'no-sid');
        break;
      }
      const reconciled = await withTransaction(async (client) => {
        const current = await client.query<{ livekit_session_sid: string | null }>(
          'SELECT livekit_session_sid FROM rooms WHERE id = $1 FOR UPDATE',
          [room.id],
        );
        if (current.rows[0]?.livekit_session_sid && current.rows[0].livekit_session_sid !== finishedSid) return false;
        await client.query(
          'UPDATE room_participants SET left_at = now() WHERE room_id = $1 AND left_at IS NULL',
          [room.id],
        );
        await client.query(
          'UPDATE room_host_checkins SET checked_out_at = now() WHERE room_id = $1 AND checked_out_at IS NULL',
          [room.id],
        );
        await client.query(
          `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
            WHERE room_id = $1`,
          [room.id],
        );
        await client.query(
          'UPDATE rooms SET listener_count = 0, livekit_session_sid = NULL WHERE id = $1 AND (livekit_session_sid = $2 OR livekit_session_sid IS NULL)',
          [room.id, finishedSid],
        );
        return true;
      });
      if (reconciled) {
        await redis.del(presenceKeys.roomLivekitUsers(room.id));
        await redis.zrem(presenceKeys.activeRooms, room.id);
        emitToRoom(room.id, 'room:session_ended', { roomId: room.id });
      }
      break;
    }

    case 'participant_joined': {
      const identity = event.participant?.identity;
      const eventSid = event.room?.sid;
      if (!identity || (eventSid && room.livekit_session_sid && eventSid !== room.livekit_session_sid)) break;
      // A media participant is eligible only if the API has an active, non-test room membership.
      const member = await one<{ user_id: string }>(
        `SELECT rp.user_id
           FROM room_participants rp
           JOIN users u ON u.id = rp.user_id
          WHERE rp.room_id = $1 AND rp.user_id = $2 AND rp.left_at IS NULL
            AND u.status = 'ACTIVE' AND NOT u.is_test`,
        [room.id, identity],
      );
      if (!member) break;
      await redis.sadd(presenceKeys.roomLivekitUsers(room.id), identity);
      await refreshRoomLivePresence(room.id);

      if (!room.host_id || room.owner_type === 'SYSTEM' || identity !== room.host_id) break;
      const host = await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [identity]);
      if (!host) break;
      await query(
        `INSERT INTO room_host_checkins (room_id, room_number, room_title, host_user_id, host_username)
         SELECT id, room_number, title, host_id, $2 FROM rooms
         WHERE id = $1 AND host_id = $3 AND owner_type <> 'SYSTEM' AND status = 'ACTIVE'
           AND (livekit_session_sid IS NULL OR livekit_session_sid = $4)
         ON CONFLICT (room_id, host_user_id)
         WHERE room_id IS NOT NULL AND host_user_id IS NOT NULL AND checked_out_at IS NULL DO NOTHING`,
        [room.id, host.username, identity, eventSid ?? room.livekit_session_sid],
      );
      break;
    }

    case 'participant_left': {
      const identity = event.participant?.identity;
      const eventSid = event.room?.sid;
      if (!identity || (eventSid && room.livekit_session_sid && eventSid !== room.livekit_session_sid)) break;
      await redis.srem(presenceKeys.roomLivekitUsers(room.id), identity);
      await refreshRoomLivePresence(room.id);
      await query(
        `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
          WHERE room_id = $1 AND user_id = $2`,
        [room.id, identity],
      );
      await query(
        'UPDATE room_participants SET left_at = now() WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL',
        [room.id, identity],
      );
      const eventSid = event.room?.sid;
      if (identity === room.host_id && room.owner_type !== 'SYSTEM'
          && (!eventSid || !room.livekit_session_sid || eventSid === room.livekit_session_sid)) {
        await query(
          'UPDATE room_host_checkins SET checked_out_at = now() WHERE room_id = $1 AND host_user_id = $2 AND checked_out_at IS NULL',
          [room.id, identity],
        );
      }
      await recomputeListenerCount(room.id);
      emitToRoom(room.id, 'room:user_left', { roomId: room.id, userId: identity });
      break;
    }

    case 'active_speaker_changed': {
      emitToRoom(room.id, 'room:active_speaker', {
        roomId: room.id,
        speakerId: event.participant?.identity ?? null,
      });
      break;
    }

    default:
      break;
  }
}
