import http from 'http';
import { createApp } from './app';
import { closePool, ping } from './config/db';
import { closeRedis } from './config/redis';
import { env, assertSecretsAreSafe } from './config/env';
import { bootstrapAdmin } from './controllers/auth.controller';
import { setGameBroadcaster, sweepExpiredSessions } from './services/game.service';
import { expireStaleOrders } from './services/seller-recharge.service';
import { expireInvites, settleDueBattles, setPkBroadcaster } from './services/pk.service';
import { emitToRoom, emitToUser, initSocket } from './services/socket.service';
import { loadRankRegistry } from './services/rank.service';
import { loadThemeRegistry } from './services/theme.service';

async function waitForDatabase(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Postgres in compose can be healthy a beat after the container starts.
  while (Date.now() < deadline) {
    if (await ping()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('PostgreSQL was not reachable in time');
}

async function main(): Promise<void> {
  assertSecretsAreSafe();
  await waitForDatabase();
  // The theme/effect snapshot is read once here because every room DTO is built synchronously
  // from it. Failing to load is fatal on purpose: a half-populated decoration catalogue would
  // silently render the wrong art on every device.
  await loadThemeRegistry();
  // Same reason for the level ladder: every user DTO resolves a rung synchronously, and half a
  // ladder would put the wrong badge on every account.
  await loadRankRegistry();
  await bootstrapAdmin();

  const app = createApp();
  const server = http.createServer(app);
  const io = initSocket(server);

  // The engine deliberately does not import the socket layer — that would be a circle,
  // because socket handlers call back into the engine — so the emitter is handed over here.
  setGameBroadcaster((roomId, event, payload) => emitToRoom(roomId, event, payload));

  // PK battles announce through the same seam for the same reason. A battle reaches two rooms and,
  // for an invitation, one host's private channel, so the target is part of the payload here.
  setPkBroadcaster((target, event, payload) => {
    if (target.roomId) emitToRoom(target.roomId, event, payload);
    if (target.userId) emitToUser(target.userId, event, payload);
  });

  // Expired turns are swept by the clock instead of by a per-session timer, so a backend
  // restart cannot strand a match whose timer died with the old process.
  const sweeper = setInterval(() => {
    sweepExpiredSessions().catch((err) => console.warn('[voiza] game sweep failed:', err.message));
  }, 5_000);
  sweeper.unref();

  // A recharge claim that was never verified is worth nothing, but it is worth closing: an
  // open order looks like pending money to every report until it expires. One UPDATE per minute,
  // and a manual route exists for the same call so finance is never waiting on the clock.
  const rechargeSweeper = setInterval(() => {
    expireStaleOrders()
      .then((result) => {
        if (result.expired) console.info(`[voiza] expired ${result.expired} stale recharge order(s)`);
      })
      .catch((err) => console.warn('[voiza] recharge sweep failed:', err.message));
  }, 60_000);
  rechargeSweeper.unref();

  // PK battles end on the clock, not on a request from the room that lost. Two seconds is short
  // enough that a supporter watching the countdown hits the buzzer at roughly the same moment the
  // score freezes; `settleBattle` takes the row lock, so the sweep racing a reader is harmless.
  const pkSweeper = setInterval(() => {
    settleDueBattles()
      .then((settled) => {
        if (settled) console.info(`[voiza] settled ${settled} PK battle(s)`);
      })
      .catch((err) => console.warn('[voiza] PK sweep failed:', err.message));
    expireInvites().catch((err) => console.warn('[voiza] PK invite sweep failed:', err.message));
  }, 2_000);
  pkSweeper.unref();

  server.listen(env.port, () => {
    console.info(`[voiza] API + Socket.IO listening on :${env.port} (${env.nodeEnv})`);
    console.info(`[voiza] LiveKit client URL: ${env.livekit.publicUrl}`);
  });

  const shutdown = async (signal: string) => {
    console.info(`[voiza] ${signal} received, closing connections`);
    const timer = setTimeout(() => process.exit(1), 8000);
    clearInterval(sweeper);
    clearInterval(rechargeSweeper);
    clearInterval(pkSweeper);
    io.close();
    server.close();
    await Promise.allSettled([closePool(), closeRedis()]);
    clearTimeout(timer);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => console.error('[voiza] unhandled rejection', reason));
}

main().catch((err) => {
  console.error('[voiza] failed to start', err);
  process.exit(1);
});
