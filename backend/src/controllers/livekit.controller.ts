import { Request, Response } from 'express';
import { one, query } from '../config/db';
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
  const room = await one<RoomRow>('SELECT * FROM rooms WHERE livekit_room_name = $1', [roomName]);
  if (!room) return;

  switch (event.event) {
    case 'room_finished': {
      // LiveKit ending an empty media session is not the owner closing the persistent Vozia room.
      // Reconcile transient presence only; keep the PostgreSQL room ACTIVE and discoverable.
      await query('UPDATE room_participants SET left_at = now() WHERE room_id = $1 AND left_at IS NULL', [room.id]);
      await query(
        `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
          WHERE room_id = $1`,
        [room.id],
      );
      await query('UPDATE rooms SET listener_count = 0 WHERE id = $1', [room.id]);
      emitToRoom(room.id, 'room:session_ended', { roomId: room.id });
      break;
    }

    case 'participant_left': {
      const identity = event.participant?.identity;
      if (!identity) break;
      await query(
        `UPDATE room_seats SET user_id = NULL, status = 'EMPTY', is_speaker = FALSE, is_muted = FALSE
          WHERE room_id = $1 AND user_id = $2`,
        [room.id, identity],
      );
      await query(
        'UPDATE room_participants SET left_at = now() WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL',
        [room.id, identity],
      );
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
