import { Request, Response } from 'express';
import { many, one } from '../config/db';
import { rankFor } from '../services/rank.service';
import {
  blockUser,
  createReport,
  followUser,
  listBlocked,
  listFollowers,
  listFollowing,
  normalizeBlockReason,
  relationship,
  socialCounts,
  unfollowUser,
  unblockUser,
} from '../services/social.service';
import { emitToUser } from '../services/socket.service';
import { RoomRow, UserRow } from '../types/db';
import { ApiError, asyncHandler, optionalInt, requireInt, requireString } from '../utils/http';
import { toRoom, toUser } from '../utils/serialize';

const PUBLIC_PROFILE = `
  SELECT u.*, a.name AS agency_name
    FROM users u
    LEFT JOIN agency_hosts ah ON ah.host_user_id = u.id AND ah.status = 'ACTIVE'
    LEFT JOIN agencies a ON a.id = ah.agency_id
   WHERE u.id = $1`;

type ProfileRow = UserRow & { agency_name: string | null };

export const profile = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const row = await one<ProfileRow>(PUBLIC_PROFILE, [id]);
  if (!row) throw ApiError.notFound('User not found');

  // A phone number is private: never echoed for somebody else's profile.
  const user = toUser({ ...row, phone: '' });

  const liveRoom = await one<RoomRow>(
    `SELECT r.* FROM rooms r WHERE r.host_id = $1 AND r.status = 'ACTIVE' ORDER BY r.created_at DESC LIMIT 1`,
    [id],
  );
  // Follower counts are public — they are part of who the profile is. The list of *which*
  // accounts follow is behind `GET /users/:id/followers` and requires a signed-in caller.
  const social = await socialCounts(id);
  res.json({ user, liveRoom: liveRoom ? toRoom(liveRoom) : null, agency: row.agency_name, social });
});

/** How the signed-in caller relates to this member: following, blocked either way. */
export const relationshipStatus = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const target = await one<{ id: string }>('SELECT id FROM users WHERE id = $1', [id]);
  if (!target) throw ApiError.notFound('User not found');
  res.json(await relationship(req.user!.sub, id));
});

const listPaging = (req: Request) => ({
  page: optionalInt(req.query.page, 'page', { min: 1 }) ?? 1,
  limit: optionalInt(req.query.limit, 'limit', { min: 1, max: 100 }) ?? 20,
});

export const followers = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const target = await one<{ id: string }>('SELECT id FROM users WHERE id = $1', [id]);
  if (!target) throw ApiError.notFound('User not found');
  const { page, limit } = listPaging(req);
  res.json(await listFollowers(id, page, limit));
});

export const following = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const target = await one<{ id: string }>('SELECT id FROM users WHERE id = $1', [id]);
  if (!target) throw ApiError.notFound('User not found');
  const { page, limit } = listPaging(req);
  res.json(await listFollowing(id, page, limit));
});

/** The caller's own block list. Registered at `/blocked`, before `/:id`. */
export const blockedList = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = listPaging(req);
  res.json(await listBlocked(req.user!.sub, page, limit));
});

export const follow = asyncHandler(async (req: Request, res: Response) => {
  const targetId = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const result = await followUser(req.user!.sub, targetId);
  // The followed member sees it live; the follower is the actor in the payload.
  emitToUser(targetId, 'user:followed', { user: result.actor });
  res.json({ following: result.following, counts: result.counts });
});

export const unfollow = asyncHandler(async (req: Request, res: Response) => {
  const targetId = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const result = await unfollowUser(req.user!.sub, targetId);
  res.json({ following: result.following, counts: result.counts });
});

export const block = asyncHandler(async (req: Request, res: Response) => {
  const targetId = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const reason = normalizeBlockReason(req.body?.reason);
  const result = await blockUser(req.user!.sub, targetId, reason);
  // The blocked account is told only that the interaction is closed, never the reason: the
  // reason field is the blocking member's private note.
  emitToUser(targetId, 'user:blocked', { userId: req.user!.sub });
  res.json({ blocked: result.blocked, counts: result.counts });
});

export const unblock = asyncHandler(async (req: Request, res: Response) => {
  const targetId = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const result = await unblockUser(req.user!.sub, targetId);
  res.json({ blocked: result.blocked, counts: result.counts });
});

export const report = asyncHandler(async (req: Request, res: Response) => {
  const targetId = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const report = await createReport({
    reporterId: req.user!.sub,
    targetId,
    reason: req.body?.reason,
    details: req.body?.details,
    roomId: req.body?.roomId ? requireString(req.body.roomId, 'roomId', { min: 36, max: 36 }) : null,
  });
  // Deliberately no notification to the reported account: the queue is the operator's, and a
  // live "you were reported" event would let a harasser retaliate before review.
  res.status(201).json({ report });
});

const WINDOWS = { day: '1 day', week: '7 days', month: '30 days' } as const;

/**
 * Two boards over the same ledger rows. `receivers` answers "who is this room's
 * star" and `senders` answers "who is keeping the lights on", which is what a
 * gift panel's ranking button shows. `column`/`sum` are literals from this map
 * and never user input, so interpolating them into SQL stays safe.
 */
const BOARDS = {
  receivers: { column: 't.receiver_id', sum: 'COALESCE(SUM(t.amount_r_coins), 0)', unit: 'r_coin' },
  senders: { column: 't.sender_id', sum: 'COALESCE(SUM(t.amount_diamonds), 0)', unit: 'diamond' },
} as const;

type BoardKey = keyof typeof BOARDS;

export const leaderboard = asyncHandler(async (req: Request, res: Response) => {
  const windowKey = (req.query.window as keyof typeof WINDOWS) ?? 'week';
  const interval = WINDOWS[windowKey] ?? WINDOWS.week;
  const limit = requireInt(req.query.limit ?? 20, 'limit', { min: 1, max: 100 });
  const boardKey: BoardKey = req.query.role === 'senders' ? 'senders' : 'receivers';
  const board = BOARDS[boardKey];

  const rows = await many<{
    id: string;
    username: string;
    avatar_url: string | null;
    user_type: string;
    is_verified: boolean;
    xp: string | number;
    earned: string;
  }>(
    `SELECT u.id, u.username, u.avatar_url, u.user_type, u.is_verified, u.xp,
            ${board.sum} AS earned
       FROM transactions t
       JOIN users u ON u.id = ${board.column}
      WHERE t.type = 'GIFT_SENT' AND t.created_at >= now() - $1::interval
      GROUP BY u.id, u.username, u.avatar_url, u.user_type, u.is_verified, u.xp
      ORDER BY earned DESC LIMIT $2`,
    [interval, limit],
  );

  res.json({
    window: windowKey,
    role: boardKey,
    unit: board.unit,
    leaders: rows.map((row) => ({
      id: row.id,
      username: row.username,
      avatarUrl: row.avatar_url,
      userType: row.user_type,
      isVerified: row.is_verified,
      // Resolved from the ladder here: the sheet shows a name and a badge, never a raw number a
      // phone would have to compare against thresholds it guessed.
      rank: rankFor(Number(row.xp)),
      earned: Number(row.earned),
    })),
  });
});
