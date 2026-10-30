import { Server, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { env } from '../config/env';
import { query } from '../config/db';
import { presenceKeys, rateLimit, redis, touchOnline } from '../config/redis';
import { verifyToken } from './token.service';
import { GiftDto, MiniUser, SeatDto } from '../utils/serialize';
import { appendChat, appendSystemChat, fetchMiniUser, recomputeListenerCount, seatSnapshot, setHandRaised } from './room.service';
import { forgetLikes, registerLike } from './like.service';
import { recordQuestProgressOutside } from './quest.service';
import { markDisconnected, submitAction } from './game.service';
import { battleForRoom } from './pk.service';

/**
 * Realtime transport for in-room events. Postgres stays authoritative for seats,
 * wallets and history; Socket.IO only fans out the deltas clients render live.
 *
 * Rooms:  room:<uuid>        everyone inside a party room
 *         user:<uuid>        private channel per account (kicks, DMs, bans)
 */

export const chatRoom = (roomId: string) => `room:${roomId}`;
export const userRoom = (userId: string) => `user:${userId}`;

let io: Server | null = null;

export function getIo(): Server | null {
  return io;
}

export function emitToRoom<T>(roomId: string, event: string, payload: T): void {
  io?.to(chatRoom(roomId)).emit(event, payload);
}

export function emitToUser<T>(userId: string, event: string, payload: T): void {
  io?.to(userRoom(userId)).emit(event, payload);
}

export type SeatUpdatePayload = { roomId: string; seats: SeatDto[]; audience: MiniUser[] };
export type GiftAnimatedPayload = {
  roomId: string;
  gift: GiftDto;
  sender: MiniUser;
  receiver: MiniUser;
  /** Seat the receiver is speaking from, so the overlay can burst at that circle. */
  seatIndex: number | null;
  quantity: number;
  animationUrl: string | null;
  totalDiamonds: number;
  totalRCoins: number;
};

export async function broadcastSeatUpdate(roomId: string): Promise<SeatUpdatePayload> {
  const snap = await seatSnapshot(roomId);
  const payload: SeatUpdatePayload = { roomId, seats: snap.seats, audience: snap.audience };
  emitToRoom(roomId, 'room:seat_update', payload);
  emitToRoom(roomId, 'room:listener_count', { roomId, count: snap.present });
  await query('UPDATE rooms SET listener_count = $2 WHERE id = $1', [roomId, snap.present]).catch(() => undefined);
  return payload;
}

export function broadcastGiftAnimated(payload: GiftAnimatedPayload): void {
  emitToRoom(payload.roomId, 'room:gift_animated', payload);
}

export function broadcastMicToggle(roomId: string, seatIndex: number, muted: boolean, userId: string | null): void {
  emitToRoom(roomId, 'room:mic_toggle', { roomId, seatIndex, muted, userId });
}

export function broadcastRoomClosed(roomId: string): void {
  // The room is gone, so a buffered like batch has no audience left. Dropping it
  // here is what keeps a close from broadcasting `room:liked` into a dead room.
  forgetLikes(roomId);
  emitToRoom(roomId, 'room:closed', { roomId });
}

const CHAT_MAX_LENGTH = 300;

/**
 * The entry notice. TUILiveKit writes a bare "{name} Entered room" chat row per
 * join; here the row is what a room looks like after you reconnect, so the socket
 * banner (room:user_joined, sized by VIP level on the client) carries the repeat
 * and this line is deduped to one per minute. A guest who drops and returns in ten
 * seconds should not push the conversation off the screen.
 */
async function announceEntry(roomId: string, user: MiniUser): Promise<void> {
  const announced = await redis.set(`entry:${roomId}:${user.id}`, '1', 'EX', 60, 'NX').catch(() => null);
  if (!announced) return;
  const message = await appendSystemChat(roomId, `${user.username} entered the room`);
  emitToRoom(roomId, 'room:chat_message', message);
}

/**
 * `scope` decides what the socket may do: a user socket is a room member (it is
 * counted in presence and appears in the roster), an admin socket is an invisible
 * eavesdropper used by the ops console. Admins never touch presence, seats or the
 * participant list, and cannot speak as a member — moderator messages go through
 * the REST endpoint so they are attributed and audited.
 */
type SocketData = {
  userId: string;
  username: string;
  roomId: string | null;
  scope: 'user' | 'admin';
};

/** The wire shape of a move: an action name plus its arguments, nothing else. */
type GameActionWire = { type?: string; payload?: Record<string, unknown> };

function data(socket: Socket): SocketData {
  return socket.data as SocketData;
}

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(',').map((s) => s.trim()),
      credentials: true,
    },
    pingInterval: 10_000,
    pingTimeout: 20_000,
    // mobile clients on flaky 4G: let the server hold the session a bit longer
    connectionStateRecovery: { maxDisconnectionDuration: 30_000 },
  });

  io.use((socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      (typeof socket.handshake.query.token === 'string' ? socket.handshake.query.token : undefined);
    if (!token) return next(new Error('unauthorized'));
    try {
      const payload = verifyToken(token);
      // Real-time chat runs as a player. An operator or BD/seller token has a subject from a
      // different table, so letting it bind a socket would join rooms as a phantom user.
      if (payload.scope !== 'user') throw new Error('unauthorized');
      socket.data.userId = payload.sub;
      socket.data.username = payload.username;
      socket.data.roomId = null;
      socket.data.scope = payload.scope;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const me = data(socket);
    const admin = me.scope === 'admin';
    // Operator logins are not app users: no presence key and no personal channel,
    // because the console must not show up in any roster or online count.
    if (!admin) {
      socket.join(userRoom(me.userId));
      await touchOnline(me.userId, 1, null).catch(() => undefined);
    }
    await socket.emit('connected', { userId: me.userId, username: me.username, scope: me.scope });

    socket.on('room:join', async (payload: { roomId?: string }, ack?: (r: unknown) => void) => {
      try {
        if (!payload?.roomId) throw new Error('roomId required');
        if (admin) {
          // Subscribe to the room's event channel and nothing else: no presence
          // touch, no `room:user_joined`, no seat re-broadcast.
          if (me.roomId && me.roomId !== payload.roomId) socket.leave(chatRoom(me.roomId));
          socket.join(chatRoom(payload.roomId));
          me.roomId = payload.roomId;
          ack?.({ ok: true, scope: 'admin' });
          return;
        }
        // A socket may hop rooms: drop the previous membership first.
        if (me.roomId && me.roomId !== payload.roomId) {
          const previous = me.roomId;
          socket.leave(chatRoom(previous));
          emitToRoom(previous, 'room:user_left', { roomId: previous, userId: me.userId });
          await recomputeListenerCount(previous).catch(() => undefined);
          broadcastSeatUpdate(previous).catch(() => undefined);
        }
        socket.join(chatRoom(payload.roomId));
        me.roomId = payload.roomId;
        await touchOnline(me.userId, 0, payload.roomId).catch(() => undefined);
        const user = await fetchMiniUser(me.userId);
        if (user) {
          emitToRoom(payload.roomId, 'room:user_joined', { roomId: payload.roomId, user });
          await announceEntry(payload.roomId, user);
        }
        broadcastSeatUpdate(payload.roomId).catch((err) => console.warn('[socket] seat snapshot', err.message));
        // A battle may already be running (or pending) when somebody walks in or reconnects. The
        // room's live scores come back on this socket instead of waiting for the next gift.
        battleForRoom(payload.roomId)
          .then((battle) => { if (battle) socket.emit('pk:state', battle); })
          .catch(() => undefined);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on('room:leave', async (payload: { roomId?: string }) => {
      const roomId = payload?.roomId ?? me.roomId;
      if (!roomId) return;
      socket.leave(chatRoom(roomId));
      me.roomId = null;
      if (admin) return;
      emitToRoom(roomId, 'room:user_left', { roomId, userId: me.userId });
      await recomputeListenerCount(roomId).catch(() => undefined);
      broadcastSeatUpdate(roomId).catch(() => undefined);
    });

    socket.on('room:chat', async (payload: { roomId?: string; message?: string }, ack?: (r: unknown) => void) => {
      // A moderator line has to be attributed to the admin account and audited, so
      // it goes through POST /api/admin/rooms/:id/chat instead of this member path.
      if (admin) {
        ack?.({ ok: false, error: 'Admins send messages through the ops console' });
        return;
      }
      const roomId = payload?.roomId ?? me.roomId;
      const content = (payload?.message ?? '').trim();
      try {
        if (!roomId) throw new Error('Join a room first');
        if (!content) throw new Error('Empty message');
        if (content.length > CHAT_MAX_LENGTH) throw new Error(`Chat is capped at ${CHAT_MAX_LENGTH} characters`);

        const allowed = await rateLimit(`chat:${me.userId}`, 15, 10);
        if (allowed === -1) throw new Error('You are typing too fast; take a breath');

        const message = await appendChat(roomId, me.userId, content);
        emitToRoom(roomId, 'room:chat_message', message);
        // A stored message is the qualifying event for the "join the party" quest. Best effort and
        // after the ack: unlike a gift, a failed quest counter must not cost a member their chat
        // line, and the counter is only worth anything if the message itself exists.
        recordQuestProgressOutside(me.userId, [{ metric: 'CHAT_MESSAGE', amount: 1 }]).catch((err) =>
          console.warn('[socket] quest progress', err.message),
        );
        ack?.({ ok: true, message });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on('room:like', async (payload: { roomId?: string; count?: number }) => {
      if (admin) return;
      const roomId = payload?.roomId ?? me.roomId;
      if (!roomId) return;
      try {
        // Tap-spam guard. like.service turns whatever survives this into one
        // counted batch per second for the whole room.
        const allowed = await rateLimit(`like:${me.userId}`, 40, 10);
        if (allowed === -1) return;
        const user = await fetchMiniUser(me.userId);
        if (!user) return;
        await registerLike(roomId, user, Number(payload?.count ?? 1));
      } catch (err) {
        socket.emit('room:error', { roomId, error: (err as Error).message });
      }
    });

    socket.on('room:raise_hand', async (payload: { roomId?: string; raise?: boolean }) => {
      if (admin) return;
      const roomId = payload?.roomId ?? me.roomId;
      const raise = Boolean(payload?.raise);
      if (!roomId) return;
      try {
        await setHandRaised(me.userId, roomId, raise);
        const user = await fetchMiniUser(me.userId);
        // Hosts get a private ping so the queue badge lights up even if the host
        // is browsing the room list rather than sitting inside it.
        emitToRoom(roomId, 'room:hand_raise', { roomId, raised: raise, user });
      } catch (err) {
        socket.emit('room:error', { roomId, error: (err as Error).message });
      }
    });

    socket.on('game:action', async (payload: { sessionId?: string; action?: GameActionWire }, ack?: (r: unknown) => void) => {
      // Operators watch games; playing one from the console would put an admin account in
      // the seat list and make the audit trail ambiguous about who moved.
      if (admin) {
        ack?.({ ok: false, error: 'Admins cannot play games' });
        return;
      }
      try {
        const sessionId = payload?.sessionId;
        const type = (payload?.action?.type ?? '').trim().toUpperCase();
        if (!sessionId) throw new Error('sessionId required');
        if (!type) throw new Error('Action type required');
        // Nothing on this payload is trusted as a result: it names an action and its
        // arguments, and the game's own validator decides whether the move is legal.
        const session = await submitAction(me.userId, sessionId, { type, payload: payload?.action?.payload ?? {} });
        ack?.({ ok: true, session });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on('disconnect', async () => {
      if (admin) return;
      const remaining = await touchOnline(me.userId, -1).catch(() => 1);
      if (remaining === 0) {
        await redis.srem(presenceKeys.online, me.userId).catch(() => undefined);
        // Only when the account has no socket left, so a second phone in the same match
        // does not make the first one look like it walked out.
        await markDisconnected(me.userId).catch(() => undefined);
      }
      if (!me.roomId) return;
      emitToRoom(me.roomId, 'room:user_left', { roomId: me.roomId, userId: me.userId });
      await recomputeListenerCount(me.roomId).catch(() => undefined);
      broadcastSeatUpdate(me.roomId).catch(() => undefined);
    });
  });

  return io;
}
