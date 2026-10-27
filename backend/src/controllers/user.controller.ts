import { Request, Response } from 'express';
import { many, one } from '../config/db';
import { RoomRow, UserRow } from '../types/db';
import { ApiError, asyncHandler, requireInt, requireString } from '../utils/http';
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
  res.json({ user, liveRoom: liveRoom ? toRoom(liveRoom) : null, agency: row.agency_name });
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
    earned: string;
  }>(
    `SELECT u.id, u.username, u.avatar_url, u.user_type, u.is_verified,
            ${board.sum} AS earned
       FROM transactions t
       JOIN users u ON u.id = ${board.column}
      WHERE t.type = 'GIFT_SENT' AND t.created_at >= now() - $1::interval
      GROUP BY u.id, u.username, u.avatar_url, u.user_type, u.is_verified
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
      earned: Number(row.earned),
    })),
  });
});
