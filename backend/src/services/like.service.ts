import { one, query } from '../config/db';
import { redis } from '../config/redis';
import { ApiError } from '../utils/http';
import { MiniUser } from '../utils/serialize';
import { emitToRoom } from './socket.service';

/**
 * Room likes ("tap to cheer"). The interaction is TUILiveKit's, the counting is
 * ours: a client that reports its own total can inflate a room, so only this
 * process decides what a room's like count is.
 *
 * Tap rate is the whole problem — a fast tapper sends ten taps a second, which
 * would be ten broadcasts to everyone in the room. So a tap only bumps an
 * in-memory counter, and each room gets one flush per window. Receivers see a
 * counted batch every LIKE_FLUSH_MS, which is the same trade their client makes
 * with a 6 second send debounce.
 *
 * The buffer lives in this process on purpose: `emitToRoom` only reaches the
 * sockets attached to *this* instance anyway, so a shared buffer would count for
 * a room nobody here can see. Postgres holds the durable total.
 */

const LIKE_FLUSH_MS = 1_000;
/** Long-lived total, so the badge can be broadcast without touching Postgres. */
const totalKey = (roomId: string) => `likes:total:${roomId}`;
/** A closed room's counter is only kept this long; Postgres has it forever. */
const TOTAL_TTL_S = 60 * 60 * 24;

type Batch = { roomId: string; count: number; total: number; user: MiniUser };

const pending = new Map<string, { count: number; user: MiniUser }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** One flush per room at a time, so two windows cannot race the Postgres write. */
const flushing = new Map<string, Promise<void>>();

export const likeFlushIntervalMs = () => LIKE_FLUSH_MS;

export async function registerLike(roomId: string, user: MiniUser, requestedCount: number): Promise<void> {
  const count = Math.trunc(requestedCount);
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    throw ApiError.badRequest('Like count must be between 1 and 100', 'like_count_invalid');
  }

  const entry = pending.get(roomId);
  if (entry) entry.count += count;
  else pending.set(roomId, { count, user });

  if (!timers.has(roomId)) {
    const handle = setTimeout(() => {
      timers.delete(roomId);
      scheduleFlush(roomId);
    }, LIKE_FLUSH_MS);
    // An armed timer must not keep the process alive during shutdown or a test run.
    handle.unref?.();
    timers.set(roomId, handle);
  }
}

function scheduleFlush(roomId: string): void {
  const previous = flushing.get(roomId) ?? Promise.resolve();
  const run = previous
    .then(() => flushRoom(roomId))
    .catch((err) => console.warn('[likes] flush failed', err.message));
  flushing.set(roomId, run);
  run.then(() => {
    if (flushing.get(roomId) === run) flushing.delete(roomId);
  });
}

async function flushRoom(roomId: string): Promise<void> {
  const entry = pending.get(roomId);
  if (!entry) return;
  pending.delete(roomId);
  const { count } = entry;
  if (count <= 0) return;

  // Redis is the fast counter, Postgres the durable one. After a restart (or once
  // the TTL lapses) the key is gone, so re-seed it from the row instead of
  // broadcasting a total that quietly restarted at zero.
  if (!(await redis.exists(totalKey(roomId)))) {
    await redis.set(totalKey(roomId), await roomLikeCount(roomId), 'EX', TOTAL_TTL_S);
  }
  const total = await redis.incrby(totalKey(roomId), count);
  await redis.expire(totalKey(roomId), TOTAL_TTL_S);

  const batch: Batch = { roomId, count, total, user: entry.user };
  emitToRoom(roomId, 'room:liked', batch);

  // The socket is the live path; Postgres only has to survive a restart.
  await query('UPDATE rooms SET like_count = like_count + $2 WHERE id = $1', [roomId, count]).catch((err) =>
    console.warn('[likes] persist failed', err.message),
  );
}

/** Persisted total, for the room detail payload and the ops console. */
export async function roomLikeCount(roomId: string): Promise<number> {
  const row = await one<{ like_count: string | number }>('SELECT like_count FROM rooms WHERE id = $1', [roomId]);
  return Number(row?.like_count ?? 0);
}

/** A closing room stops broadcasting, so drop whatever was buffered. */
export function forgetLikes(roomId: string): void {
  pending.delete(roomId);
  const timer = timers.get(roomId);
  if (timer) clearTimeout(timer);
  timers.delete(roomId);
}
