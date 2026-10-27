import { PoolClient } from 'pg';
import { GameDefinitionRow, GameParticipantRow, GameSessionRow, PinnedGameRules } from '../types/db';
import { ApiError } from '../utils/http';
import { GameStandings } from '../games/types';
import { PostedGameMove, postGameMoves } from './ledger.service';

/**
 * Game money: fee accounting, the prize ladder, and the one place a session is allowed to
 * pay anybody out.
 *
 * `settleSession` is idempotent by construction, not by convention — `game_settlements`
 * is keyed on the session id, so the second caller of a match gets `settled: false` and
 * moves no money even if two timeout sweeps and two clients all decide the game ended at
 * the same instant. That is the only honest way to make "each session settles at most
 * once" true under concurrency.
 */

const BPS = 10_000;

/** Read the definition's money fields into the shape a session pins and settlement reads. */
export function pinRules(definition: GameDefinitionRow): PinnedGameRules {
  const raw = Array.isArray(definition.prize_rules) ? definition.prize_rules : [];
  const prizeRules = raw
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const rank = Number(record.rank);
      const shareBps = Number(record.shareBps ?? record.share_bps);
      return Number.isInteger(rank) && rank >= 1 && Number.isInteger(shareBps) && shareBps >= 0 ? { rank, shareBps } : null;
    })
    .filter((entry): entry is { rank: number; shareBps: number } => entry !== null)
    .sort((a, b) => a.rank - b.rank);

  const total = prizeRules.reduce((sum, rule) => sum + rule.shareBps, 0);
  if (total > BPS) throw ApiError.conflict('Prize rules hand out more than the pool', 'bad_prize_rules');

  return {
    entryFeeEnabled: definition.entry_fee_enabled,
    entryFeeDiamonds: definition.entry_fee_diamonds,
    prizeEnabled: definition.prize_enabled,
    commissionBps: definition.commission_bps,
    prizeRules: prizeRules.length ? prizeRules : [{ rank: 1, shareBps: BPS }],
    refundPolicy: definition.refund_policy,
    minPlayers: definition.min_players,
    maxPlayers: definition.max_players,
    turnTimeoutSeconds: definition.turn_timeout_seconds,
    dailyEntryLimit: definition.daily_entry_limit,
    config: definition.config,
    rulesVersion: definition.rules_version,
  };
}

/**
 * Split the prize pool across the ranks the rules pay.
 *
 * Rounding is floor-for-everyone-but-the-first: the leading rank absorbs the cents the
 * floors drop, and only when the configured shares add up to a full 100%. Two players
 * splitting 101 diamonds therefore get 51 and 50 in a fixed order, never 50/50 with one
 * diamond evaporating and never 51/51 with one appearing.
 */
export function prizeLadder(prizePool: number, rules: PinnedGameRules, ranks: number): number[] {
  if (prizePool <= 0) return [];
  const ladder = rules.prizeRules.filter((rule) => rule.rank <= Math.max(ranks, 1));
  if (!ladder.length) return [];
  const shareTotal = rules.prizeRules.reduce((sum, rule) => sum + rule.shareBps, 0);
  const paysAll = shareTotal >= BPS;

  const amounts = ladder.map((rule) => Math.floor((prizePool * rule.shareBps) / BPS));
  const handed = amounts.reduce((sum, n) => sum + n, 0);
  if (paysAll) amounts[0] += prizePool - handed;

  return amounts.map((n) => Math.max(0, Math.min(n, prizePool))).slice(0, ladder.length);
}

export type SettlementOutcome = {
  settled: boolean;
  grossPool: number;
  commission: number;
  prizePool: number;
  deductions: number;
  distributed: number;
  payouts: Array<{ rank: number; userId: string; diamonds: number; transactionId: string | null }>;
  moves: PostedGameMove[];
};

/**
 * Close a finished match: keep the platform's cut, pay the ladder, record everything.
 *
 * Runs on the caller's transaction, which is the transaction that also flips the session
 * row, so a crash leaves either a fully settled game or none at all.
 */
export async function settleSession(
  client: PoolClient,
  input: { session: GameSessionRow; participants: GameParticipantRow[]; standings: GameStandings },
): Promise<SettlementOutcome> {
  const { session, participants, standings } = input;
  const rules = session.rules;
  const paid = participants.filter((p) => p.fee_transaction_id !== null);
  const grossPool = paid.reduce((sum, p) => sum + p.entry_fee_diamonds, 0);
  const commission = Math.floor((grossPool * rules.commissionBps) / BPS);
  const prizeEnabled = rules.prizeEnabled && grossPool > 0;
  const prizePool = prizeEnabled ? grossPool - commission : 0;
  const deductions = grossPool - commission - prizePool;

  const empty: SettlementOutcome = {
    settled: false,
    grossPool,
    commission,
    prizePool,
    deductions,
    distributed: 0,
    payouts: [],
    moves: [],
  };

  // The PK is the guard. `ON CONFLICT DO NOTHING` returning no row means somebody else
  // already settled this session inside their own transaction.
  const inserted = await client.query<{ session_id: string }>(
    `INSERT INTO game_settlements (session_id, game_key, rules_version, player_count, gross_pool, commission,
                                  prize_pool, deductions, distributed, payouts, refunds, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'[]'::jsonb,'[]'::jsonb,'SETTLED')
     ON CONFLICT (session_id) DO NOTHING
     RETURNING session_id`,
    [session.id, session.game_key, session.rules_version, participants.length, grossPool, commission, prizePool, deductions],
  );
  if (!inserted.rows.length) return empty;

  const amounts = prizeLadder(prizePool, rules, standings.length);
  const payouts: SettlementOutcome['payouts'] = [];
  const moves: PostedGameMove[] = [];

  const prizeMoves = standings
    .map((row, index) => ({ userId: row.userId, rank: index + 1, diamonds: amounts[index] ?? 0 }))
    .filter((entry) => entry.diamonds > 0)
    .map((entry) => ({
      type: 'GAME_PRIZE' as const,
      userId: entry.userId,
      diamonds: entry.diamonds,
      sessionId: session.id,
      roomId: session.room_id,
      note: `${session.game_key} prize, rank ${entry.rank}`.slice(0, 200),
    }));
  if (prizeMoves.length) moves.push(...(await postGameMoves(client, prizeMoves)));

  for (const [index, row] of standings.entries()) {
    const diamonds = amounts[index] ?? 0;
    const rank = index + 1;
    const transaction = moves.find((m) => m.type === 'GAME_PRIZE' && m.userId === row.userId);
    await client.query(
      `UPDATE game_participants
          SET score = $3, tie_break_ms = $4, rank = $5, prize_diamonds = $6, status = 'COMPLETED'
        WHERE session_id = $1 AND user_id = $2`,
      [session.id, row.userId, row.score, row.tieBreakMs, rank, diamonds],
    );
    if (diamonds > 0) payouts.push({ rank, userId: row.userId, diamonds, transactionId: transaction?.transactionId ?? null });
  }

  if (commission > 0) {
    // The cut is booked, not banked: it belongs to the platform, so it moves no wallet and
    // exists so a reconciliation report can prove where every diamond of the pool went.
    const [recorded] = await postGameMoves(client, [
      {
        type: 'PLATFORM_COMMISSION',
        diamonds: commission,
        sessionId: session.id,
        roomId: session.room_id,
        note: `${session.game_key} platform commission ${rules.commissionBps} bps`,
      },
    ]);
    if (recorded) moves.push(recorded);

    // One row per source, versioned with the rules that produced it. The UNIQUE
    // (kind, source_id) key is what makes "do not pay twice for the same pool" a fact the
    // database holds rather than a promise the service makes.
    await client.query(
      `INSERT INTO commission_allocations (kind, source_id, gross_amount, currency, host_user_id, host_share,
                                          agency_id, agency_share, platform_share, rules_version, rule_snapshot,
                                          status, transaction_ids)
       VALUES ('GAME_SESSION',$1,$2,'diamond',NULL,0,NULL,0,$3,$4,$5::jsonb,'SETTLED',$6::jsonb)
       ON CONFLICT (kind, source_id) DO NOTHING`,
      [
        session.id,
        grossPool,
        commission,
        session.rules_version,
        JSON.stringify(rules),
        JSON.stringify(recorded ? [recorded.transactionId] : []),
      ],
    );
  }

  const distributed = payouts.reduce((sum, p) => sum + p.diamonds, 0);
  await client.query(
    `UPDATE game_settlements SET distributed = $2, payouts = $3::jsonb WHERE session_id = $1`,
    [session.id, distributed, JSON.stringify(payouts)],
  );
  await client.query(
    `UPDATE game_sessions
        SET status = 'COMPLETED', settlement_status = 'SETTLED', ended_at = now(),
            result = $2::jsonb, turn_owner_id = NULL, turn_deadline_at = NULL
      WHERE id = $1`,
    [
      session.id,
      JSON.stringify({
        grossPool,
        commission,
        prizePool,
        deductions,
        distributed,
        rulesVersion: session.rules_version,
        standings: standings.map((row, index) => ({ rank: index + 1, ...row })),
      }),
    ],
  );

  return { ...empty, settled: true, distributed, payouts, moves };
}

/**
 * Give every collected fee back, for the exits the rules say are refundable.
 *
 * A refund is a new GAME_REFUND row beside the GAME_ENTRY it reverses; the entry row is
 * never edited or deleted, because a posted ledger is history, not a draft.
 */
export async function refundFees(
  client: PoolClient,
  input: { session: GameSessionRow; participants: GameParticipantRow[]; reason: string },
): Promise<{ refunded: number; refunds: Array<{ userId: string; diamonds: number; transactionId: string }> }> {
  const { session, participants, reason } = input;
  const owed = participants.filter((p) => p.fee_transaction_id !== null && p.refund_transaction_id === null && p.entry_fee_diamonds > 0);
  if (!owed.length) return { refunded: 0, refunds: [] };

  const moves = await postGameMoves(
    client,
    owed.map((p) => ({
      type: 'GAME_REFUND' as const,
      userId: p.user_id,
      diamonds: p.entry_fee_diamonds,
      sessionId: session.id,
      roomId: session.room_id,
      note: reason.slice(0, 200),
    })),
  );

  const refunds: Array<{ userId: string; diamonds: number; transactionId: string }> = [];
  for (const move of moves) {
    if (!move.userId) continue;
    refunds.push({ userId: move.userId, diamonds: move.diamonds, transactionId: move.transactionId });
    await client.query(
      `UPDATE game_participants SET refund_transaction_id = $3, entry_fee_diamonds = 0
        WHERE session_id = $1 AND user_id = $2`,
      [session.id, move.userId, move.transactionId],
    );
  }

  await client.query(
    `UPDATE game_sessions SET settlement_status = 'REFUNDED' WHERE id = $1`,
    [session.id],
  );
  return { refunded: refunds.reduce((sum, r) => sum + r.diamonds, 0), refunds };
}
