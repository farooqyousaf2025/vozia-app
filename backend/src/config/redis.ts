import Redis from 'ioredis';
import { env } from './env';

/**
 * Command client: plain reads/writes (presence, counters, rate limits, caches).
 */
export const redis = new Redis(env.redisUrl, {
  keyPrefix: 'voiza:',
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});

redis.on('error', (err) => console.error('[redis] error', err.message));
redis.on('connect', () => console.info('[redis] connected'));

/**
 * Presence and room state live in Redis, not Postgres: they change on every
 * socket connect/disconnect and would otherwise thrash the primary table.
 *
 * Keys
 *   presence:online            SET of user ids with a live socket
 *   presence:user:<id>         HASH { roomId, seatIndex, since }
 *   room:<id>:listeners        HyperLogLog of distinct listeners ever seen (analytics)
 *   rl:otp:<phone>             rate-limit counter
 *   rl:gift:<userId>           sliding spend accumulator
 */
export const presenceKeys = {
  online: 'presence:online',
  user: (userId: string) => `presence:user:${userId}`,
  roomListeners: (roomId: string) => `room:${roomId}:listeners`,
} as const;

/**
 * Track one socket per (user, connection). A user with several devices stays
 * online until their last socket goes away.
 */
export async function touchOnline(
  userId: string,
  delta: number,
  roomId?: string | null,
): Promise<number> {
  const key = presenceKeys.user(userId);
  const sockets = await redis.hincrby(key, 'sockets', delta);
  if (roomId !== undefined) await redis.hset(key, 'roomId', roomId ?? '');
  await redis.expire(key, 86_400);
  if (sockets > 0) await redis.sadd(presenceKeys.online, userId);
  else await redis.srem(presenceKeys.online, userId);
  return Math.max(0, sockets);
}

export async function onlineUserCount(): Promise<number> {
  return redis.scard(presenceKeys.online);
}

/** Fixed-window rate limiter; returns the remaining budget or -1 when blocked. */
export async function rateLimit(bucket: string, limit: number, windowSeconds: number): Promise<number> {
  const key = `rl:${bucket}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count > limit ? -1 : limit - count;
}

export async function closeRedis(): Promise<void> {
  redis.disconnect();
}
