import { randomUUID } from 'crypto';

/**
 * The socket layer hands this service an emitter at boot. Keeping it as a callback (rather than
 * importing `getIo`) is what stops `socket.service -> game.service -> ledger.service -> here`
 * from becoming a load-time cycle.
 */
let emitToAll: ((event: string, payload: unknown) => void) | null = null;

export function setTickerBroadcaster(fn: (event: string, payload: unknown) => void): void {
  emitToAll = fn;
}

/**
 * Platform-wide announcement ticker.
 *
 * The room notice (`room:announcement`) is a pinned line inside one room. This is the other
 * surface: a short, app-wide line that every connected account sees — a top-up, a recharge, a
 * top ranker, a game starting or a game winner. It is deliberately fire-and-forget: a ticker
 * that fails must never fail the money or game action that caused it.
 */
export type TickerKind =
  | 'TOPUP'
  | 'RECHARGE'
  | 'TOP_RANKER'
  | 'GAME_PLAYER'
  | 'GAME_WINNER';

export type TickerPayload = {
  id: string;
  kind: TickerKind;
  text: string;
  username: string | null;
  userId: string | null;
  amount: number | null;
  roomId: string | null;
  /** ISO-3166-1 alpha-2 when the event belongs to a room with a region. */
  region: string | null;
  createdAt: string;
};

export function broadcastTicker(
  input: Omit<TickerPayload, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
): void {
  if (!emitToAll) return;
  const payload: TickerPayload = {
    id: input.id ?? randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...input,
  };
  emitToAll('announcement:ticker', payload);
}

export function topUpTicker(username: string, userId: string, diamonds: number, kind: 'TOPUP' | 'RECHARGE'): void {
  broadcastTicker({
    kind,
    text: `${username} topped up ${diamonds.toLocaleString()} diamonds`,
    username,
    userId,
    amount: diamonds,
    roomId: null,
    region: null,
  });
}

export function topRankerTicker(username: string, userId: string, diamonds: number): void {
  broadcastTicker({
    kind: 'TOP_RANKER',
    text: `${username} is today's top ranker with ${diamonds.toLocaleString()} diamonds`,
    username,
    userId,
    amount: diamonds,
    roomId: null,
    region: null,
  });
}

export function gamePlayerTicker(
  username: string,
  userId: string,
  gameTitle: string,
  roomId: string | null,
  region: string | null,
): void {
  broadcastTicker({
    kind: 'GAME_PLAYER',
    text: `${username} joined ${gameTitle}`,
    username,
    userId,
    amount: null,
    roomId,
    region,
  });
}

export function gameWinnerTicker(
  username: string,
  userId: string,
  gameTitle: string,
  roomId: string | null,
  region: string | null,
  prizeDiamonds: number,
): void {
  broadcastTicker({
    kind: 'GAME_WINNER',
    text:
      prizeDiamonds > 0
        ? `${username} won ${gameTitle} and ${prizeDiamonds.toLocaleString()} diamonds`
        : `${username} won ${gameTitle}`,
    username,
    userId,
    amount: prizeDiamonds,
    roomId,
    region,
  });
}
