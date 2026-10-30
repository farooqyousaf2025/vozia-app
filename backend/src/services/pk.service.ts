import { PoolClient } from 'pg';
import { many, one, withTransaction } from '../config/db';
import { rateLimit } from '../config/redis';
import { PkBattleRow, PkSettingsRow } from '../types/db';
import { ApiError, requireBoolean, requireInt } from '../utils/http';
import { awardXp, ensureRankRegistry } from './rank.service';

/**
 * PK battles: two live rooms, one clock, and a gift race decided by the ledger.
 *
 * The score is deliberately *not* something this file writes on every gift. It is the sum of
 * `GIFT_SENT` rows inside a room between `started_at` and `ends_at`, read back from the same
 * `transactions` table that moved the diamonds. That gives three properties for free:
 *
 *   * a phone cannot add a point — there is no route, event or column to write;
 *   * a rolled-back gift cannot leave a score behind, because it never left a transaction row;
 *   * a live board and the settled result are the same arithmetic, so a battle cannot "end
 *     differently" from what supporters watched.
 *
 * What settlement writes is the frozen answer: both totals, the winner (or NULL for a draw) and
 * the bonus paid to the winning room's top spender. `transactions` is never edited (§brief: posted
 * financial entries are immutable); the battle row is the only thing that ever changes.
 *
 * This module emits through an injected broadcaster rather than importing the socket layer:
 * socket handlers will ask this module for a live battle on join, so the dependency has to point
 * one way only (same arrangement as `game.service`).
 */

type Broadcast = (target: { roomId?: string; userId?: string }, event: string, payload: unknown) => void;

let broadcast: Broadcast = () => undefined;

/** Called once from `index.ts`, which owns the socket server. */
export function setPkBroadcaster(fn: Broadcast): void {
  broadcast = fn;
}

function announce(battle: PkBattleDto): void {
  for (const roomId of [battle.roomA.id, battle.roomB.id]) {
    broadcast({ roomId }, 'pk:state', battle);
  }
}

export type PkSettingsDto = {
  isEnabled: boolean;
  inviteTimeoutSeconds: number;
  minDurationSeconds: number;
  defaultDurationSeconds: number;
  maxDurationSeconds: number;
  winnerBonusXp: number;
};

export type PkRoomDto = {
  id: string;
  title: string;
  coverUrl: string | null;
  hostId: string;
  hostUsername: string;
};

export type PkBattleDto = {
  id: string;
  status: 'INVITED' | 'ACTIVE' | 'FINISHED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';
  /** Room A is the challenger. */
  roomA: PkRoomDto;
  roomB: PkRoomDto;
  durationSeconds: number;
  /** Diamonds spent inside each room during the window; frozen once FINISHED. */
  scores: { a: number; b: number };
  /** What a point is, so a client never has to guess the unit. */
  unit: 'diamond';
  invitedAt: string;
  inviteExpiresAt: string;
  startedAt: string | null;
  endsAt: string | null;
  finishedAt: string | null;
  /** Milliseconds until the clock runs out; 0 for anything that is not running. */
  remainingMs: number;
  winnerRoomId: string | null;
  /** XP the winning room's top spender was actually paid; 0 when there was no prize. */
  bonusXp: number;
  bonusUserId: string | null;
  /** True when an operator ended the battle before its clock. */
  stopped: boolean;
};

type PkBattleJoinedRow = PkBattleRow & {
  room_a_title: string;
  room_a_cover_url: string | null;
  room_a_host_id: string;
  room_a_host_username: string;
  room_b_title: string;
  room_b_cover_url: string | null;
  room_b_host_id: string;
  room_b_host_username: string;
};

const BATTLE_SELECT = `
  SELECT b.*,
         ra.title AS room_a_title, ra.cover_url AS room_a_cover_url, ra.host_id AS room_a_host_id,
         ua.username AS room_a_host_username,
         rb.title AS room_b_title, rb.cover_url AS room_b_cover_url, rb.host_id AS room_b_host_id,
         ub.username AS room_b_host_username
    FROM pk_battles b
    JOIN rooms ra ON ra.id = b.room_a_id
    JOIN rooms rb ON rb.id = b.room_b_id
    JOIN users ua ON ua.id = ra.host_id
    JOIN users ub ON ub.id = rb.host_id`;

/**
 * The one definition of "the score": diamonds spent inside one of the two rooms between the
 * start and the end of the battle. `amount_diamonds` is what the ledger debited the sender, so a
 * 10-diamond gift with quantity 3 counts 30 — the same number the wallet moved.
 */
const SCORE_SQL = `
  SELECT room_id, COALESCE(SUM(amount_diamonds), 0)::bigint AS total
    FROM transactions
   WHERE type = 'GIFT_SENT'
     AND room_id = ANY($1::uuid[])
     AND created_at >= $2
     AND created_at <= $3
   GROUP BY room_id`;

// ---------------------------------------------------------------------------
// Dials
// ---------------------------------------------------------------------------

export async function readPkSettings(): Promise<PkSettingsDto> {
  const row = await one<PkSettingsRow>('SELECT * FROM pk_settings WHERE singleton');
  if (!row) throw new Error('pk_settings has no row — run npm run db:migrate before starting the API');
  return toSettingsDto(row);
}

function toSettingsDto(row: PkSettingsRow): PkSettingsDto {
  return {
    isEnabled: row.is_enabled,
    inviteTimeoutSeconds: row.invite_timeout_seconds,
    minDurationSeconds: row.min_duration_seconds,
    defaultDurationSeconds: row.default_duration_seconds,
    maxDurationSeconds: row.max_duration_seconds,
    winnerBonusXp: row.winner_bonus_xp,
  };
}

export async function updatePkSettings(body: Record<string, unknown>): Promise<PkSettingsDto> {
  const existing = await readPkSettings();
  const next: PkSettingsDto = {
    isEnabled: body?.isEnabled !== undefined ? requireBoolean(body.isEnabled, 'isEnabled') : existing.isEnabled,
    inviteTimeoutSeconds:
      body?.inviteTimeoutSeconds !== undefined
        ? requireInt(body.inviteTimeoutSeconds, 'inviteTimeoutSeconds', { min: 10, max: 900 })
        : existing.inviteTimeoutSeconds,
    minDurationSeconds:
      body?.minDurationSeconds !== undefined
        ? requireInt(body.minDurationSeconds, 'minDurationSeconds', { min: 10, max: 3600 })
        : existing.minDurationSeconds,
    defaultDurationSeconds:
      body?.defaultDurationSeconds !== undefined
        ? requireInt(body.defaultDurationSeconds, 'defaultDurationSeconds', { min: 10, max: 3600 })
        : existing.defaultDurationSeconds,
    maxDurationSeconds:
      body?.maxDurationSeconds !== undefined
        ? requireInt(body.maxDurationSeconds, 'maxDurationSeconds', { min: 10, max: 7200 })
        : existing.maxDurationSeconds,
    winnerBonusXp:
      body?.winnerBonusXp !== undefined
        ? requireInt(body.winnerBonusXp, 'winnerBonusXp', { min: 0, max: 100_000 })
        : existing.winnerBonusXp,
  };
  // The column's own CHECK enforces this too; asking here names the offending field instead of
  // surfacing a constraint name.
  if (!(next.minDurationSeconds <= next.defaultDurationSeconds && next.defaultDurationSeconds <= next.maxDurationSeconds)) {
    throw ApiError.badRequest(
      'Durations must satisfy min <= default <= max',
      'pk_duration_order',
      next,
    );
  }
  const row = await one<PkSettingsRow>(
    `UPDATE pk_settings
        SET is_enabled = $1, invite_timeout_seconds = $2, min_duration_seconds = $3,
            default_duration_seconds = $4, max_duration_seconds = $5, winner_bonus_xp = $6,
            updated_at = now()
      WHERE singleton
      RETURNING *`,
    [
      next.isEnabled,
      next.inviteTimeoutSeconds,
      next.minDurationSeconds,
      next.defaultDurationSeconds,
      next.maxDurationSeconds,
      next.winnerBonusXp,
    ],
  );
  if (!row) throw new Error('pk_settings row vanished while updating');
  return toSettingsDto(row);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function toRoomDto(row: PkBattleJoinedRow, side: 'a' | 'b'): PkRoomDto {
  return side === 'a'
    ? { id: row.room_a_id, title: row.room_a_title, coverUrl: row.room_a_cover_url, hostId: row.room_a_host_id, hostUsername: row.room_a_host_username }
    : { id: row.room_b_id, title: row.room_b_title, coverUrl: row.room_b_cover_url, hostId: row.room_b_host_id, hostUsername: row.room_b_host_username };
}

function toBattleDto(row: PkBattleJoinedRow, scores: { a: number; b: number }): PkBattleDto {
  const remaining = row.status === 'ACTIVE' && row.ends_at
    ? Math.max(0, new Date(row.ends_at).getTime() - Date.now())
    : 0;
  return {
    id: row.id,
    status: row.status as PkBattleDto['status'],
    roomA: toRoomDto(row, 'a'),
    roomB: toRoomDto(row, 'b'),
    durationSeconds: row.duration_seconds,
    scores,
    unit: 'diamond',
    invitedAt: row.invited_at.toISOString(),
    inviteExpiresAt: row.invite_expires_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    remainingMs: remaining,
    winnerRoomId: row.winner_room_id,
    bonusXp: row.bonus_xp_awarded,
    bonusUserId: row.bonus_user_id,
    stopped: row.stopped_by !== null,
  };
}

async function scoresFor(row: PkBattleJoinedRow): Promise<{ a: number; b: number }> {
  if (row.status === 'FINISHED') {
    // Frozen at settlement; re-summing would show a number the prize was not based on.
    return { a: Number(row.score_a ?? 0), b: Number(row.score_b ?? 0) };
  }
  if (row.status !== 'ACTIVE' || !row.started_at || !row.ends_at) return { a: 0, b: 0 };
  const rows = await many<{ room_id: string; total: string }>(SCORE_SQL, [
    [row.room_a_id, row.room_b_id],
    row.started_at,
    row.ends_at,
  ]);
  const byRoom = new Map(rows.map((r) => [r.room_id, Number(r.total)]));
  return { a: byRoom.get(row.room_a_id) ?? 0, b: byRoom.get(row.room_b_id) ?? 0 };
}

async function withScores(row: PkBattleJoinedRow): Promise<PkBattleDto> {
  return toBattleDto(row, await scoresFor(row));
}

async function battleRow(id: string, client?: PoolClient): Promise<PkBattleJoinedRow | null> {
  const sql = `${BATTLE_SELECT} WHERE b.id = $1`;
  return client ? (await client.query<PkBattleJoinedRow>(sql, [id])).rows[0] ?? null : one<PkBattleJoinedRow>(sql, [id]);
}

/**
 * The battle a room is in — invited or running. A battle whose clock has run out but which the
 * sweeper has not reached yet is settled on the way out, so a phone that opens the PK panel right
 * after the buzzer never sees a race that is over still counting down.
 */
export async function battleForRoom(roomId: string): Promise<PkBattleDto | null> {
  const row = await one<PkBattleJoinedRow>(
    `${BATTLE_SELECT}
      WHERE b.status IN ('INVITED', 'ACTIVE') AND (b.room_a_id = $1 OR b.room_b_id = $1)
      ORDER BY b.created_at DESC LIMIT 1`,
    [roomId],
  );
  if (!row) return null;
  if (row.status === 'ACTIVE' && row.ends_at && new Date(row.ends_at).getTime() <= Date.now()) {
    // Another caller may have settled it between the read and the lock; either way the answer is
    // the finished battle, not a race that is over.
    return (await settleBattle(row.id)) ?? battleById(row.id);
  }
  return withScores(row);
}

export async function battleById(id: string): Promise<PkBattleDto> {
  const row = await battleRow(id);
  if (!row) throw ApiError.notFound('Battle not found', 'pk_not_found');
  return withScores(row);
}

export async function battleHistoryForRoom(roomId: string, limit = 10): Promise<PkBattleDto[]> {
  const rows = await many<PkBattleJoinedRow>(
    `${BATTLE_SELECT}
      WHERE (b.room_a_id = $1 OR b.room_b_id = $1) AND b.status IN ('FINISHED', 'DECLINED', 'CANCELLED', 'EXPIRED')
      ORDER BY b.invited_at DESC LIMIT $2`,
    [roomId, Math.min(Math.max(1, limit), 50)],
  );
  return Promise.all(rows.map(withScores));
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

async function readDuration(value: unknown, settings: PkSettingsDto): Promise<number> {
  if (value === undefined || value === null) return settings.defaultDurationSeconds;
  const duration = requireInt(value, 'durationSeconds', { min: 1, max: 7200 });
  if (duration < settings.minDurationSeconds || duration > settings.maxDurationSeconds) {
    throw ApiError.badRequest(
      `A battle lasts between ${settings.minDurationSeconds} and ${settings.maxDurationSeconds} seconds`,
      'pk_duration_out_of_range',
      { min: settings.minDurationSeconds, max: settings.maxDurationSeconds },
    );
  }
  return duration;
}

/**
 * Challenge another host's room. The caller must host the room they are challenging *from*; the
 * other room's host decides whether it happens, so a member cannot drag somebody else's room into
 * a race. Both rooms are locked before the busy check, which is what stops two simultaneous
 * invitations from both succeeding and leaving a room in two races.
 */
export async function inviteBattle(
  hostUserId: string,
  roomId: string,
  opponentRoomId: string,
  durationValue?: unknown,
): Promise<PkBattleDto> {
  const settings = await readPkSettings();
  if (!settings.isEnabled) throw ApiError.conflict('PK battles are switched off', 'pk_disabled');
  if (roomId === opponentRoomId) throw ApiError.badRequest('A room cannot battle itself', 'pk_same_room');
  const duration = await readDuration(durationValue, settings);

  const allowed = await rateLimit(`pk-invite:${hostUserId}`, 6, 60);
  if (allowed === -1) throw ApiError.tooManyRequests('Slow down — too many challenges in a minute');

  const created = await withTransaction(async (client) => {
    const [first, second] = [roomId, opponentRoomId].sort();
    const rooms = await client.query<{ id: string; host_id: string; status: string }>(
      'SELECT id, host_id, status FROM rooms WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[first, second]],
    );
    if (rooms.rows.length !== 2) throw ApiError.notFound('Room not found', 'room_not_found');
    const mine = rooms.rows.find((r) => r.id === roomId)!;
    if (mine.host_id !== hostUserId) throw ApiError.forbidden('Only the room\'s host can start a battle', 'not_host');
    const closed = rooms.rows.find((r) => r.status !== 'ACTIVE');
    if (closed) throw ApiError.conflict('A room in this battle is closed', 'room_closed');

    const busy = await client.query(
      `SELECT id FROM pk_battles
        WHERE status IN ('INVITED', 'ACTIVE')
          AND (room_a_id = ANY($1::uuid[]) OR room_b_id = ANY($1::uuid[]))`,
      [[first, second]],
    );
    if (busy.rows.length > 0) {
      throw ApiError.conflict('One of these rooms is already in a battle', 'pk_room_busy');
    }

    const inserted = await client.query<PkBattleRow>(
      `INSERT INTO pk_battles (room_a_id, room_b_id, invited_by, duration_seconds, invite_expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::int))
       RETURNING *`,
      [roomId, opponentRoomId, hostUserId, duration, settings.inviteTimeoutSeconds],
    );
    return inserted.rows[0];
  });

  const row = await battleRow(created.id);
  const dto = await withScores(row!);
  announce(dto);
  // The challenged host may be anywhere in the app, so the private channel gets the invitation
  // too; the room broadcast above only reaches people already sitting in the room.
  broadcast({ userId: dto.roomB.hostId }, 'pk:invited', dto);
  return dto;
}

async function transition(
  battleId: string,
  actorUserId: string,
  from: 'INVITED',
  to: 'DECLINED' | 'CANCELLED',
  hostSide: 'a' | 'b',
): Promise<PkBattleDto> {
  await withTransaction(async (client) => {
    const locked = await client.query<PkBattleRow>('SELECT * FROM pk_battles WHERE id = $1 FOR UPDATE', [battleId]);
    const row = locked.rows[0];
    if (!row) throw ApiError.notFound('Battle not found', 'pk_not_found');
    if (row.status !== from) throw ApiError.conflict('This challenge is no longer open', 'pk_not_invited');
    const roomId = hostSide === 'a' ? row.room_a_id : row.room_b_id;
    const room = await client.query<{ host_id: string }>('SELECT host_id FROM rooms WHERE id = $1', [roomId]);
    if (room.rows[0]?.host_id !== actorUserId) {
      throw ApiError.forbidden('Only that room\'s host can answer this challenge', 'not_host');
    }
    await client.query('UPDATE pk_battles SET status = $2, finished_at = now() WHERE id = $1', [battleId, to]);
  });
  return battleById(battleId);
}

/** Accepted by the challenged room's host (room B). */
export async function acceptBattle(hostUserId: string, battleId: string): Promise<PkBattleDto> {
  const row = await withTransaction(async (client) => {
    const locked = await client.query<PkBattleRow>('SELECT * FROM pk_battles WHERE id = $1 FOR UPDATE', [battleId]);
    const battle = locked.rows[0];
    if (!battle) throw ApiError.notFound('Battle not found', 'pk_not_found');
    if (battle.status !== 'INVITED') throw ApiError.conflict('This challenge is no longer open', 'pk_not_invited');

    const rooms = await client.query<{ id: string; host_id: string; status: string }>(
      'SELECT id, host_id, status FROM rooms WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[battle.room_a_id, battle.room_b_id].sort()],
    );
    const hostRoom = rooms.rows.find((r) => r.id === battle.room_b_id);
    if (!hostRoom || hostRoom.host_id !== hostUserId) {
      throw ApiError.forbidden('Only the challenged room\'s host can accept', 'not_host');
    }
    if (new Date(battle.invite_expires_at).getTime() <= Date.now()) {
      throw ApiError.conflict('This challenge has expired', 'pk_invite_expired');
    }
    const closed = rooms.rows.find((r) => r.status !== 'ACTIVE');
    if (closed) throw ApiError.conflict('A room in this battle is closed', 'room_closed');

    const updated = await client.query<PkBattleRow>(
      `UPDATE pk_battles
          SET status = 'ACTIVE', started_at = now(), ends_at = now() + make_interval(secs => duration_seconds)
        WHERE id = $1
        RETURNING *`,
      [battleId],
    );
    return updated.rows[0];
  });
  const dto = await withScores((await battleRow(row.id))!);
  announce(dto);
  return dto;
}

/** The challenged host says no. */
export async function declineBattle(hostUserId: string, battleId: string): Promise<PkBattleDto> {
  const dto = await transition(battleId, hostUserId, 'INVITED', 'DECLINED', 'b');
  announce(dto);
  return dto;
}

/** The challenging host takes the offer back before it is answered. */
export async function cancelBattle(hostUserId: string, battleId: string): Promise<PkBattleDto> {
  const dto = await transition(battleId, hostUserId, 'INVITED', 'CANCELLED', 'a');
  announce(dto);
  return dto;
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * Freeze a running battle. Idempotent: two callers — the sweeper, a read that noticed the clock
 * ran out, an operator's stop — race on the row lock, and only the first one finds it ACTIVE.
 *
 * The bonus goes to the top diamond spender of the winning room, chosen with a deterministic
 * tie-break (highest total, then whoever got there first). A draw pays nobody, because picking a
 * side would need a tiebreaker rule nobody agreed to.
 *
 * Lock order is battle → user (inside `awardXp`). The gift path locks users but never the battle
 * row, so the two can never form a cycle.
 */
export async function settleBattle(
  battleId: string,
  opts: { stoppedBy?: string } = {},
): Promise<PkBattleDto | null> {
  await ensureRankRegistry();
  const settings = await readPkSettings();

  const settled = await withTransaction(async (client) => {
    const locked = await client.query<PkBattleRow>('SELECT * FROM pk_battles WHERE id = $1 FOR UPDATE', [battleId]);
    const row = locked.rows[0];
    if (!row) return null;
    // Only a running battle settles. An INVITED one that ran out of time is `expireInvites`' job.
    if (row.status !== 'ACTIVE' || !row.started_at || !row.ends_at) return null;
    const due = new Date(row.ends_at).getTime() <= Date.now();
    if (!due && !opts.stoppedBy) return null;

    const totals = await client.query<{ room_id: string; total: string }>(SCORE_SQL, [
      [row.room_a_id, row.room_b_id],
      row.started_at,
      row.ends_at,
    ]);
    const byRoom = new Map(totals.rows.map((r) => [r.room_id, Number(r.total)]));
    const scoreA = byRoom.get(row.room_a_id) ?? 0;
    const scoreB = byRoom.get(row.room_b_id) ?? 0;
    const winnerRoomId = scoreA > scoreB ? row.room_a_id : scoreB > scoreA ? row.room_b_id : null;

    let bonusUserId: string | null = null;
    let bonusXp = 0;
    if (winnerRoomId && settings.winnerBonusXp > 0) {
      const top = await client.query<{ sender_id: string }>(
        `SELECT sender_id
           FROM transactions
          WHERE type = 'GIFT_SENT' AND room_id = $1
            AND created_at >= $2 AND created_at <= $3
          GROUP BY sender_id
          ORDER BY SUM(amount_diamonds) DESC, min(created_at) ASC, sender_id ASC
          LIMIT 1`,
        [winnerRoomId, row.started_at, row.ends_at],
      );
      if (top.rows[0]) {
        bonusUserId = top.rows[0].sender_id;
        bonusXp = settings.winnerBonusXp;
        await awardXp(client, bonusUserId, bonusXp);
      }
    }

    const updated = await client.query<PkBattleRow>(
      `UPDATE pk_battles
          SET status = 'FINISHED', finished_at = now(), score_a = $2, score_b = $3,
              winner_room_id = $4, bonus_user_id = $5, bonus_xp_awarded = $6, stopped_by = $7
        WHERE id = $1
        RETURNING *`,
      [battleId, scoreA, scoreB, winnerRoomId, bonusUserId, bonusXp, opts.stoppedBy ?? null],
    );
    return updated.rows[0];
  });

  if (!settled) return null;
  const dto = await withScores((await battleRow(settled.id))!);
  announce(dto);
  return dto;
}

/** The clock's sweep: battles whose window is over. */
export async function settleDueBattles(): Promise<number> {
  const due = await many<{ id: string }>(
    `SELECT id FROM pk_battles WHERE status = 'ACTIVE' AND ends_at <= now() ORDER BY ends_at LIMIT 25`,
  );
  let settled = 0;
  for (const row of due) {
    const result = await settleBattle(row.id);
    if (result) settled += 1;
  }
  return settled;
}

/** Invitations nobody answered. Emitted so both rooms drop the pending banner. */
export async function expireInvites(): Promise<number> {
  const expired = await withTransaction(async (client) => {
    const updated = await client.query<{ id: string }>(
      `UPDATE pk_battles SET status = 'EXPIRED', finished_at = now()
        WHERE status = 'INVITED' AND invite_expires_at <= now()
        RETURNING id`,
    );
    return updated.rows.map((row) => row.id);
  });
  if (expired.length === 0) return 0;
  // Read each battle back after the write: one answered a moment ago is no longer INVITED, and
  // announcing it as expired would clear a banner for a race that just started.
  for (const id of expired) {
    const row = await battleRow(id);
    if (row) announce(await withScores(row));
  }
  return expired.length;
}

// ---------------------------------------------------------------------------
// Gift amplifier and admin reads
// ---------------------------------------------------------------------------

/**
 * Called after a gift posts in a room. If the room is fighting, the new score goes out to both
 * rooms. Nothing is written: the next reader sums the ledger, and this broadcast is only the
 * faster copy of that same number.
 */
export async function announceGiftScore(roomId: string): Promise<void> {
  const battle = await battleForRoom(roomId);
  if (battle && battle.status === 'ACTIVE') announce(battle);
}

export type AdminPkDto = {
  settings: PkSettingsDto;
  live: PkBattleDto[];
  recent: PkBattleDto[];
};

export async function listAdminPk(): Promise<AdminPkDto> {
  const [settings, liveRows, recentRows] = await Promise.all([
    readPkSettings(),
    many<PkBattleJoinedRow>(
      `${BATTLE_SELECT} WHERE b.status IN ('INVITED', 'ACTIVE') ORDER BY b.invited_at DESC LIMIT 50`,
    ),
    many<PkBattleJoinedRow>(
      `${BATTLE_SELECT}
        WHERE b.status IN ('FINISHED', 'DECLINED', 'CANCELLED', 'EXPIRED')
        ORDER BY b.invited_at DESC LIMIT 20`,
    ),
  ]);
  return {
    settings,
    live: await Promise.all(liveRows.map(withScores)),
    recent: await Promise.all(recentRows.map(withScores)),
  };
}

/** Ends a running battle early, freezing the score as it stands. */
export async function stopBattle(adminId: string, battleId: string): Promise<PkBattleDto> {
  const stopped = await settleBattle(battleId, { stoppedBy: adminId });
  if (!stopped) throw ApiError.conflict('That battle is not running', 'pk_not_active');
  return stopped;
}
