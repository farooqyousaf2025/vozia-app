import { PoolClient } from 'pg';
import { many, one, query } from '../config/db';
import { ApiError } from '../utils/http';
import { MiniUser, toMiniUser } from '../utils/serialize';

/**
 * Follows, blocks and reports.
 *
 * All three are edges over `users`, and the service keeps them consistent without a counter
 * column: a follow is one row, a block is one row, and every count is read from the edge table.
 * That is deliberate — a block deletes the follow edges between the pair in the same statement
 * batch, and a counter would have to be repaired by hand when it drifted.
 *
 * Two invariants matter more than the rest:
 *
 *  * A block is read in both directions. The blocker writes one row, but `assertInteractionAllowed`
 *    refuses gifts and `followUser` refuses follows whichever way round the pair is.
 *  * A report is never an automatic ban. Filing one writes a PENDING row; only an operator moves
 *    it, and banning is a separate decision the panel can attach to that review.
 */

export const REPORT_REASONS = ['HARASSMENT', 'SPAM', 'FRAUD', 'UNDERAGE', 'VIOLENCE', 'OTHER'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = ['PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_DECISIONS = ['REVIEWED', 'DISMISSED', 'ACTIONED'] as const;
export type ReportDecision = (typeof REPORT_DECISIONS)[number];

export const MAX_REPORT_DETAILS = 500;
export const MAX_RESOLUTION = 300;
export const MAX_BLOCK_REASON = 200;

export type SocialCounts = {
  followers: number;
  following: number;
  /** Accounts this member has blocked. */
  blocked: number;
  /** Accounts that have blocked this member (never revealed by id, only counted to the owner). */
  blockedBy: number;
};

export type Relationship = {
  following: boolean;
  blockedByMe: boolean;
  blockedByThem: boolean;
  /** Either side blocked: gifts and follows are refused in both directions. */
  interactionBlocked: boolean;
};

export type FollowListEntry = MiniUser & { followedAt: string };
export type BlockedListEntry = FollowListEntry & { blockReason: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUserId(value: unknown, field = 'userId'): string {
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
    throw ApiError.badRequest(`${field} must be a UUID`, 'invalid_uuid');
  }
  return value.trim();
}

export function normalizeReportReason(value: unknown): ReportReason {
  if (typeof value !== 'string' || !(REPORT_REASONS as readonly string[]).includes(value)) {
    throw ApiError.badRequest(`reason must be one of: ${REPORT_REASONS.join(', ')}`, 'report_reason_invalid');
  }
  return value as ReportReason;
}

export function normalizeReportDetails(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw ApiError.badRequest('details must be a string');
  const text = value.trim();
  if (!text) return null;
  if (text.length > MAX_REPORT_DETAILS) {
    throw ApiError.badRequest(`details must be ${MAX_REPORT_DETAILS} characters or fewer`, 'report_details_too_long');
  }
  return text;
}

export function normalizeResolution(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw ApiError.badRequest('resolution must be a string');
  const text = value.trim();
  if (!text) return null;
  if (text.length > MAX_RESOLUTION) {
    throw ApiError.badRequest(`resolution must be ${MAX_RESOLUTION} characters or fewer`, 'resolution_too_long');
  }
  return text;
}

export function normalizeBlockReason(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw ApiError.badRequest('reason must be a string');
  const text = value.trim();
  if (!text) return null;
  if (text.length > MAX_BLOCK_REASON) {
    throw ApiError.badRequest(`reason must be ${MAX_BLOCK_REASON} characters or fewer`, 'block_reason_too_long');
  }
  return text;
}

const iso = (value: Date | string): string => new Date(value).toISOString();

async function userExists(userId: string, client?: PoolClient): Promise<{ id: string; status: string }> {
  const sql = 'SELECT id, status FROM users WHERE id = $1';
  const row = client ? (await client.query<{ id: string; status: string }>(sql, [userId])).rows[0] : await one<{ id: string; status: string }>(sql, [userId]);
  if (!row) throw ApiError.notFound('User not found', 'user_not_found');
  return row;
}

/**
 * Refuses an interaction when either side has blocked the other. `actors` are the two account ids;
 * a gift and a follow both call this before writing anything, so a block cannot be sidestepped by
 * being the first to tap.
 *
 * Exported because the ledger is the other caller: a gift is money, and the check has to run inside
 * the same transaction as the balance locks.
 */
export async function assertInteractionAllowed(aId: string, bId: string, client?: PoolClient): Promise<void> {
  const sql = `
    SELECT 1 FROM user_blocks
     WHERE (blocker_id = $1 AND blocked_id = $2)
        OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`;
  const blocked = client
    ? (await client.query(sql, [aId, bId])).rows.length > 0
    : (await query(sql, [aId, bId])).rows.length > 0;
  if (blocked) {
    throw ApiError.forbidden('You cannot interact with this member', 'interaction_blocked');
  }
}

export async function socialCounts(userId: string): Promise<SocialCounts> {
  const row = await one<{
    followers: string;
    following: string;
    blocked: string;
    blocked_by: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM user_follows WHERE followee_id = $1)::text AS followers,
       (SELECT COUNT(*) FROM user_follows WHERE follower_id = $1)::text AS following,
       (SELECT COUNT(*) FROM user_blocks WHERE blocker_id = $1)::text   AS blocked,
       (SELECT COUNT(*) FROM user_blocks WHERE blocked_id = $1)::text   AS blocked_by`,
    [userId],
  );
  return {
    followers: Number(row?.followers ?? 0),
    following: Number(row?.following ?? 0),
    blocked: Number(row?.blocked ?? 0),
    blockedBy: Number(row?.blocked_by ?? 0),
  };
}

export async function relationship(actorId: string, targetId: string): Promise<Relationship> {
  if (actorId === targetId) {
    return { following: false, blockedByMe: false, blockedByThem: false, interactionBlocked: false };
  }
  const row = await one<{ following: boolean; blocked_by_me: boolean; blocked_by_them: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM user_follows WHERE follower_id = $1 AND followee_id = $2) AS following,
       EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2)  AS blocked_by_me,
       EXISTS (SELECT 1 FROM user_blocks WHERE blocker_id = $2 AND blocked_id = $1)  AS blocked_by_them`,
    [actorId, targetId],
  );
  const blockedByMe = Boolean(row?.blocked_by_me);
  const blockedByThem = Boolean(row?.blocked_by_them);
  return {
    following: Boolean(row?.following),
    blockedByMe,
    blockedByThem,
    interactionBlocked: blockedByMe || blockedByThem,
  };
}

export async function followUser(
  actorId: string,
  targetId: string,
): Promise<{ following: true; counts: SocialCounts; actor: MiniUser }> {
  if (actorId === targetId) throw ApiError.badRequest('You cannot follow yourself', 'self_follow');
  const target = await userExists(targetId);
  if (target.status === 'BANNED') throw ApiError.notFound('User not found', 'user_not_found');
  await assertInteractionAllowed(actorId, targetId);

  await query(
    `INSERT INTO user_follows (follower_id, followee_id) VALUES ($1, $2)
     ON CONFLICT (follower_id, followee_id) DO NOTHING`,
    [actorId, targetId],
  );

  const [counts, actor] = await Promise.all([socialCounts(actorId), userMini(actorId)]);
  return { following: true, counts, actor };
}

export async function unfollowUser(actorId: string, targetId: string): Promise<{ following: false; counts: SocialCounts }> {
  if (actorId === targetId) throw ApiError.badRequest('You cannot unfollow yourself', 'self_follow');
  await query('DELETE FROM user_follows WHERE follower_id = $1 AND followee_id = $2', [actorId, targetId]);
  return { following: false, counts: await socialCounts(actorId) };
}

async function userMini(userId: string): Promise<MiniUser> {
  const row = await one<{
    id: string;
    username: string;
    avatar_url: string | null;
    vip_level: number;
    xp: string | number;
    profile_frame_key: string | null;
    profile_frame_expires_at: Date | null;
  }>(
    `SELECT id, username, avatar_url, vip_level, xp, profile_frame_key, profile_frame_expires_at
       FROM users WHERE id = $1`,
    [userId],
  );
  if (!row) throw ApiError.notFound('User not found', 'user_not_found');
  return toMiniUser(row);
}

async function followRows(
  sql: string,
  countSql: string,
  params: readonly unknown[],
  page: number,
  limit: number,
): Promise<{ users: FollowListEntry[]; total: number; page: number; limit: number }> {
  const rows = await many<{
    id: string;
    username: string;
    avatar_url: string | null;
    vip_level: number;
    xp: string | number;
    profile_frame_key: string | null;
    profile_frame_expires_at: Date | null;
    created_at: Date;
  }>(`${sql} ORDER BY f.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
    ...params,
    limit,
    (page - 1) * limit,
  ]);
  const total = await one<{ n: string }>(countSql, params);
  return {
    users: rows.map((row) => ({ ...toMiniUser(row), followedAt: iso(row.created_at) })),
    total: Number(total?.n ?? 0),
    page,
    limit,
  };
}

export async function listFollowers(
  userId: string,
  page: number,
  limit: number,
): Promise<{ users: FollowListEntry[]; total: number; page: number; limit: number }> {
  return followRows(
    `SELECT u.id, u.username, u.avatar_url, u.vip_level, u.xp,
            u.profile_frame_key, u.profile_frame_expires_at, f.created_at
       FROM user_follows f
       JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = $1 AND u.status = 'ACTIVE'`,
    `SELECT COUNT(*) AS n
       FROM user_follows f
       JOIN users u ON u.id = f.follower_id
      WHERE f.followee_id = $1 AND u.status = 'ACTIVE'`,
    [userId],
    page,
    limit,
  );
}

export async function listFollowing(
  userId: string,
  page: number,
  limit: number,
): Promise<{ users: FollowListEntry[]; total: number; page: number; limit: number }> {
  return followRows(
    `SELECT u.id, u.username, u.avatar_url, u.vip_level, u.xp,
            u.profile_frame_key, u.profile_frame_expires_at, f.created_at
       FROM user_follows f
       JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = $1 AND u.status = 'ACTIVE'`,
    `SELECT COUNT(*) AS n
       FROM user_follows f
       JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = $1 AND u.status = 'ACTIVE'`,
    [userId],
    page,
    limit,
  );
}

/**
 * A block also deletes the follow edges in both directions. Leaving them would make the pair
 * reappear in each other's follower lists even though every interaction is refused — a confusing
 * half-state that the next unblock would silently revive.
 */
export async function blockUser(
  actorId: string,
  targetId: string,
  reason?: string | null,
): Promise<{ blocked: true; counts: SocialCounts }> {
  if (actorId === targetId) throw ApiError.badRequest('You cannot block yourself', 'self_block');
  await userExists(targetId);

  await query(
    `INSERT INTO user_blocks (blocker_id, blocked_id, reason) VALUES ($1, $2, $3)
     ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
    [actorId, targetId, reason ?? null],
  );
  await query(
    `DELETE FROM user_follows
      WHERE (follower_id = $1 AND followee_id = $2)
         OR (follower_id = $2 AND followee_id = $1)`,
    [actorId, targetId],
  );
  return { blocked: true, counts: await socialCounts(actorId) };
}

export async function unblockUser(actorId: string, targetId: string): Promise<{ blocked: false; counts: SocialCounts }> {
  await query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [actorId, targetId]);
  return { blocked: false, counts: await socialCounts(actorId) };
}

export async function listBlocked(
  userId: string,
  page: number,
  limit: number,
): Promise<{ users: BlockedListEntry[]; total: number; page: number; limit: number }> {
  const rows = await many<{
    id: string;
    username: string;
    avatar_url: string | null;
    vip_level: number;
    xp: string | number;
    profile_frame_key: string | null;
    profile_frame_expires_at: Date | null;
    reason: string | null;
    created_at: Date;
  }>(
    `SELECT u.id, u.username, u.avatar_url, u.vip_level, u.xp,
            u.profile_frame_key, u.profile_frame_expires_at, b.reason, b.created_at
       FROM user_blocks b
       JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = $1
      ORDER BY b.created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, (page - 1) * limit],
  );
  const total = await one<{ n: string }>('SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_id = $1', [userId]);
  return {
    users: rows.map((row) => ({
      ...toMiniUser(row),
      followedAt: iso(row.created_at),
      blockReason: row.reason,
    })),
    total: Number(total?.n ?? 0),
    page,
    limit,
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export type ReportRow = {
  id: string;
  reporter_id: string;
  target_user_id: string;
  room_id: string | null;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  resolution: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  reporter_username?: string;
  reporter_avatar_url?: string | null;
  target_username?: string;
  target_avatar_url?: string | null;
  room_number?: number | null;
  room_title?: string | null;
};

export type ReportDto = {
  id: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  resolution: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reporter: MiniUser;
  target: MiniUser;
  room: { id: string; roomNumber: number; title: string } | null;
};

const REPORT_WITH_PARTIES = `
  SELECT r.*, reporter.username AS reporter_username, reporter.avatar_url AS reporter_avatar_url,
         target.username AS target_username, target.avatar_url AS target_avatar_url,
         room.room_number, room.title AS room_title
    FROM user_reports r
    JOIN users reporter ON reporter.id = r.reporter_id
    JOIN users target   ON target.id   = r.target_user_id
    LEFT JOIN rooms room ON room.id = r.room_id`;

export function toReport(row: ReportRow): ReportDto {
  return {
    id: row.id,
    reason: row.reason,
    details: row.details,
    status: row.status,
    resolution: row.resolution,
    createdAt: iso(row.created_at),
    reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
    reporter: toMiniUser({
      id: row.reporter_id,
      username: row.reporter_username ?? 'unknown',
      avatar_url: row.reporter_avatar_url ?? null,
    }),
    target: toMiniUser({
      id: row.target_user_id,
      username: row.target_username ?? 'unknown',
      avatar_url: row.target_avatar_url ?? null,
    }),
    room:
      row.room_id && row.room_number !== null && row.room_number !== undefined
        ? { id: row.room_id, roomNumber: Number(row.room_number), title: row.room_title ?? '' }
        : null,
  };
}

/**
 * A report is the one interaction a block does not stop. `assertInteractionAllowed` guards gifts,
 * follows and chat because those are conversations; the queue is a complaint to staff, and the
 * member who was blocked is often the one who needs it. Refusing it here would silence the victim
 * of the very behaviour the block was a reaction to.
 */
export async function createReport(input: {
  reporterId: string;
  targetId: string;
  reason: unknown;
  details?: unknown;
  roomId?: string | null;
}): Promise<ReportDto> {
  if (input.reporterId === input.targetId) throw ApiError.badRequest('You cannot report yourself', 'self_report');
  await userExists(input.targetId);
  const reason = normalizeReportReason(input.reason);
  const details = normalizeReportDetails(input.details);

  let roomId: string | null = null;
  if (input.roomId) {
    roomId = requireUserId(input.roomId, 'roomId');
    const room = await one<{ id: string }>('SELECT id FROM rooms WHERE id = $1', [roomId]);
    if (!room) throw ApiError.notFound('Room not found', 'room_not_found');
  }

  const inserted = await one<{ id: string }>(
    `INSERT INTO user_reports (reporter_id, target_user_id, room_id, reason, details)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.reporterId, input.targetId, roomId, reason, details],
  ).catch((err: { code?: string }) => {
    if (err.code === '23505') {
      throw ApiError.conflict('You already have an open report against this member', 'report_already_open');
    }
    throw err;
  });

  const row = await one<ReportRow>(`${REPORT_WITH_PARTIES} WHERE r.id = $1`, [inserted!.id]);
  return toReport(row!);
}

export async function listReports(opts: {
  status?: string;
  targetUserId?: string;
  reporterId?: string;
  page: number;
  limit: number;
}): Promise<{ reports: ReportDto[]; total: number; page: number; limit: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    if (!(REPORT_STATUSES as readonly string[]).includes(opts.status)) {
      throw ApiError.badRequest(`status must be one of: ${REPORT_STATUSES.join(', ')}`, 'report_status_invalid');
    }
    where.push(`r.status = $${params.push(opts.status)}`);
  }
  if (opts.targetUserId) where.push(`r.target_user_id = $${params.push(opts.targetUserId)}`);
  if (opts.reporterId) where.push(`r.reporter_id = $${params.push(opts.reporterId)}`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await many<ReportRow>(
    `${REPORT_WITH_PARTIES} ${clause}
      ORDER BY (r.status = 'PENDING') DESC, r.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.limit, (opts.page - 1) * opts.limit],
  );
  const total = await one<{ n: string }>(`SELECT COUNT(*) AS n FROM user_reports r ${clause}`, params);
  return { reports: rows.map(toReport), total: Number(total?.n ?? 0), page: opts.page, limit: opts.limit };
}

export async function reviewReport(input: {
  reportId: string;
  adminId: string;
  decision: ReportDecision;
  resolution?: string | null;
}): Promise<{ report: ReportDto; targetId: string }> {
  const resolution = normalizeResolution(input.resolution);
  const updated = await one<{ id: string; target_user_id: string }>(
    `UPDATE user_reports
        SET status = $3, reviewed_by = $2, reviewed_at = now(), resolution = $4
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id, target_user_id`,
    [input.reportId, input.adminId, input.decision, resolution],
  );
  if (!updated) {
    const existing = await one<{ id: string }>('SELECT id FROM user_reports WHERE id = $1', [input.reportId]);
    if (!existing) throw ApiError.notFound('Report not found', 'report_not_found');
    throw ApiError.conflict('This report has already been reviewed', 'report_already_reviewed');
  }
  const row = await one<ReportRow>(`${REPORT_WITH_PARTIES} WHERE r.id = $1`, [input.reportId]);
  return { report: toReport(row!), targetId: updated.target_user_id };
}

export async function socialSummaryForAdmin(userId: string): Promise<{
  counts: SocialCounts;
  followers: FollowListEntry[];
  following: FollowListEntry[];
  blocked: BlockedListEntry[];
  reportsAgainst: ReportDto[];
  reportsFiled: ReportDto[];
}> {
  await userExists(userId);
  const [counts, followers, following, blocked, against, filed] = await Promise.all([
    socialCounts(userId),
    listFollowers(userId, 1, 10),
    listFollowing(userId, 1, 10),
    listBlocked(userId, 1, 10),
    listReports({ targetUserId: userId, page: 1, limit: 10 }),
    listReports({ reporterId: userId, page: 1, limit: 10 }),
  ]);
  return {
    counts,
    followers: followers.users,
    following: following.users,
    blocked: blocked.users,
    reportsAgainst: against.reports,
    reportsFiled: filed.reports,
  };
}
