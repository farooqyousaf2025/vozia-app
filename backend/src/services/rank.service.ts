import { PoolClient } from 'pg';
import { many, one, query } from '../config/db';
import { RankLevelRow } from '../types/db';
import { ApiError, requireBoolean, requireInt, requireString } from '../utils/http';

/**
 * The earned-level ladder: experience a member accumulated, and the rung that turns it into a
 * name, a badge and a colour.
 *
 * `users.vip_level` (an operator-set spend tier that gates gift purchases) is a different thing
 * and stays that way — see the head of migration 0017. This file answers the brief's "user
 * experience and levels": a number nobody moved by hand, and a ladder an operator owns.
 *
 * Three rules shape the file:
 *
 * 1. **Experience only moves on server-side writes.** `awardXp()` is called from inside the gift
 *    transaction in `ledger.service.ts`; there is no route that accepts an XP value from a client,
 *    so a modified app cannot hand itself a Legend badge.
 * 2. **A phone receives URLs and names, never a derivation.** Clients get `rank.badge` as
 *    published art (`/badges/level-7.png` today, `/uploads/<uuid>.png` after an operator uploads
 *    their own). A client that built the path from the level number would 404 on custom art, which
 *    is why `rankFor()` resolves everything here and `utils/serialize.ts` embeds the result.
 * 3. **The ladder stays a ladder.** Rungs are strictly ascending in XP, the floor rung (level 0,
 *    0 XP) cannot be deleted or moved, and a retired rung leaves its members on the nearest live
 *    rung below rather than badge-less. All of that is enforced on the write, not assumed.
 *
 * The snapshot is read into memory the way `theme.service.ts` does it, because `toUser()` runs on
 * every profile, seat and ranking DTO and is synchronous.
 */

export const MAX_LEVEL = 20;
/** 1 XP per diamond spent on a gift — the sender's side of the ladder. */
export const XP_PER_DIAMOND_SPENT = 1;
/** 1 XP per 2 R-coins a host earned, so receiving ranks slower per coin than spending. */
export const XP_PER_RCOIN_EARNED_DIVISOR = 2;

const URL_PATTERN = /^(\/|https:\/\/)/;
const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;
const REFRESH_AFTER_MS = 30_000;

/** What a member's device is told about their rung. */
export type RankDto = { level: number; name: string; badge: string; accent: string };

/** The published ladder rung (`GET /api/ranks`): the DTO plus the threshold it unlocks at. */
export type RankLadderRung = RankDto & { minXp: number };

type Snapshot = {
  /** Live rungs, ascending by level. Never empty — boot refuses a ladder with none. */
  rungs: RankLadderRung[];
  loadedAt: number;
};

let snapshot: Snapshot | null = null;
let loading: Promise<void> | null = null;

const asNumber = (value: string | number): number => Number(value);

function toRung(row: RankLevelRow): RankLadderRung {
  return {
    level: row.level,
    name: row.name,
    badge: row.badge_url,
    accent: row.accent.trim(),
    minXp: asNumber(row.min_xp),
  };
}

async function fetchSnapshot(): Promise<Snapshot> {
  const rows = await many<RankLevelRow>('SELECT * FROM rank_levels ORDER BY level ASC');
  if (rows.length === 0) {
    throw new Error(
      'rank_levels is empty, but every account needs a level 0 rung to resolve to. ' +
        'Run npm run db:migrate, or add a rank from the admin panel.',
    );
  }
  return { rungs: rows.filter((row) => row.is_active).map(toRung), loadedAt: Date.now() };
}

export async function loadRankRegistry(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    snapshot = await fetchSnapshot();
  })().finally(() => {
    loading = null;
  });
  return loading;
}

function current(): Snapshot {
  if (!snapshot) {
    throw new ApiError(503, 'Rank ladder is not loaded yet', 'rank_registry_loading');
  }
  if (Date.now() - snapshot.loadedAt > REFRESH_AFTER_MS) {
    void loadRankRegistry().catch((err) => console.warn('[voiza] rank ladder refresh failed:', err.message));
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Resolution (what every user DTO is built from)
// ---------------------------------------------------------------------------

/**
 * The rung an experience total sits on: the highest live rung whose floor the member has reached.
 * Level 0 is seeded at 0 XP, so this always answers — including for a retired rung's members, who
 * land on the nearest live rung below the one they had.
 */
export function rankFor(xp: number): RankLadderRung {
  const rungs = current().rungs;
  const held = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0));
  let match = rungs[0];
  for (const rung of rungs) {
    if (rung.minXp <= held) match = rung;
    else break;
  }
  return match;
}

/** The next rung up and how much more experience it takes, or null at the top of the ladder. */
export function nextRankFor(xp: number): (RankLadderRung & { remainingXp: number }) | null {
  const held = Math.max(0, Math.floor(xp));
  const above = current().rungs.find((rung) => rung.minXp > held);
  return above ? { ...above, remainingXp: above.minXp - held } : null;
}

/** The published ladder. `GET /api/ranks` — retired rungs are not offered to a client. */
export function rankLadder(): { maxLevel: number; xpRules: { perDiamondSpent: number; perRCoinEarned: number }; levels: RankLadderRung[] } {
  const rungs = current().rungs;
  return {
    maxLevel: rungs[rungs.length - 1]?.level ?? 0,
    // Published rather than hidden, so a member can see how the number they are climbing was built.
    xpRules: { perDiamondSpent: XP_PER_DIAMOND_SPENT, perRCoinEarned: 1 / XP_PER_RCOIN_EARNED_DIVISOR },
    levels: rungs,
  };
}

/**
 * Experience a member gains from one gift. Each side of the same gift is credited to its own
 * account: what the sender spent, and what the receiver earned at a slower rate, so hosting
 * somebody's gift counts as activity without out-earning the person who paid for it.
 */
export function xpForSpend(diamondsSpent: number): number {
  return Math.max(0, Math.floor(diamondsSpent)) * XP_PER_DIAMOND_SPENT;
}

export function xpForEarning(rCoinsEarned: number): number {
  return Math.floor(Math.max(0, Math.floor(rCoinsEarned)) / XP_PER_RCOIN_EARNED_DIVISOR);
}

/**
 * Move a member's experience inside the caller's transaction, so a gift that rolls back cannot
 * leave a rank behind. Never `SET xp = <literal>`: an increment keeps concurrent gifts additive.
 */
export async function awardXp(client: PoolClient, userId: string, amount: number): Promise<void> {
  if (!Number.isFinite(amount) || amount <= 0) return;
  await client.query('UPDATE users SET xp = xp + $2, updated_at = now() WHERE id = $1', [userId, Math.floor(amount)]);
}

/** Same increment, for the callers that are not already inside a transaction. */
export async function awardXpOutside(userId: string, amount: number): Promise<void> {
  if (!Number.isFinite(amount) || amount <= 0) return;
  await query('UPDATE users SET xp = xp + $2, updated_at = now() WHERE id = $1', [userId, Math.floor(amount)]);
}

// ---------------------------------------------------------------------------
// Admin reads and writes
// ---------------------------------------------------------------------------

export type AdminRankRow = RankLadderRung & {
  isActive: boolean;
  /** Accounts currently resolving to this rung — what a delete or a move would shift. */
  membersOnRung: number;
};

/**
 * How many accounts sit on each rung, in one pass. The LATERAL repeats `rankFor()`'s rule — the
 * highest live floor the member reached — so the count on the operator's screen cannot disagree
 * with the badge a phone shows.
 */
async function membersPerRung(): Promise<Map<number, number>> {
  const rows = await many<{ level: number; n: string }>(
    `SELECT matched.level, count(*)::text AS n
       FROM users u
      CROSS JOIN LATERAL (
        SELECT r.level
          FROM rank_levels r
         WHERE r.is_active AND r.min_xp <= u.xp
         ORDER BY r.min_xp DESC, r.level DESC
         LIMIT 1
      ) matched
      GROUP BY matched.level`,
  );
  return new Map(rows.map((row) => [row.level, Number(row.n)]));
}

export async function listAdminRanks(): Promise<{ levels: AdminRankRow[] }> {
  const [rows, counts] = await Promise.all([
    many<RankLevelRow>('SELECT * FROM rank_levels ORDER BY level ASC'),
    membersPerRung(),
  ]);
  return {
    levels: rows.map((row) => ({
      ...toRung(row),
      isActive: row.is_active,
      membersOnRung: counts.get(row.level) ?? 0,
    })),
  };
}

type RankChanges = { level?: number; name?: string; badgeUrl?: string; accent?: string; minXp?: number; isActive?: boolean };

function readRankBody(body: Record<string, unknown>): RankChanges {
  const changes: RankChanges = {};
  if (body.level !== undefined) {
    changes.level = requireInt(body.level, 'level', { min: 0, max: MAX_LEVEL });
  }
  if (body.name !== undefined) changes.name = requireString(body.name, 'name', { min: 1, max: 60 });
  if (body.badgeUrl !== undefined) {
    const url = requireString(body.badgeUrl, 'badgeUrl', { min: 2, max: 512 });
    if (!URL_PATTERN.test(url)) {
      throw ApiError.badRequest('badgeUrl must be a path on this API (/-relative) or an https link', 'rank_url_invalid');
    }
    changes.badgeUrl = url;
  }
  if (body.accent !== undefined) {
    const accent = requireString(body.accent, 'accent', { max: 32 });
    if (!ACCENT_PATTERN.test(accent)) {
      throw ApiError.badRequest('accent must be a hex colour like #d9a53c', 'rank_accent_invalid');
    }
    changes.accent = accent;
  }
  if (body.minXp !== undefined) {
    changes.minXp = requireInt(body.minXp, 'minXp', { min: 0, max: 1_000_000_000 });
  }
  if (body.isActive !== undefined) changes.isActive = requireBoolean(body.isActive, 'isActive');
  return changes;
}

/**
 * Refuse a threshold that would put a rung at or below the live rung under it, or above the one
 * over it. Without this, two rungs could share a floor and `rankFor()` — which takes the highest
 * rung reached — would make the lower one unreachable, which is exactly the kind of ladder an
 * operator cannot debug from a phone.
 */
async function assertOrder(level: number, minXp: number): Promise<void> {
  const rows = await many<RankLevelRow>('SELECT * FROM rank_levels ORDER BY level ASC');
  const below = rows.filter((row) => row.level < level && row.is_active).at(-1);
  const above = rows.find((row) => row.level > level && row.is_active);
  if (below && minXp <= asNumber(below.min_xp)) {
    throw ApiError.conflict(
      `Level ${level} needs more experience than level ${below.level} (${below.name}), which is at ${asNumber(below.min_xp)} — otherwise nobody can ever be shown level ${below.level}`,
      'rank_xp_order',
    );
  }
  if (above && minXp >= asNumber(above.min_xp)) {
    throw ApiError.conflict(
      `Level ${level} would reach ${minXp} XP, which is level ${above.name}'s floor at ${asNumber(above.min_xp)} — lower it, or move level ${above.level} first`,
      'rank_xp_order',
    );
  }
}

async function afterWrite(level: number): Promise<AdminRankRow> {
  const row = await one<RankLevelRow>('SELECT * FROM rank_levels WHERE level = $1', [level]);
  if (!row) throw new Error(`rank level ${level} vanished after being written`);
  const counts = await membersPerRung();
  return { ...toRung(row), isActive: row.is_active, membersOnRung: counts.get(row.level) ?? 0 };
}

export async function createRank(body: Record<string, unknown>): Promise<AdminRankRow> {
  const input = readRankBody(body ?? {});
  const missing = (['level', 'name', 'badgeUrl', 'accent'] as const).filter((field) => !input[field] && input[field] !== 0);
  if (missing.length > 0) throw ApiError.badRequest(`${missing.join(', ')} required`, 'rank_fields_missing');
  const complete = {
    level: input.level as number,
    name: input.name as string,
    badgeUrl: input.badgeUrl as string,
    accent: input.accent as string,
    minXp: input.minXp ?? 0,
    isActive: input.isActive ?? true,
  };
  if (await one<RankLevelRow>('SELECT level FROM rank_levels WHERE level = $1', [complete.level])) {
    throw ApiError.conflict(`Level ${complete.level} already exists on the ladder`, 'rank_exists');
  }
  await assertOrder(complete.level, complete.minXp);
  await query(
    `INSERT INTO rank_levels (level, name, badge_url, accent, min_xp, is_active)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [complete.level, complete.name, complete.badgeUrl, complete.accent, complete.minXp, complete.isActive],
  );
  await loadRankRegistry();
  return afterWrite(complete.level);
}

export async function updateRank(level: number, body: Record<string, unknown>): Promise<AdminRankRow> {
  const changes = readRankBody(body ?? {});
  const existing = await one<RankLevelRow>('SELECT * FROM rank_levels WHERE level = $1', [level]);
  if (!existing) throw ApiError.notFound('Rank level not found');
  if (changes.level !== undefined && changes.level !== level) {
    throw ApiError.badRequest(
      'level is an identity, not a label — it is the rung accounts sit on. Add the new level and delete this one instead',
      'rank_level_immutable',
    );
  }
  const nextMinXp = changes.minXp ?? asNumber(existing.min_xp);
  if (level === 0 && nextMinXp !== 0) {
    throw ApiError.badRequest(
      'Level 0 is the floor every account stands on, so it costs no experience. Move the rungs above it instead',
      'rank_floor_immutable',
    );
  }
  if (changes.minXp !== undefined || changes.isActive !== undefined) await assertOrder(level, nextMinXp);
  await query(
    `UPDATE rank_levels SET name = $2, badge_url = $3, accent = $4, min_xp = $5, is_active = $6, updated_at = now()
      WHERE level = $1`,
    [level, changes.name ?? existing.name, changes.badgeUrl ?? existing.badge_url, changes.accent ?? existing.accent, nextMinXp, changes.isActive ?? existing.is_active],
  );
  await loadRankRegistry();
  return afterWrite(level);
}

export async function deleteRank(level: number): Promise<{ ok: true; level: string; membersMoved: number }> {
  const existing = await one<RankLevelRow>('SELECT * FROM rank_levels WHERE level = $1', [level]);
  if (!existing) throw ApiError.notFound('Rank level not found');
  if (level === 0) {
    throw ApiError.conflict(
      'Level 0 is the floor — retire it instead of deleting it, and even then accounts need a rung to resolve to',
      'rank_floor',
    );
  }
  const remaining = await one<{ n: string }>('SELECT count(*)::text n FROM rank_levels WHERE is_active AND level <> $1', [level]);
  if (Number(remaining?.n ?? 0) === 0) {
    throw ApiError.conflict('This is the last live rung on the ladder', 'rank_last');
  }
  const members = await membersPerRung();
  await query('DELETE FROM rank_levels WHERE level = $1', [level]);
  await loadRankRegistry();
  // Accounts keep their XP. They re-resolve to the nearest live rung below, which is why deleting a
  // threshold needs no rewrite of the users table — and why `membersMoved` is reported, not hidden.
  return { ok: true, level: String(level), membersMoved: members.get(level) ?? 0 };
}
