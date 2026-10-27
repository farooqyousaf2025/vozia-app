// ---------------------------------------------------------------------------
// Ops-console realtime channel. The backend accepts an admin JWT on the same
// Socket.IO server the app uses, but treats it as an eavesdropper: joining a
// room as an operator touches no presence key, adds nobody to the roster and
// cannot post as a member. Everything here is inbound state for one room.
// ---------------------------------------------------------------------------
import { io, type Socket } from 'socket.io-client';
import { getToken, socketBase } from './api';
import type { RoomChatMessage, RoomSeatDetail } from '../types';

export type ConsoleLinkState = 'connecting' | 'live' | 'down';

export interface ConsoleEvents {
  onChat?: (message: RoomChatMessage) => void;
  onSeats?: (seats: RoomSeatDetail[]) => void;
  onListeners?: (count: number) => void;
  /**
   * Gift lines already arrive as `room:chat_message`, so the animated-gift event
   * is deliberately not forwarded here — subscribing to both doubles the feed.
   */
  onHandRaise?: (user: { id: string; username: string }, raised: boolean) => void;
  onTheme?: (theme: string) => void;
  onClosed?: () => void;
  onState?: (state: ConsoleLinkState) => void;
}

/** Connects to one room's channel and returns a teardown. Reconnects on its own. */
export function openRoomConsole(roomId: string, events: ConsoleEvents): () => void {
  const token = getToken();
  if (!token) {
    events.onState?.('down');
    return () => undefined;
  }

  const socket: Socket = io(socketBase(), {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    // The console is expected to sit open for a whole shift; do not give up on it.
    reconnectionAttempts: Infinity,
  });

  // After a reconnect the server has no memory of this socket's room membership.
  socket.on('connected', () => {
    socket.emit('room:join', { roomId });
    events.onState?.('live');
  });
  socket.on('connect', () => events.onState?.('connecting'));
  socket.on('connect_error', () => events.onState?.('down'));

  socket.on('room:chat_message', (payload: RoomChatMessage) => events.onChat?.(payload));
  socket.on('room:seat_update', (payload: { seats?: RoomSeatDetail[] }) => {
    if (Array.isArray(payload?.seats)) events.onSeats?.(payload.seats);
  });
  socket.on('room:listener_count', (payload: { count?: number }) => {
    if (typeof payload?.count === 'number') events.onListeners?.(payload.count);
  });
  socket.on('room:hand_raise', (payload: { user?: { id: string; username: string }; raised?: boolean }) => {
    if (payload?.user) events.onHandRaise?.(payload.user, payload.raised !== false);
  });
  socket.on('room:theme_changed', (payload: { theme?: string }) => {
    if (typeof payload?.theme === 'string') events.onTheme?.(payload.theme);
  });
  socket.on('room:closed', () => events.onClosed?.());

  return () => {
    socket.removeAllListeners();
    socket.disconnect();
  };
}
