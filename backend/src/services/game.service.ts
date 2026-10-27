import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { many, one, query, withTransaction } from '../config/db';
import { rateLimit } from '../config/redis';
import { GameDefinitionRow, GameDisputeRow, GameParticipantRow, GameSessionRow, PinnedGameRules, RoomRow } from '../types/db';
import { ApiError, requireString } from '../utils/http';
import {
  GameDefinitionDto,
  GameDisputeDto,
  GameSessionDto,
  toGameDefinition,
  toGameDispute,
  toGameSession,
} from '../utils/serialize';
import { driverFor } from '../games/registry';
import { DriverContext, GameAction, GamePlayer } from '../games/types';
import { pinRules, refundFees, settleSession } from './game-settlement.service';
import { postGameMoves } from './ledger.service';
import { loadRoom } from './room.service';
import { recordAudit } from './audit.service';

/**
 * The game engine: lifecycle, seats, fees, clocks and the settlement call.
 *
 * Every rule the brief asks the server to hold is held here or in the schema:
 *  - session ids, seats, dice, timers, scores and winners are made by the server;
 *  - one SQL transaction per mutation, with the session row locked, so two clients
 *    cannot both take the last seat or both spend the same dice;
 *  - money moves only through `postGameMoves`, the ledger's game path;
 *  - `settleSession` is the only writer of payouts, and its primary key means a second
 *    finish for the same match pays nothing.
 *
 * A session is created inside an audio room and never tears one down: the engine touches
 * `rooms` for permission checks and nothing else, so a game overlay is a pane on top of a
 * live LiveKit call rather than a way to leave it.
 */

const SESSION_SELECT = `
  SELECT s.*, u.username AS creator_username
    FROM game_sessions s
    JOIN users u ON u.id = s.created_by`;

const PARTICIPANTS_SELECT = `
  SELECT p.*, u.username, u.avatar_url
    FROM game_participants p
    JOIN users u ON u.id = p.user_id
   WHERE p.session_id = $1
   ORDER BY p.position`;

/**
 * Seats still worth counting as players.
 *
 * `DISCONNECTED` is in here on purpose: a phone that dropped the socket is still seated at
 * the table, its tokens are still on the board, and dropping it from the player list would
 * change whose turn it is. It stops the game by running out of clock, not by going quiet.
 */
const LIVE_STATUSES = ['JOINED', 'READY', 'PLAYING', 'COMPLETED', 'DISCONNECTED'];

/**
 * The realtime seam.
 *
 * Every state change has to reach the room, but importing `socket.service` here would
 * close a circle, because the socket layer routes `game:*` events back into this service.
 * `index.ts` installs the emitter at boot instead, so neither module needs the other at
 * import time — and a test can watch broadcasts without running a socket server.
 */
type GameEmitter = (roomId: string, event: string, payload: unknown) => void;
let emit: GameEmitter = () => undefined;

export function setGameBroadcaster(emitter: GameEmitter): void {
  emit = emitter;
}

function asJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

async function loadDefinition(client: PoolClient | undefined, key: string): Promise<GameDefinitionRow> {
  const sql = 'SELECT * FROM game_definitions WHERE key = $1';
  const row = client
    ? (await client.query<GameDefinitionRow>(sql, [key])).rows[0]
    : await one<GameDefinitionRow>(sql, [key]);
  if (!row) throw ApiError.notFound(`No game called ${key}`, 'game_not_found');
  return row;
}

async function readSession(client: PoolClient, sessionId: string, lock: boolean): Promise<GameSessionRow> {
  const suffix = lock ? ' FOR UPDATE' : '';
  const res = await client.query<GameSessionRow & { creator_username: string }>(`${SESSION_SELECT} WHERE s.id = $1${suffix}`, [
    sessionId,
  ]);
  const row = res.rows[0];
  if (!row) throw ApiError.notFound('Game not found', 'game_not_found');
  return row;
}

async function readParticipants(client: PoolClient, sessionId: string): Promise<GameParticipantRow[]> {
  const res = await client.query<GameParticipantRow & { username: string; avatar_url: string | null }>(
    PARTICIPANTS_SELECT,
    [sessionId],
  );
  return res.rows;
}

/**
 * The per-game entry ceiling, measured over the last 24 hours.
 *
 * Both doors check it — opening a match and joining one — because the host pays the same fee
 * either way, and a limit that only guards the second door is a limit the host can walk past.
 */
async function assertDailyEntryLimit(client: PoolClient, userId: string, limit: number): Promise<void> {
  if (limit <= 0) return;
  const today = await client.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM game_participants
      WHERE user_id = $1 AND joined_at > now() - INTERVAL '24 hours'`,
    [userId],
  );
  if (Number(today.rows[0].n) >= limit) {
    throw ApiError.tooManyRequests(`Daily limit of ${limit} entries reached`, 'daily_entry_limit');
  }
}

/**
 * Allocate the next event number. Called only while the session row is locked, which is
 * what makes `UNIQUE (session_id, seq)` a tamper check rather than a source of errors: a
 * gap or a repeat in the log means somebody wrote outside the engine.
 */
async function appendEvent(
  client: PoolClient,
  sessionId: string,
  type: string,
  actorId: string | null,
  payload: Record<string, unknown> = {},
): Promise<number> {
  const current = await client.query<{ next: number }>(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM game_events WHERE session_id = $1',
    [sessionId],
  );
  const seq = Number(current.rows[0].next);
  await client.query(
    'INSERT INTO game_events (session_id, seq, type, actor_id, payload) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [sessionId, seq, type, actorId, asJson(payload)],
  );
  return seq;
}

function playersOf(participants: GameParticipantRow[]): GamePlayer[] {
  return participants
    .filter((p) => LIVE_STATUSES.includes(p.status))
    .map((p) => ({ userId: p.user_id, position: p.position }));
}

function contextFor(session: GameSessionRow, players: GamePlayer[], roomId: string | null): DriverContext {
  return { sessionId: session.id, roomId, rules: session.rules, players, nowMs: Date.now() };
}

/**
 * What a client is allowed to see of the board.
 *
 * Quiz Battle keeps the correct index for every question in its state, so the raw state
 * would hand any viewer the answer sheet. Stripping it here — the one place a session
 * leaves the service — means a leak needs a new code path, not a forgotten call site.
 */
export function publicState(gameKey: string, state: unknown): unknown {
  if (gameKey !== 'QUIZ_BATTLE' || !state || typeof state !== 'object') return state;
  const raw = state as { questions?: unknown[] };
  if (!Array.isArray(raw.questions)) return state;
  return {
    ...(state as Record<string, unknown>),
    questions: raw.questions.map((q) => {
      const { answerIndex: _answerIndex, ...rest } = (q ?? {}) as Record<string, unknown>;
      return rest;
    }),
  };
}

async function broadcast(session: GameSessionRow, participants: GameParticipantRow[], extra: Record<string, unknown> = {}): Promise<void> {
  if (!session.room_id) return;
  const dto = toGameSession(session, participants, publicState(session.game_key, session.state));
  emit(session.room_id, 'game:update', { ...dto, ...extra });
  if (session.status === 'COMPLETED' || session.status === 'CANCELLED') emit(session.room_id, 'game:ended', { sessionId: session.id });
}

/** Host-only gate: the room's owner, or an operator acting through the back office. */
async function assertMatchManager(session: GameSessionRow, actorId: string, asAdmin: boolean): Promise<void> {
  if (asAdmin || session.created_by === actorId) return;
  if (!session.room_id) throw ApiError.forbidden('Only the host who opened this game can do that', 'not_match_host');
  const room = await one<{ host_id: string }>('SELECT host_id FROM rooms WHERE id = $1', [session.room_id]);
  if (room?.host_id !== actorId) throw ApiError.forbidden('Only the host or a moderator can do that', 'not_match_host');
}

async function assertRoomAccess(room: RoomRow, userId: string): Promise<void> {
  if (room.status !== 'ACTIVE') throw ApiError.conflict('This room is closed', 'room_closed');
  const banned = await one<{ user_id: string }>(
    `SELECT user_id FROM room_bans WHERE room_id = $1 AND user_id = $2
       AND (expires_at IS NULL OR expires_at > now())`,
    [room.id, userId],
  );
  if (banned) throw ApiError.forbidden('A moderator removed you from this room', 'room_banned');
}

/**
 * The price this session charges, decided once at creation and pinned to its row.
 * A promotional window waives the fee for sessions opened inside it; the waiver is
 * recorded on the session, so a later promo edit cannot retroactively refund or re-charge.
 */
function feeFor(rules: PinnedGameRules): number {
  if (!rules.entryFeeEnabled || rules.entryFeeDiamonds <= 0) return 0;
  return rules.entryFeeDiamonds;
}

export async function listDefinitions(opts: { activeOnly: boolean }): Promise<GameDefinitionDto[]> {
  const rows = await many<GameDefinitionRow>(
    `SELECT * FROM game_definitions ${opts.activeOnly ? 'WHERE is_active' : ''} ORDER BY key`,
  );
  return rows.map(toGameDefinition);
}

/**
 * Open a match. The creator is seated at position 0 and pays the same entry fee as
 * everyone else, so "host starts a game" cannot become a way to play for free.
 */
export async function createSession(
  userId: string,
  input: { gameKey: string; roomId: string },
): Promise<GameSessionDto> {
  const definition = await loadDefinition(undefined, input.gameKey);
  if (!definition.is_active) throw ApiError.forbidden(`${definition.name} is not open right now`, 'game_disabled');
  const rules = pinRules(definition);
  const driver = driverFor(definition.key);
  const room = await loadRoom(input.roomId);
  await assertRoomAccess(room, userId);
  if (room.host_id !== userId) throw ApiError.forbidden('Only the room host can open a game', 'not_room_host');

  const fee = feeFor(rules);
  const sessionId = randomUUID();

  const result = await withTransaction(async (client) => {
    // Pin the rule version into history as well as into the session, so the numbers a
    // finished match paid out can be reproduced years later even if the definition row is
    // edited a hundred times.
    await client.query(
      `INSERT INTO game_rule_snapshots (game_key, rules_version, rules)
       VALUES ($1,$2,$3::jsonb) ON CONFLICT (game_key, rules_version) DO NOTHING`,
      [definition.key, definition.rules_version, asJson(rules)],
    );

    await client.query(
      `INSERT INTO game_sessions (id, game_key, definition_id, room_id, created_by, status, rules_version, rules,
                                 entry_fee_diamonds, max_players, state)
       VALUES ($1,$2,$3,$4,$5,'WAITING',$6,$7::jsonb,$8,$9,'{}'::jsonb)`,
      [
        sessionId,
        definition.key,
        definition.id,
        room.id,
        userId,
        definition.rules_version,
        asJson(rules),
        fee,
        Math.min(rules.maxPlayers, definition.max_players),
      ],
    );

    // Locks the row just created, so a second join cannot be interleaved inside this same
    // transaction while the creator's seat and fee are still being written.
    await readSession(client, sessionId, true);
    await assertDailyEntryLimit(client, userId, rules.dailyEntryLimit);
    const moves = fee > 0 ? await postGameMoves(client, [{ type: 'GAME_ENTRY', userId, diamonds: fee, sessionId, roomId: room.id, note: `${definition.name} entry` }]) : [];
    await client.query(
      `INSERT INTO game_participants (session_id, user_id, position, status, entry_fee_diamonds, fee_transaction_id, ready_at)
       VALUES ($1,$2,0,'READY',$3,$4,now())`,
      [sessionId, userId, fee, moves[0]?.transactionId ?? null],
    );
    await appendEvent(client, sessionId, 'CREATED', userId, { gameKey: definition.key, fee, host: true });

    const participants = await readParticipants(client, sessionId);
    const players = playersOf(participants);
    // A one-seat table would start immediately; every shipped game needs at least two, so
    // the ready state is only announced once a start is actually possible.
    const ready = players.length >= rules.minPlayers;
    const patch = ready ? "status = 'READY'" : 'status = status';
    await client.query(`UPDATE game_sessions SET ${patch} WHERE id = $1`, [sessionId]);

    const fresh = await readSession(client, sessionId, false);
    return { session: fresh, participants, driver };
  });

  const { session, participants } = result;
  await broadcast(session, participants, { phase: 'waiting' });
  return toGameSession(session, participants, publicState(session.game_key, session.state));
}

/**
 * Take a seat, and pay for it in the same transaction.
 *
 * The session row lock is the whole trick: `UNIQUE (session_id, user_id)` stops the same
 * account joining twice, `UNIQUE (session_id, position)` stops two racing clients landing
 * in the same seat, and because the debit and the seat are written together there is no
 * window where a player has paid for a seat nobody gave them.
 */
export async function joinSession(userId: string, sessionId: string): Promise<GameSessionDto> {
  const allowed = await rateLimit(`game:join:${userId}`, 20, 60);
  if (allowed === -1) throw ApiError.tooManyRequests('Too many game joins in a minute');

  const result = await withTransaction(async (client) => {
    const session = await readSession(client, sessionId, true);
    if (session.status !== 'WAITING' && session.status !== 'READY') {
      throw ApiError.conflict('This match already started', 'game_started');
    }
    const room = session.room_id ? await loadRoom(session.room_id, client) : null;
    if (room) await assertRoomAccess(room, userId);

    const existing = await readParticipants(client, sessionId);
    if (existing.some((p) => p.user_id === userId)) throw ApiError.conflict('You are already in this match', 'already_joined');

    const rules = session.rules;
    const position = existing.length ? Math.max(...existing.map((p) => p.position)) + 1 : 0;
    if (position >= session.max_players) throw ApiError.conflict('This match is full', 'game_full');

    await assertDailyEntryLimit(client, userId, rules.dailyEntryLimit);

    const fee = session.entry_fee_diamonds;
    const moves = fee > 0 ? await postGameMoves(client, [{ type: 'GAME_ENTRY', userId, diamonds: fee, sessionId, roomId: session.room_id, note: `${session.game_key} entry` }]) : [];
    await client.query(
      `INSERT INTO game_participants (session_id, user_id, position, status, entry_fee_diamonds, fee_transaction_id)
       VALUES ($1,$2,$3,'JOINED',$4,$5)`,
      [sessionId, userId, position, fee, moves[0]?.transactionId ?? null],
    );
    await appendEvent(client, sessionId, 'JOINED', userId, { position, fee });

    const participants = await readParticipants(client, sessionId);
    const ready = playersOf(participants).length >= rules.minPlayers && session.status === 'WAITING';
    if (ready) await client.query("UPDATE game_sessions SET status = 'READY' WHERE id = $1", [sessionId]);

    const fresh = await readSession(client, sessionId, false);
    return { session: fresh, participants };
  });

  await broadcast(result.session, result.participants, { phase: 'lobby' });
  return toGameSession(result.session, result.participants, publicState(result.session.game_key, result.session.state));
}

export async function setReady(userId: string, sessionId: string): Promise<GameSessionDto> {
  const result = await withTransaction(async (client) => {
    const session = await readSession(client, sessionId, true);
    if (session.status !== 'WAITING' && session.status !== 'READY') throw ApiError.conflict('This match already started', 'game_started');
    const mine = (await readParticipants(client, sessionId)).find((p) => p.user_id === userId);
    if (!mine) throw ApiError.forbidden('Join the match first', 'not_a_player');
    if (mine.status === 'LEFT') throw ApiError.conflict('You left this match', 'already_left');
    await client.query("UPDATE game_participants SET status = 'READY', ready_at = now() WHERE id = $1", [mine.id]);
    await appendEvent(client, sessionId, 'READY', userId, { position: mine.position });
    const participants = await readParticipants(client, sessionId);
    const allReady = playersOf(participants).every((p) => participants.find((x) => x.user_id === p.userId)?.ready_at !== null);
    const fresh = await readSession(client, sessionId, false);
    return { session: fresh, participants, allReady };
  });

  await broadcast(result.session, result.participants, { phase: 'ready' });
  return toGameSession(result.session, result.participants, publicState(result.session.game_key, result.session.state));
}

/**
 * Deal the board and start the clock. The state a match is played on is created here, from
 * the frozen seat list — no client ever sends a board, a question order or a dice value.
 */
export async function startSession(actorId: string, sessionId: string, opts: { asAdmin?: boolean } = {}): Promise<GameSessionDto> {
  const result = await withTransaction(async (client) => {
    const session = await readSession(client, sessionId, true);
    if (session.status !== 'WAITING' && session.status !== 'READY') throw ApiError.conflict('Already started', 'game_started');
    await assertMatchManager(session, actorId, Boolean(opts.asAdmin));

    const participants = await readParticipants(client, sessionId);
    const players = playersOf(participants);
    if (players.length < session.rules.minPlayers) {
      throw ApiError.badRequest(`${session.game_key} needs at least ${session.rules.minPlayers} players`, 'not_enough_players');
    }
    // Everyone seated has to have said yes, except the seat that never got a turn to (the
    // creator is marked ready by opening the match).
    const notReady = players.filter((p) => participants.find((x) => x.user_id === p.userId)?.ready_at === null);
    if (notReady.length) throw ApiError.conflict('Waiting for every player to be ready', 'players_not_ready');

    const driver = driverFor(session.game_key);
    const ctx = contextFor(session, players, session.room_id);
    const state = driver.initialState(ctx);
    const owner = driver.turnOwner(state, ctx);
    const deadline = owner ? new Date(Date.now() + owner.seconds * 1_000) : null;

    await client.query(
      `UPDATE game_sessions
          SET status = 'IN_PROGRESS', state = $2::jsonb, started_at = now(), turn_deadline_at = $3, turn_owner_id = $4
        WHERE id = $1`,
      [sessionId, asJson(state), deadline, owner?.userId ?? null],
    );
    await client.query("UPDATE game_participants SET status = 'PLAYING' WHERE session_id = $1 AND user_id = ANY($2::uuid[])", [
      sessionId,
      players.map((p) => p.userId),
    ]);
    await appendEvent(client, sessionId, 'STARTED', actorId, { players: players.length, turnOwner: owner?.userId ?? null, deadline });

    const fresh = await readSession(client, sessionId, false);
    return { session: fresh, participants: await readParticipants(client, sessionId) };
  });

  await broadcast(result.session, result.participants, { phase: 'playing' });
  return toGameSession(result.session, result.participants, publicState(result.session.game_key, result.session.state));
}

/**
 * Apply one player action. This is the only door a client has into a running board, and
 * everything it wants to change goes through the driver's validator first.
 */
export async function submitAction(userId: string, sessionId: string, action: GameAction): Promise<GameSessionDto> {
  const allowed = await rateLimit(`game:action:${userId}`, 30, 10);
  if (allowed === -1) throw ApiError.tooManyRequests('Too many moves in a short window');

  const result = await withTransaction(async (client) => {
    const session = await readSession(client, sessionId, true);
    if (session.status !== 'IN_PROGRESS') throw ApiError.conflict('This match is not being played', 'game_not_running');
    const participants = await readParticipants(client, sessionId);
    const mine = participants.find((p) => p.user_id === userId);
    if (!mine || !LIVE_STATUSES.includes(mine.status)) throw ApiError.forbidden('You are not in this match', 'not_a_player');

    const driver = driverFor(session.game_key);
    const players = playersOf(participants);
    const ctx = contextFor(session, players, session.room_id);
    const outcome = driver.applyAction(session.state, ctx, userId, action);
    if (!outcome.ok) throw ApiError.badRequest(outcome.message, outcome.code, { code: outcome.code });

    for (const event of outcome.events) {
      await appendEvent(client, sessionId, event.type, event.actorId ?? userId, event.payload ?? {});
    }

    const finished = driver.isFinished(outcome.state, ctx);
    let fresh: GameSessionRow = session;
    let settled: Awaited<ReturnType<typeof settleSession>> | null = null;
    if (finished) {
      const standings = driver.rankings(outcome.state, ctx);
      // The last move belongs to the board. settleSession flips the status but never writes
      // `state`, so without this the winning line exists only in the event log and anyone who
      // re-reads the match sees a grid one move short of over.
      await client.query('UPDATE game_sessions SET state = $2::jsonb WHERE id = $1', [sessionId, asJson(outcome.state)]);
      settled = await settleSession(client, { session: { ...session, state: outcome.state as Record<string, unknown> }, participants, standings });
      await client.query("UPDATE game_participants SET status = 'COMPLETED' WHERE session_id = $1 AND status <> 'LEFT'", [sessionId]);
      await appendEvent(client, sessionId, 'SETTLED', null, {
        grossPool: settled.grossPool,
        commission: settled.commission,
        prizePool: settled.prizePool,
        distributed: settled.distributed,
        payouts: settled.payouts,
      });
      // Read the row back: the caller's response has to say COMPLETED/SETTLED, not the status
      // the match had before this move landed.
      fresh = await readSession(client, sessionId, false);
    } else {
      const owner = driver.turnOwner(outcome.state, ctx);
      const deadline = owner ? new Date(Date.now() + owner.seconds * 1_000) : null;
      await client.query(
        `UPDATE game_sessions SET state = $2::jsonb, turn_owner_id = $3, turn_deadline_at = $4 WHERE id = $1`,
        [sessionId, asJson(outcome.state), owner?.userId ?? null, deadline],
      );
      await client.query('UPDATE game_participants SET last_action_at = now(), status = $3 WHERE session_id = $1 AND user_id = $2', [
        sessionId,
        userId,
        mine.status === 'DISCONNECTED' ? 'PLAYING' : mine.status,
      ]);
      fresh = await readSession(client, sessionId, false);
    }

    return { session: fresh, participants: await readParticipants(client, sessionId), finished, settled };
  });

  await broadcast(result.session, result.participants, {
    phase: result.finished ? 'finished' : 'playing',
    settlement: result.settled && result.settled.settled
      ? {
          grossPool: result.settled.grossPool,
          commission: result.settled.commission,
          prizePool: result.settled.prizePool,
          distributed: result.settled.distributed,
          payouts: result.settled.payouts,
        }
      : null,
  });
  return toGameSession(result.session, result.participants, publicState(result.session.game_key, result.session.state));
}

/**
 * The clock ran out. Called by the sweep, and also by `loadSession` when somebody asks for
 * a match that is past its deadline — which is what lets a test, or a room with no
 * traffic, finish a game without waiting for a timer to fire.
 */
export async function advanceExpired(sessionId: string): Promise<{ progressed: boolean; session?: GameSessionRow }> {
  return withTransaction(async (client) => {
    const session = await readSession(client, sessionId, true);
    if (session.status !== 'IN_PROGRESS') return { progressed: false, session };
    if (!session.turn_deadline_at || new Date(session.turn_deadline_at).getTime() > Date.now()) return { progressed: false, session };

    const participants = await readParticipants(client, sessionId);
    const players = playersOf(participants);
    const driver = driverFor(session.game_key);
    const ctx = contextFor(session, players, session.room_id);
    const { state, events } = driver.onTimeout(session.state, ctx);
    for (const event of events) await appendEvent(client, sessionId, event.type, event.actorId ?? null, event.payload ?? {});

    if (driver.isFinished(state, ctx)) {
      await client.query('UPDATE game_sessions SET state = $2::jsonb WHERE id = $1', [sessionId, asJson(state)]);
      await settleSession(client, {
        session: { ...session, state: state as Record<string, unknown> },
        participants,
        standings: driver.rankings(state, ctx),
      });
      await appendEvent(client, sessionId, 'SETTLED', null, { byTimeout: true });
      const finishedRow = await readSession(client, sessionId, false);
      await broadcast(finishedRow, await readParticipants(client, sessionId), { phase: 'finished' });
      return { progressed: true, session: finishedRow };
    }

    const owner = driver.turnOwner(state, ctx);
    const deadline = owner ? new Date(Date.now() + owner.seconds * 1_000) : null;
    await client.query('UPDATE game_sessions SET state = $2::jsonb, turn_owner_id = $3, turn_deadline_at = $4 WHERE id = $1', [
      sessionId,
      asJson(state),
      owner?.userId ?? null,
      deadline,
    ]);
    const fresh = await readSession(client, sessionId, false);
    await broadcast(fresh, await readParticipants(client, sessionId), { phase: 'playing' });
    return { progressed: true, session: fresh };
  });
}

/** How many matches the sweep was asked to look at; the caller logs it. */
export async function sweepExpiredSessions(limit = 25): Promise<number> {
  const due = await many<{ id: string }>(
    `SELECT id FROM game_sessions
      WHERE status = 'IN_PROGRESS' AND turn_deadline_at IS NOT NULL AND turn_deadline_at <= now()
      ORDER BY turn_deadline_at LIMIT $1`,
    [limit],
  );
  let progressed = 0;
  for (const row of due) {
    // One session's failure must not strand the rest of the queue.
    const outcome = await advanceExpired(row.id).catch((err) => {
      console.warn('[game] timeout sweep', row.id, err.message);
      return { progressed: false };
    });
    if (outcome.progressed) progressed += 1;
  }
  return progressed;
}

/**
 * Stop a match that never finished. Fees come back when the pinned rules say they should,
 * and the entry rows stay posted — a refund is a new row beside them, never an edit.
 */
export async function cancelSession(
  actorId: string,
  sessionId: string,
  reason: string,
  opts: { asAdmin?: boolean } = {},
): Promise<GameSessionDto> {
  const summary = requireString(reason, 'reason', { max: 200 });
  const result = await withTransaction(async (client) => {
    const session = await readSession(client, sessionId, true);
    if (session.status === 'COMPLETED' || session.status === 'CANCELLED') throw ApiError.conflict('This match is already closed', 'game_closed');
    await assertMatchManager(session, actorId, Boolean(opts.asAdmin));

    const participants = await readParticipants(client, sessionId);
    const refundable = session.rules.refundPolicy === 'ALWAYS' || session.rules.refundPolicy === 'CANCELLED';
    const refunded = refundable ? await refundFees(client, { session, participants, reason: summary }) : { refunded: 0, refunds: [] };

    await client.query(
      `UPDATE game_sessions SET status = 'CANCELLED', cancel_reason = $2, ended_at = now(),
                              turn_owner_id = NULL, turn_deadline_at = NULL WHERE id = $1`,
      [sessionId, summary],
    );
    await appendEvent(client, sessionId, 'CANCELLED', actorId, { reason: summary, refunded: refunded.refunded });

    const fresh = await readSession(client, sessionId, false);
    return { session: fresh, participants: await readParticipants(client, sessionId), refunded: refunded.refunded };
  });

  await broadcast(result.session, result.participants, { phase: 'cancelled', refunded: result.refunded });
  return toGameSession(result.session, result.participants, publicState(result.session.game_key, result.session.state));
}

/**
 * Note the seats a socket left, so the roster shows the truth while a phone is in a
 * tunnel. Nothing is given up: the sweep still passes their turn, and their next action
 * marks them back as playing.
 */
export async function markDisconnected(userId: string): Promise<number> {
  const res = await query(
    `UPDATE game_participants p
        SET status = 'DISCONNECTED', disconnected_at = now()
       FROM game_sessions s
      WHERE p.session_id = s.id AND s.status = 'IN_PROGRESS' AND p.user_id = $1
        AND p.status IN ('JOINED','READY','PLAYING')`,
    [userId],
  );
  return res.rowCount ?? 0;
}

/** Leave a lobby seat before the match starts; a running match is forfeited, not left. */
export async function leaveSession(userId: string, sessionId: string): Promise<GameSessionDto> {
  const result = await withTransaction(async (client) => {
    const session = await readSession(client, sessionId, true);
    const mine = (await readParticipants(client, sessionId)).find((p) => p.user_id === userId);
    if (!mine) throw ApiError.forbidden('You are not in this match', 'not_a_player');
    if (session.status === 'IN_PROGRESS') {
      // The fee stays spent: they sat down, the game paid for the seat at the table.
      await client.query("UPDATE game_participants SET status = 'LEFT', disconnected_at = now() WHERE id = $1", [mine.id]);
      await appendEvent(client, sessionId, 'LEFT', userId, { position: mine.position, forfeit: true });
    } else if (session.status === 'WAITING' || session.status === 'READY') {
      const refunded = await refundFees(client, { session, participants: [mine], reason: 'Left before the match started' });
      await client.query("UPDATE game_participants SET status = 'LEFT', disconnected_at = now() WHERE id = $1", [mine.id]);
      await appendEvent(client, sessionId, 'LEFT', userId, { position: mine.position, refunded: refunded.refunded });
    } else {
      throw ApiError.conflict('This match is already closed', 'game_closed');
    }

    const participants = await readParticipants(client, sessionId);
    if (!playersOf(participants).length) {
      await client.query("UPDATE game_sessions SET status = 'CANCELLED', cancel_reason = 'Everyone left', ended_at = now() WHERE id = $1", [
        sessionId,
      ]);
    }
    const fresh = await readSession(client, sessionId, false);
    return { session: fresh, participants };
  });

  await broadcast(result.session, result.participants, { phase: 'lobby' });
  return toGameSession(result.session, result.participants, publicState(result.session.game_key, result.session.state));
}

/**
 * A player's objection to a finished match.
 *
 * The result is not un-published: money already paid stays paid until an operator says
 * otherwise, because silently reversing a settlement would make the ledger disagree with
 * what every client already showed. The session moves to `DISPUTED` only for settlement
 * purposes, and the review is what moves money.
 */
export async function raiseDispute(userId: string, sessionId: string, reason: string): Promise<GameDisputeDto> {
  const summary = requireString(reason, 'reason', { max: 500 });
  const row = await withTransaction(async (client) => {
    const session = await readSession(client, sessionId, true);
    if (session.status === 'WAITING' || session.status === 'READY') throw ApiError.conflict('There is no result to dispute yet', 'not_finished');
    const participants = await readParticipants(client, sessionId);
    if (!participants.some((p) => p.user_id === userId)) throw ApiError.forbidden('Only a player can dispute a match', 'not_a_player');

    const inserted = await client.query<GameDisputeRow>(
      `INSERT INTO game_disputes (session_id, raised_by, reason) VALUES ($1,$2,$3)
       ON CONFLICT (session_id, raised_by) DO UPDATE SET reason = EXCLUDED.reason
       RETURNING *`,
      [sessionId, userId, summary],
    );
    await client.query("UPDATE game_sessions SET settlement_status = 'DISPUTED' WHERE id = $1 AND settlement_status <> 'REFUNDED'", [
      sessionId,
    ]);
    await appendEvent(client, sessionId, 'DISPUTED', userId, { reason: summary });
    return inserted.rows[0];
  });

  const withName = await one<GameDisputeRow & { username: string; avatar_url: string | null }>(
    `SELECT d.*, u.username, u.avatar_url FROM game_disputes d JOIN users u ON u.id = d.raised_by WHERE d.id = $1`,
    [row.id],
  );
  if (!withName) throw ApiError.notFound('Dispute not found');
  return toGameDispute(withName);
}

export type DisputeDecision = 'UPHELD' | 'REJECTED' | 'REFUNDED';

/**
 * Operator review. `REFUNDED` hands every collected fee back and is the only decision that
 * moves money; `UPHELD` agrees with the player but leaves the settlement alone, which is
 * what a reported cheat looks like when the proof is in the event log, not the ledger.
 */
export async function reviewDispute(
  adminId: string,
  disputeId: string,
  decision: DisputeDecision,
  resolution: string,
): Promise<GameDisputeDto> {
  const note = requireString(resolution, 'resolution', { max: 500 });
  const row = await withTransaction(async (client) => {
    const disputes = await client.query<GameDisputeRow>('SELECT * FROM game_disputes WHERE id = $1 FOR UPDATE', [disputeId]);
    const dispute = disputes.rows[0];
    if (!dispute) throw ApiError.notFound('Dispute not found', 'dispute_not_found');
    if (dispute.status !== 'OPEN' && dispute.status !== 'UNDER_REVIEW') throw ApiError.conflict('Already reviewed', 'dispute_closed');

    const session = await readSession(client, dispute.session_id, true);
    if (decision === 'REFUNDED') {
      const participants = await readParticipants(client, session.id);
      const refunded = await refundFees(client, { session, participants, reason: `Dispute: ${note}` });
      await appendEvent(client, session.id, 'REFUNDED', null, { by: adminId, refunded: refunded.refunded, reason: note });
    }

    await client.query(
      `UPDATE game_disputes SET status = $2, resolution = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`,
      [disputeId, decision, note, adminId],
    );
    await recordAudit(
      {
        adminId,
        action: 'GAME_DISPUTE_REVIEW',
        targetType: 'game_dispute',
        targetId: disputeId,
        summary: `${decision} on ${session.game_key} session ${session.id}`,
        details: { decision, sessionStatus: session.status, settlementStatus: session.settlement_status },
      },
      client,
    );
    const updated = await client.query<GameDisputeRow>('SELECT * FROM game_disputes WHERE id = $1', [disputeId]);
    return updated.rows[0];
  });

  const withName = await one<GameDisputeRow & { username: string; avatar_url: string | null }>(
    `SELECT d.*, u.username, u.avatar_url FROM game_disputes d JOIN users u ON u.id = d.raised_by WHERE d.id = $1`,
    [row.id],
  );
  if (!withName) throw ApiError.notFound('Dispute not found');
  return toGameDispute(withName);
}

/** One match, with its seats. Sweeps an expired turn first so a read is also a tick. */
export async function loadSession(sessionId: string): Promise<GameSessionDto> {
  await advanceExpired(sessionId).catch(() => undefined);
  const session = await one<GameSessionRow & { creator_username: string }>(`${SESSION_SELECT} WHERE s.id = $1`, [sessionId]);
  if (!session) throw ApiError.notFound('Game not found', 'game_not_found');
  const participants = await many<GameParticipantRow & { username: string; avatar_url: string | null }>(PARTICIPANTS_SELECT, [sessionId]);
  return toGameSession(session, participants, publicState(session.game_key, session.state));
}

export async function listRoomSessions(roomId: string, limit = 10): Promise<GameSessionDto[]> {
  const sessions = await many<GameSessionRow & { creator_username: string }>(
    `${SESSION_SELECT} WHERE s.room_id = $1 ORDER BY s.created_at DESC LIMIT $2`,
    [roomId, limit],
  );
  const withPlayers = await many<GameParticipantRow & { session_id: string; username: string; avatar_url: string | null }>(
    `SELECT p.*, u.username, u.avatar_url FROM game_participants p JOIN users u ON u.id = p.user_id
      WHERE p.session_id = ANY($1::uuid[]) ORDER BY p.session_id, p.position`,
    [sessions.map((s) => s.id)],
  );
  return sessions.map((session) => {
    const participants = withPlayers.filter((p) => p.session_id === session.id);
    return toGameSession(session, participants, publicState(session.game_key, session.state));
  });
}

/** A player's finished matches, newest first — the history screen and the dispute form. */
export async function listUserHistory(userId: string, limit = 20): Promise<
  Array<{
    sessionId: string;
    gameKey: string;
    status: string;
    rank: number | null;
    score: number;
    prizeDiamonds: number;
    entryFeeDiamonds: number;
    endedAt: string | null;
    createdAt: string;
  }>
> {
  const rows = await many<{
    session_id: string;
    game_key: string;
    status: string;
    rank: number | null;
    score: string;
    prize_diamonds: number;
    entry_fee_diamonds: number;
    ended_at: Date | null;
    created_at: Date;
  }>(
    `SELECT p.session_id, s.game_key, s.status, p.rank, p.score, p.prize_diamonds, s.entry_fee_diamonds,
            s.ended_at, s.created_at
       FROM game_participants p JOIN game_sessions s ON s.id = p.session_id
      WHERE p.user_id = $1
      ORDER BY s.created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((row) => ({
    sessionId: row.session_id,
    gameKey: row.game_key,
    status: row.status,
    rank: row.rank,
    score: Number(row.score),
    prizeDiamonds: row.prize_diamonds,
    entryFeeDiamonds: row.entry_fee_diamonds,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/** The replay an operator needs before ruling on a match: every action, in order. */
export async function listSessionEvents(sessionId: string, limit = 200): Promise<
  Array<{ seq: number; type: string; actorId: string | null; payload: Record<string, unknown>; createdAt: string }>
> {
  const rows = await many<{ seq: number; type: string; actor_id: string | null; payload: Record<string, unknown>; created_at: Date }>(
    'SELECT seq, type, actor_id, payload, created_at FROM game_events WHERE session_id = $1 ORDER BY seq LIMIT $2',
    [sessionId, limit],
  );
  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    actorId: row.actor_id,
    payload: row.payload,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/** Back-office session list: the console needs closed matches, not just live ones. */
export async function listSessionsForAdmin(opts: {
  gameKey?: string;
  status?: string;
  limit: number;
}): Promise<GameSessionDto[]> {
  const sessions = await many<GameSessionRow & { creator_username: string }>(
    `SELECT s.*, u.username AS creator_username
       FROM game_sessions s JOIN users u ON u.id = s.created_by
      WHERE ($1::text IS NULL OR s.game_key = $1)
        AND ($2::text IS NULL OR s.status::text = $2)
      ORDER BY s.created_at DESC LIMIT $3`,
    [opts.gameKey ?? null, opts.status ?? null, opts.limit],
  );
  const participants = await many<GameParticipantRow & { session_id: string; username: string; avatar_url: string | null }>(
    `SELECT p.*, u.username, u.avatar_url FROM game_participants p JOIN users u ON u.id = p.user_id
      WHERE p.session_id = ANY($1::uuid[]) ORDER BY p.session_id, p.position`,
    [sessions.map((s) => s.id)],
  );
  return sessions.map((session) =>
    toGameSession(session, participants.filter((p) => p.session_id === session.id), publicState(session.game_key, session.state)),
  );
}

export async function listDisputes(opts: { status?: string; limit: number }): Promise<GameDisputeDto[]> {
  const rows = await many<GameDisputeRow & { username: string; avatar_url: string | null }>(
    `SELECT d.*, u.username, u.avatar_url FROM game_disputes d
       JOIN users u ON u.id = d.raised_by
      WHERE ($1::text IS NULL OR d.status::text = $1)
      ORDER BY d.created_at DESC LIMIT $2`,
    [opts.status ?? null, opts.limit],
  );
  return rows.map(toGameDispute);
}

export type GameRulePatch = {
  isActive?: boolean;
  entryFeeEnabled?: boolean;
  entryFeeDiamonds?: number;
  prizeEnabled?: boolean;
  commissionBps?: number;
  prizeRules?: Array<{ rank: number; shareBps: number }>;
  /**
   * The band an entry fee may sit in. Seeded as 0..0, so every game ships free-to-play and
   * paid entry only exists once an operator raises the ceiling and confirms compliance.
   */
  entryFeeMin?: number;
  entryFeeMax?: number;
  refundPolicy?: 'NONE' | 'CANCELLED' | 'DISPUTED' | 'ALWAYS';
  turnTimeoutSeconds?: number;
  maxPlayers?: number;
  dailyEntryLimit?: number;
  promoFreeEntry?: boolean;
  promoUntil?: string | null;
};

/**
 * Change a game's rules, with the version trail that makes the change auditable.
 *
 * Any money-affecting field bumps `rules_version` and writes a snapshot, so a session that
 * was already running keeps settling under the numbers it started with and the console can
 * still show what was in force on a given day. Two operators editing at once is settled by
 * the row lock, not by last-write-wins.
 */
export async function updateGameDefinition(
  adminId: string,
  key: string,
  patch: GameRulePatch,
): Promise<{ definition: GameDefinitionDto; rulesChanged: boolean }> {
  const result = await withTransaction(async (client) => {
    const rows = await client.query<GameDefinitionRow>('SELECT * FROM game_definitions WHERE key = $1 FOR UPDATE', [key]);
    const current = rows.rows[0];
    if (!current) throw ApiError.notFound(`No game called ${key}`, 'game_not_found');

    const fee = patch.entryFeeDiamonds ?? current.entry_fee_diamonds;
    const min = patch.entryFeeMin ?? current.entry_fee_min;
    const max = patch.entryFeeMax ?? current.entry_fee_max;
    if (min < 0 || max < 0) throw ApiError.badRequest('An entry fee band cannot be negative', 'fee_band_invalid');
    if (max < min) throw ApiError.badRequest('The entry fee ceiling must be at or above the floor', 'fee_band_invalid');
    if (fee < min || fee > max) throw ApiError.badRequest(`Entry fee must be between ${min} and ${max}`, 'fee_out_of_range');
    if (patch.commissionBps !== undefined && (patch.commissionBps < 0 || patch.commissionBps > 5000)) {
      throw ApiError.badRequest('Commission must be between 0 and 50% (5000 bps)', 'commission_out_of_range');
    }
    if (patch.prizeRules) {
      const total = patch.prizeRules.reduce((sum, rule) => sum + (Number.isInteger(rule.shareBps) ? rule.shareBps : NaN), 0);
      if (!Number.isFinite(total) || total > 10_000) throw ApiError.badRequest('Prize shares must be whole and add up to 10000 bps or less', 'bad_prize_rules');
    }

    const moneyChanged =
      patch.entryFeeEnabled !== undefined ||
      patch.entryFeeDiamonds !== undefined ||
      patch.entryFeeMin !== undefined ||
      patch.entryFeeMax !== undefined ||
      patch.prizeEnabled !== undefined ||
      patch.commissionBps !== undefined ||
      patch.prizeRules !== undefined ||
      patch.refundPolicy !== undefined;

    const next: GameDefinitionRow = {
      ...current,
      is_active: patch.isActive ?? current.is_active,
      entry_fee_enabled: patch.entryFeeEnabled ?? current.entry_fee_enabled,
      entry_fee_diamonds: fee,
      entry_fee_min: min,
      entry_fee_max: max,
      prize_enabled: patch.prizeEnabled ?? current.prize_enabled,
      commission_bps: patch.commissionBps ?? current.commission_bps,
      prize_rules: patch.prizeRules ?? current.prize_rules,
      refund_policy: patch.refundPolicy ?? current.refund_policy,
      turn_timeout_seconds: patch.turnTimeoutSeconds ?? current.turn_timeout_seconds,
      max_players: patch.maxPlayers ?? current.max_players,
      daily_entry_limit: patch.dailyEntryLimit ?? current.daily_entry_limit,
      promo_free_entry: patch.promoFreeEntry ?? current.promo_free_entry,
      promo_until: patch.promoUntil === undefined ? current.promo_until : patch.promoUntil ? new Date(patch.promoUntil) : null,
      rules_version: moneyChanged ? current.rules_version + 1 : current.rules_version,
    };

    await client.query(
      `UPDATE game_definitions
          SET is_active = $2, entry_fee_enabled = $3, entry_fee_diamonds = $4, prize_enabled = $5, commission_bps = $6,
              prize_rules = $7::jsonb, refund_policy = $8, turn_timeout_seconds = $9, max_players = $10,
              daily_entry_limit = $11, promo_free_entry = $12, promo_until = $13, rules_version = $14,
              entry_fee_min = $15, entry_fee_max = $16
        WHERE key = $1`,
      [
        key,
        next.is_active,
        next.entry_fee_enabled,
        next.entry_fee_diamonds,
        next.prize_enabled,
        next.commission_bps,
        asJson(next.prize_rules),
        next.refund_policy,
        next.turn_timeout_seconds,
        next.max_players,
        next.daily_entry_limit,
        next.promo_free_entry,
        next.promo_until,
        next.rules_version,
        next.entry_fee_min,
        next.entry_fee_max,
      ],
    );

    if (moneyChanged) {
      const rules = pinRules(next);
      await client.query(
        `INSERT INTO game_rule_snapshots (game_key, rules_version, rules, changed_by)
         VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (game_key, rules_version) DO UPDATE SET rules = EXCLUDED.rules`,
        [key, next.rules_version, asJson(rules), adminId],
      );
    }

    await recordAudit(
      {
        adminId,
        action: 'GAME_RULES_UPDATE',
        targetType: 'game_definition',
        targetId: current.id,
        summary: `${key} to rules_version ${next.rules_version}`,
        details: { before: current, after: { ...next, created_at: undefined, updated_at: undefined }, patch },
      },
      client,
    );
    return { next, moneyChanged };
  });

  return { definition: toGameDefinition(result.next), rulesChanged: result.moneyChanged };
}

