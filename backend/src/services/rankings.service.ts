import { PoolClient } from 'pg';
import { many, one, withTransaction } from '../config/db';
import { ApiError } from '../utils/http';
import { iso } from '../utils/serialize';
import { readConfig } from './business.service';
import { announceBonusChange } from './earning.service';
import { grantPromoDiamonds, PromoGrantDto } from './promo-diamond.service';
import { excludeTestSql } from './qa.service';
import { rankFor, RankDto } from './rank.service';

/**
 * The landing boards: who earned, who spent, who gave.
 *
 * Three rules shape this file:
 *
 * 1. **Live board, settled reward.** The default view is the window in progress (today, this
 *    ISO week, this calendar month, all UTC); `settled` switches to the finished one before it
 *    (yesterday, last week, last month). A reward is only ever computed and paid from a settled
 *    window, so the podium a claim is priced against cannot move under a retry. The in-room gift
 *    sheet keeps its own rolling windows (`GET /api/users/top`).
 * 2. **The ledger is the only source.** Every score is a SUM over `transactions`, with the
 *    same QA exclusion the rolling boards use: a marked account never appears, and its gifts
 *    never place anyone else. Nothing here reads a counter a client could have written.
 * 3. **A reward is a claim, not a cron.** The top places of a finished window are recomputed
 *    at claim time and paid once through the promotional rail — journalised, expiring, never
 *    withdrawable. The unique key on (user, board, period) is the idempotency guard, so a
 *    double tap answers with the first claim instead of minting twice.
 */

export const RANKING_BOARDS = ['host', 'rich', 'gifter'] as const;
export type RankingBoard = (typeof RANKING_BOARDS)[number];
export const RANKING_PERIODS = ['day', 'week', 'month'] as const;
export type RankingPeriod = (typeof RANKING_PERIODS)[number];

/** What one board counts, and which side of the ledger row it counts it on. */
const BOARDS = {
  host: {
    column: 't.receiver_id',
    sum: 'COALESCE(SUM(t.amount_r_coins), 0)',
    types: ['GIFT_SENT'],
    unit: 'r_coin',
  },
  gifter: {
    column: 't.sender_id',
    sum: 'COALESCE(SUM(t.amount_diamonds), 0)',
    types: ['GIFT_SENT'],
    unit: 'diamond',
  },
  // Wealth is everything the member spent, not only gifts: a store purchase or a game entry
  // is consumption too. A refunded entry leaves the pocket again, so it subtracts.
  rich: {
    column: 't.sender_id',
    sum: "COALESCE(SUM(CASE WHEN t.type = 'GAME_REFUND' THEN -t.amount_diamonds ELSE t.amount_diamonds END), 0)",
    types: ['GIFT_SENT', 'ITEM_PURCHASE', 'GAME_ENTRY', 'GAME_REFUND'],
    unit: 'diamond',
  },
} as const;

export const RANKING_LIMIT = 50;

export type RankingWindow = { period: RankingPeriod; key: string; label: string; from: Date; to: Date };

const DAY_MS = 86_400_000;
const dateKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The finished window a period name stands for, in UTC so every phone agrees on "yesterday". */
export function settledWindow(period: RankingPeriod, now: Date = new Date()): RankingWindow {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (period === 'day') {
    return { period, key: `day:${dateKey(today - DAY_MS)}`, label: 'Yesterday', from: new Date(today - DAY_MS), to: new Date(today) };
  }
  if (period === 'week') {
    const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY_MS;
    return { period, key: `week:${dateKey(monday - 7 * DAY_MS)}`, label: 'Last week', from: new Date(monday - 7 * DAY_MS), to: new Date(monday) };
  }
  const firstOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const firstOfPrev = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  return { period, key: `month:${dateKey(firstOfPrev).slice(0, 7)}`, label: 'Last month', from: new Date(firstOfPrev), to: new Date(firstOfMonth) };
}

/** The window still in progress — the live board a member watches move during the day. */
export function currentWindow(period: RankingPeriod, now: Date = new Date()): RankingWindow {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (period === 'day') {
    return { period, key: `day:${dateKey(today)}`, label: 'Today', from: new Date(today), to: new Date(today + DAY_MS) };
  }
  if (period === 'week') {
    const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY_MS;
    return { period, key: `week:${dateKey(monday)}`, label: 'This week', from: new Date(monday), to: new Date(monday + 7 * DAY_MS) };
  }
  const firstOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const firstOfNext = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { period, key: `month:${dateKey(firstOfMonth).slice(0, 7)}`, label: 'This month', from: new Date(firstOfMonth), to: new Date(firstOfNext) };
}

const BOARD_NAMES: Record<RankingBoard, string> = { host: 'Host', rich: 'Rich', gifter: 'Gifter' };

/** Member-facing window phrase for grant reasons — the period key itself never reaches a user. */
function humanWindow(w: RankingWindow): string {
  const day = (d: Date) => d.getUTCDate();
  const mon = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  const last = new Date(w.to.getTime() - DAY_MS);
  if (w.period === 'day') return `${w.label} (${day(last)} ${mon(last)} ${last.getUTCFullYear()})`;
  if (w.period === 'month') return `${w.label} (${mon(w.from)} ${w.from.getUTCFullYear()})`;
  const fromPart = mon(w.from) === mon(last) ? `${day(w.from)}` : `${day(w.from)} ${mon(w.from)}`;
  return `${w.label} (${fromPart}–${day(last)} ${mon(last)} ${last.getUTCFullYear()})`;
}

export type RankingLeader = {
  position: number;
  id: string;
  username: string;
  avatarUrl: string | null;
  userType: string;
  isVerified: boolean;
  rank: RankDto;
  earned: number;
};

export type RankingSelf = { position: number | null; earned: number };

export type RankingReward = {
  periodKey: string;
  position: number;
  amount: number;
  claimed: boolean;
  claimable: boolean;
};

export type RankingBoardDto = {
  board: RankingBoard;
  period: RankingPeriod;
  settled: boolean;
  window: { key: string; label: string; from: string; to: string };
  unit: string;
  leaders: RankingLeader[];
  self: RankingSelf | null;
  reward: RankingReward | null;
};

type BoardSql = { column: string; sum: string; typeList: string };

function boardSql(board: RankingBoard): BoardSql {
  const b = BOARDS[board];
  // Types and columns are literals from the map above, never request input.
  return { column: b.column, sum: b.sum, typeList: b.types.map((t) => `'${t}'`).join(', ') };
}

const QA_FILTER = `NOT u.is_test AND ${excludeTestSql('t', ['sender_id', 'receiver_id', 'agency_id'])}`;

async function leaders(board: RankingBoard, window: RankingWindow, limit: number): Promise<RankingLeader[]> {
  const { column, sum, typeList } = boardSql(board);
  const rows = await many<{
    id: string;
    username: string;
    avatar_url: string | null;
    user_type: string;
    is_verified: boolean;
    xp: string | number;
    earned: string;
  }>(
    `SELECT u.id, u.username, u.avatar_url, u.user_type, u.is_verified, u.xp, ${sum} AS earned
       FROM transactions t
       JOIN users u ON u.id = ${column}
      WHERE t.type IN (${typeList}) AND t.created_at >= $1 AND t.created_at < $2
        AND ${QA_FILTER}
      GROUP BY u.id, u.username, u.avatar_url, u.user_type, u.is_verified, u.xp, u.created_at
     HAVING ${sum} > 0
      ORDER BY earned DESC, u.created_at ASC, u.id ASC
      LIMIT $3`,
    [window.from, window.to, limit],
  );
  return rows.map((row, index) => ({
    position: index + 1,
    id: row.id,
    username: row.username,
    avatarUrl: row.avatar_url,
    userType: row.user_type,
    isVerified: row.is_verified,
    rank: rankFor(Number(row.xp)),
    earned: Number(row.earned),
  }));
}

/**
 * The caller's standing uses the same score and deterministic tie-breakers as the public board.
 * A marked account has no standing at all — the exclusion that keeps it off the public list
 * also keeps it off the podium a reward is paid from.
 */
async function standing(
  client: PoolClient | null,
  userId: string,
  board: RankingBoard,
  window: RankingWindow,
): Promise<{ eligible: boolean; earned: number; position: number | null }> {
  const run = async (tx: PoolClient) => {
    const eligibility = await tx.query<{ eligible: boolean }>(
      `SELECT NOT u.is_test AND ${excludeTestSql('u', ['id'])} AS eligible FROM users u WHERE u.id = $1`,
      [userId],
    );
    if (!eligibility.rows[0]?.eligible) return { eligible: false, earned: 0, position: null };
    const { column, sum, typeList } = boardSql(board);
    const row = await tx.query<{ earned: string | null; position: string | null }>(
      `WITH board AS (
         SELECT u.id, ${sum} AS earned
           FROM transactions t
           JOIN users u ON u.id = ${column}
          WHERE t.type IN (${typeList}) AND t.created_at >= $1 AND t.created_at < $2
            AND ${QA_FILTER}
          GROUP BY u.id
         HAVING ${sum} > 0
       ), ranked AS (
         SELECT b.id, b.earned,
                ROW_NUMBER() OVER (ORDER BY b.earned DESC, u.created_at ASC, u.id ASC) AS position
           FROM board b JOIN users u ON u.id = b.id
       )
       SELECT earned, position FROM ranked WHERE id = $3`,
      [window.from, window.to, userId],
    );
    const earned = row.rows[0]?.earned;
    return {
      eligible: true,
      earned: Number(earned ?? 0),
      position: earned == null ? null : Number(row.rows[0].position),
    };
  };
  return client ? run(client) : withTransaction(run);
}

export type RankingRewardPlace = { position: number; amount: number };

const DEFAULT_REWARDS: RankingRewardPlace[] = [
  { position: 1, amount: 500 },
  { position: 2, amount: 300 },
  { position: 3, amount: 200 },
];

/**
 * The operator's podium dial (`rankings.rewards`). Stored JSON is not trusted: places must be
 * a contiguous 1..n ladder of positive whole amounts within the mint bound, so a half-written
 * config row pays the prefix it can prove rather than a hole at position 2.
 */
export async function rankingRewards(): Promise<RankingRewardPlace[]> {
  const cfg = await readConfig<{ rewards?: unknown }>('rankings.rewards', { rewards: DEFAULT_REWARDS });
  const raw = Array.isArray(cfg.rewards) ? cfg.rewards : [];
  const byPlace = new Map<number, number>();
  for (const entry of raw) {
    const place = Number((entry as RankingRewardPlace)?.position);
    const amount = Number((entry as RankingRewardPlace)?.amount);
    if (!Number.isInteger(place) || place < 1 || place > 10) continue;
    if (!Number.isInteger(amount) || amount <= 0 || amount > 10_000_000) continue;
    byPlace.set(place, amount);
  }
  const ladder: RankingRewardPlace[] = [];
  for (let place = 1; byPlace.has(place); place += 1) ladder.push({ position: place, amount: byPlace.get(place)! });
  return ladder.length ? ladder : DEFAULT_REWARDS;
}

export async function rankingBoard(
  userId: string | null,
  board: RankingBoard,
  period: RankingPeriod,
  settled = false,
): Promise<RankingBoardDto> {
  const window = settled ? settledWindow(period) : currentWindow(period);
  const rows = await leaders(board, window, RANKING_LIMIT);
  let self: RankingSelf | null = null;
  let reward: RankingReward | null = null;
  if (userId) {
    const mine = await standing(null, userId, board, window);
    if (mine.eligible) {
      self = { position: mine.position, earned: mine.earned };
      // The gift-box reward always reads the finished window, even while the live board is on
      // screen: a claim is priced against a result that can no longer move.
      const finished = settled ? mine : await standing(null, userId, board, settledWindow(period));
      const finishedKey = settled ? window.key : settledWindow(period).key;
      const claim = await one<{ position: number; amount: number }>(
        'SELECT position, amount FROM ranking_reward_claims WHERE user_id = $1 AND board = $2 AND period_key = $3',
        [userId, board, finishedKey],
      );
      if (claim) {
        reward = { periodKey: finishedKey, position: claim.position, amount: claim.amount, claimed: true, claimable: false };
      } else if (finished.position != null) {
        const place = (await rankingRewards()).find((r) => r.position === finished.position);
        if (place) reward = { periodKey: finishedKey, position: place.position, amount: place.amount, claimed: false, claimable: true };
      }
    }
  }
  return {
    board,
    period,
    settled,
    window: { key: window.key, label: window.label, from: iso(window.from), to: iso(window.to) },
    unit: BOARDS[board].unit,
    leaders: rows,
    self,
    reward,
  };
}

export type RankingClaimDto = {
  id: string;
  board: string;
  periodKey: string;
  position: number;
  amount: number;
  grantId: string | null;
  createdAt: string;
};

export async function claimRankingReward(
  userId: string,
  board: RankingBoard,
  period: RankingPeriod,
): Promise<{ claim: RankingClaimDto; grant: PromoGrantDto | null; alreadyClaimed: boolean }> {
  const window = settledWindow(period);
  const rewards = await rankingRewards();

  const result = await withTransaction(async (client) => {
    const mine = await standing(client, userId, board, window);
    if (!mine.eligible) throw ApiError.forbidden('This account does not take part in the rankings', 'qa_excluded');
    const place = mine.position != null ? rewards.find((r) => r.position === mine.position) : undefined;
    if (!place) throw ApiError.badRequest('You are not on this podium yet', 'not_on_podium');

    const inserted = await client.query<{ id: string; position: number; amount: number; grant_id: string | null; created_at: Date }>(
      `INSERT INTO ranking_reward_claims (user_id, board, period_key, position, amount)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, board, period_key) DO NOTHING
       RETURNING id, position, amount, grant_id, created_at`,
      [userId, board, window.key, place.position, place.amount],
    );
    const toDto = (row: { id: string; position: number; amount: number; grant_id: string | null; created_at: Date }): RankingClaimDto => ({
      id: row.id,
      board,
      periodKey: window.key,
      position: row.position,
      amount: row.amount,
      grantId: row.grant_id,
      createdAt: iso(row.created_at),
    });
    if (!inserted.rows[0]) {
      const existing = await client.query<{ id: string; position: number; amount: number; grant_id: string | null; created_at: Date }>(
        'SELECT id, position, amount, grant_id, created_at FROM ranking_reward_claims WHERE user_id = $1 AND board = $2 AND period_key = $3',
        [userId, board, window.key],
      );
      return { claim: toDto(existing.rows[0]), grant: null, alreadyClaimed: true };
    }
    const claim = inserted.rows[0];
    const { grant } = await grantPromoDiamonds(
      {
        userId,
        amount: place.amount,
        sourceKind: 'RANKING',
        sourceId: claim.id,
        reason: `Ranking reward — ${BOARD_NAMES[board]} board, ${humanWindow(window)}, place ${place.position}`,
      },
      client,
    );
    await client.query('UPDATE ranking_reward_claims SET grant_id = $2 WHERE id = $1', [claim.id, grant.id]);
    return { claim: toDto({ ...claim, grant_id: grant.id }), grant, alreadyClaimed: false };
  });

  // Announced after commit, the way every other mint does: the push carries a balance that exists.
  if (!result.alreadyClaimed) await announceBonusChange([userId]);
  return result;
}