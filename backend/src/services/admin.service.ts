import { many, one, query } from '../config/db';
import { onlineUserCount } from '../config/redis';
import { AdminRow, GiftRow, ParticipantRow, RoomRow, UserRow, WithdrawalRow } from '../types/db';
import { ApiError } from '../utils/http';
import { GiftDto, ChatMessageDto, RoomDto, SeatDto, WithdrawalDto, toGift, toRoom, toWithdrawal } from '../utils/serialize';
import { livekitRooms } from './livekit.service';
import { fetchParticipants, getRoomDetail, listRoomBans } from './room.service';

export type AdminUserRow = UserRow & { agency_name: string | null };

export async function dashboardStats(): Promise<{
  activeRooms: number;
  onlineUsers: number;
  totalUsers: number;
  newUsersToday: number;
  diamondsSpentToday: number;
  rCoinsIssuedToday: number;
  giftsSentToday: number;
  withdrawalsPending: number;
  series: Array<{ date: string; diamonds: number; rooms: number }>;
}> {
  const [totals, online, series] = await Promise.all([
    one<{
      active_rooms: string;
      total_users: string;
      new_users_today: string;
      diamonds_today: string;
      rcoins_today: string;
      gifts_today: string;
      withdrawals_pending: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM rooms WHERE status = 'ACTIVE')                              AS active_rooms,
         (SELECT COUNT(*) FROM users)                                                       AS total_users,
         (SELECT COUNT(*) FROM users WHERE created_at >= date_trunc('day', now()))           AS new_users_today,
         (SELECT COALESCE(SUM(amount_diamonds),0) FROM transactions
           WHERE type = 'GIFT_SENT' AND created_at >= date_trunc('day', now()))              AS diamonds_today,
         (SELECT COALESCE(SUM(amount_r_coins),0) FROM transactions
           WHERE type IN ('GIFT_SENT','AGENCY_COMMISSION') AND created_at >= date_trunc('day', now())) AS rcoins_today,
         (SELECT COALESCE(SUM(quantity),0) FROM transactions
           WHERE type = 'GIFT_SENT' AND created_at >= date_trunc('day', now()))              AS gifts_today,
         (SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'PENDING')                 AS withdrawals_pending`,
    ),
    onlineUserCount().catch(() => 0),
    many<{ d: Date; diamonds: string; rooms: string }>(
      // Pre-aggregate each series and join on the day: a correlated subquery that
      // reads the generate_series column inside a GROUP BY query is rejected by
      // PostgreSQL ("subquery uses ungrouped column from outer query").
      `SELECT d.day AS d,
              COALESCE(t.diamonds, 0) AS diamonds,
              COALESCE(r.rooms, 0)    AS rooms
         FROM (SELECT generate_series(
                 date_trunc('day', now()) - interval '6 days', now(), interval '1 day')::date AS day) d
         LEFT JOIN (SELECT created_at::date AS day, SUM(amount_diamonds) AS diamonds
                      FROM transactions WHERE type = 'GIFT_SENT' GROUP BY 1) t ON t.day = d.day
         LEFT JOIN (SELECT created_at::date AS day, COUNT(*) AS rooms
                      FROM rooms GROUP BY 1) r ON r.day = d.day
        ORDER BY 1`,
    ),
  ]);

  return {
    activeRooms: Number(totals?.active_rooms ?? 0),
    onlineUsers: online,
    totalUsers: Number(totals?.total_users ?? 0),
    newUsersToday: Number(totals?.new_users_today ?? 0),
    diamondsSpentToday: Number(totals?.diamonds_today ?? 0),
    rCoinsIssuedToday: Number(totals?.rcoins_today ?? 0),
    giftsSentToday: Number(totals?.gifts_today ?? 0),
    withdrawalsPending: Number(totals?.withdrawals_pending ?? 0),
    series: series.map((row) => ({
      date: new Date(row.d).toISOString().slice(0, 10),
      diamonds: Number(row.diamonds),
      rooms: Number(row.rooms),
    })),
  };
}

export async function searchUsers(opts: {
  search?: string;
  status?: string;
  userType?: string;
  page: number;
  limit: number;
}): Promise<{ users: Array<AdminUserRow>; total: number; page: number; limit: number }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.search) {
    params.push(`%${opts.search}%`);
    const p = params.length;
    where.push(`(u.username ILIKE $${p} OR u.phone ILIKE $${p} OR u.id::text = $${p})`);
  }
  if (opts.status) where.push(`u.status = $${params.push(opts.status)}`);
  if (opts.userType) where.push(`u.user_type = $${params.push(opts.userType)}`);

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await many<AdminUserRow>(
    `SELECT u.*, a.name AS agency_name
       FROM users u
       LEFT JOIN agency_hosts ah ON ah.host_user_id = u.id AND ah.status = 'ACTIVE'
       LEFT JOIN agencies a ON a.id = ah.agency_id
       ${clause}
      ORDER BY u.created_at DESC
      LIMIT $${params.push(opts.limit)} OFFSET $${params.push((opts.page - 1) * opts.limit)}`,
    params,
  );
  const count = await one<{ n: string }>(`SELECT COUNT(*) AS n FROM users u ${clause}`, params.slice(0, where.length));

  return { users: rows, total: Number(count?.n ?? 0), page: opts.page, limit: opts.limit };
}

export async function setUserStatus(userId: string, banned: boolean): Promise<UserRow> {
  const row = await one<UserRow>('UPDATE users SET status = $2::user_status WHERE id = $1 RETURNING *', [
    userId,
    banned ? 'BANNED' : 'ACTIVE',
  ]);
  if (!row) throw ApiError.notFound('User not found');
  return row;
}

/**
 * VIP tier is the gift spend gate, so it is ops-only: there is deliberately no
 * self-service route for it, and buying power cannot be farmed from the app.
 */
export async function setUserVipLevel(userId: string, level: number): Promise<UserRow> {
  if (!Number.isInteger(level) || level < 0 || level > 20) {
    throw ApiError.badRequest('VIP level must be a whole number between 0 and 20');
  }
  const row = await one<UserRow>('UPDATE users SET vip_level = $2 WHERE id = $1 RETURNING *', [userId, level]);
  if (!row) throw ApiError.notFound('User not found');
  return row;
}

/**
 * Flat occupant row for the Room Monitor drawer: moderation needs role and
 * hand-raise state, which the app's seat grid does not care about.
 */
export type RoomOccupant = {
  userId: string;
  username: string;
  avatarUrl: string | null;
  seatIndex: number | null;
  role: 'HOST' | 'SPEAKER' | 'AUDIENCE';
  handRaised: boolean;
};

const toOccupant = (row: ParticipantRow): RoomOccupant => ({
  userId: row.user_id,
  username: row.username ?? 'unknown',
  avatarUrl: row.avatar_url ?? null,
  seatIndex: row.seat_index,
  role: row.role,
  handRaised: row.hand_raised,
});

export async function listRoomsForAdmin(opts: { status?: string; search?: string }): Promise<
  Array<RoomDto & { onlineSeatCount: number; seats: RoomOccupant[]; audience: RoomOccupant[] }>
> {
  const where: string[] = [];
  const params: unknown[] = [];
  where.push(`r.status = $${params.push(opts.status ?? 'ACTIVE')}`);
  if (opts.search) {
    params.push(`%${opts.search}%`);
    where.push(`(r.title ILIKE $${params.length} OR r.room_number::text LIKE $${params.length})`);
  }

  const rows = await many<RoomRow>(
    `SELECT r.*, u.username AS host_username, u.avatar_url AS host_avatar_url
       FROM rooms r JOIN users u ON u.id = r.host_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.total_gift_value DESC, r.created_at DESC LIMIT 200`,
    params,
  );

  return Promise.all(
    rows.map(async (row) => {
      const occupants = (await fetchParticipants(row.id)).map(toOccupant);
      const seats = occupants.filter((o) => o.role !== 'AUDIENCE');
      return {
        ...toRoom(row),
        onlineSeatCount: seats.length,
        seats,
        audience: occupants.filter((o) => o.role === 'AUDIENCE'),
      };
    }),
  );
}

/**
 * Everything the ops console renders for one room in a single call: the seat grid,
 * the pure-listener roster (seated members are removed from it here, so the panel
 * does not have to know that the broadcast snapshot mixes the two), recent chat,
 * live bans, and the counters that only moderation cares about.
 */
export type RoomMetrics = {
  liveSeats: number;
  mutedSeats: number;
  audienceCount: number;
  handRaiseCount: number;
  /** From the SFU itself — the truth about who is actually connected. Null when unreachable. */
  sfuParticipants: number | null;
  giftsToday: number;
  diamondsToday: number;
  rCoinsToday: number;
  chatLast5m: number;
  topSender: { username: string; diamonds: number } | null;
};

export type RoomConsole = {
  room: RoomDto;
  /** Seat-index-aligned grid with lock + mute flags, so the console can render real controls. */
  seats: SeatDto[];
  audience: RoomOccupant[];
  handRaises: RoomOccupant[];
  chat: ChatMessageDto[];
  bans: Awaited<ReturnType<typeof listRoomBans>>;
  metrics: RoomMetrics;
  listenerCount: number;
};

export async function roomConsole(roomId: string): Promise<RoomConsole> {
  const detail = await getRoomDetail(roomId);
  const occupants = (await fetchParticipants(roomId)).map(toOccupant);
  const seats = detail.seats;
  const handRaises = occupants.filter((o) => o.handRaised);
  const audience = occupants.filter((o) => o.role === 'AUDIENCE');

  const [agg, chatter, top, bans, sfu] = await Promise.all([
    one<{ gifts: string; diamonds: string; rcoins: string }>(
      `SELECT COALESCE(SUM(quantity),0) AS gifts,
              COALESCE(SUM(amount_diamonds),0) AS diamonds,
              COALESCE(SUM(amount_r_coins),0) AS rcoins
         FROM transactions
        WHERE room_id = $1 AND type = 'GIFT_SENT' AND created_at >= date_trunc('day', now())`,
      [roomId],
    ),
    one<{ n: string }>(
      `SELECT COUNT(*) AS n FROM chat_messages
        WHERE room_id = $1 AND created_at >= now() - interval '5 minutes'`,
      [roomId],
    ),
    one<{ username: string; diamonds: string }>(
      `SELECT u.username, SUM(t.amount_diamonds) AS diamonds
         FROM transactions t JOIN users u ON u.id = t.sender_id
        WHERE t.room_id = $1 AND t.type = 'GIFT_SENT' AND t.created_at >= date_trunc('day', now())
        GROUP BY u.username ORDER BY diamonds DESC LIMIT 1`,
      [roomId],
    ),
    listRoomBans(roomId),
    livekitSfuCount(detail.room.livekitRoomName),
  ]);

  return {
    room: detail.room,
    seats,
    audience,
    handRaises,
    chat: detail.chat,
    bans,
    listenerCount: detail.listenerCount,
    metrics: {
      liveSeats: seats.filter((s) => s.user).length,
      mutedSeats: seats.filter((s) => s.user && s.isMuted).length,
      audienceCount: audience.length,
      handRaiseCount: handRaises.length,
      sfuParticipants: sfu,
      giftsToday: Number(agg?.gifts ?? 0),
      diamondsToday: Number(agg?.diamonds ?? 0),
      rCoinsToday: Number(agg?.rcoins ?? 0),
      chatLast5m: Number(chatter?.n ?? 0),
      topSender: top ? { username: top.username, diamonds: Number(top.diamonds) } : null,
    },
  };
}

/** Participant count straight from the SFU; null (not 0) when the call fails. */
async function livekitSfuCount(roomName: string): Promise<number | null> {
  try {
    return (await livekitRooms().listParticipants(roomName)).length;
  } catch (err) {
    console.debug('[admin] SFU participant count skipped', (err as Error).message);
    return null;
  }
}

export async function listGifts(opts: { includeInactive?: boolean } = {}): Promise<GiftDto[]> {
  const rows = await many<GiftRow>(
    `SELECT * FROM gifts ${opts.includeInactive ? '' : 'WHERE is_active'} ORDER BY sort_order, diamond_price`,
  );
  return rows.map(toGift);
}

/** How loudly a gift plays on screen — see the `effect_kind` column comment. */
export const GIFT_EFFECT_KINDS = ['TICKER', 'FULLSCREEN'] as const;

export type GiftInput = {
  name: string;
  iconUrl: string;
  animationUrl?: string | null;
  soundUrl?: string | null;
  diamondPrice: number;
  rCoinValue: number;
  category: string;
  minVipLevel: number;
  sortOrder: number;
  effectKind?: 'TICKER' | 'FULLSCREEN';
  isActive: boolean;
};

export async function createGift(input: GiftInput): Promise<GiftDto> {
  const row = await one<GiftRow>(
    `INSERT INTO gifts (name, icon_url, animation_url, sound_url, diamond_price, r_coin_value,
                        category, min_vip_level, sort_order, effect_kind, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      input.name,
      input.iconUrl,
      input.animationUrl ?? null,
      input.soundUrl ?? null,
      input.diamondPrice,
      input.rCoinValue,
      input.category,
      input.minVipLevel,
      input.sortOrder,
      input.effectKind ?? 'TICKER',
      input.isActive,
    ],
  );
  if (!row) throw new Error('Gift insert failed');
  return toGift(row);
}

const GIFT_FIELDS: Record<string, string> = {
  name: 'name',
  iconUrl: 'icon_url',
  animationUrl: 'animation_url',
  soundUrl: 'sound_url',
  diamondPrice: 'diamond_price',
  rCoinValue: 'r_coin_value',
  category: 'category',
  minVipLevel: 'min_vip_level',
  sortOrder: 'sort_order',
  effectKind: 'effect_kind',
  isActive: 'is_active',
};

export async function updateGift(giftId: string, patch: Partial<GiftInput>): Promise<GiftDto> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(GIFT_FIELDS)) {
    // `in` alone is not enough: an explicitly-undefined key would write NULL.
    if (!(key in patch) || patch[key as keyof GiftInput] === undefined) continue;
    params.push((patch as Record<string, unknown>)[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) throw ApiError.badRequest('Nothing to update');

  params.push(giftId);
  const row = await one<GiftRow>(
    `UPDATE gifts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  );
  if (!row) throw ApiError.notFound('Gift not found');
  return toGift(row);
}

export async function deleteGift(giftId: string): Promise<{ ok: true }> {
  const res = await query('DELETE FROM gifts WHERE id = $1', [giftId]);
  if (!res.rowCount) throw ApiError.notFound('Gift not found');
  return { ok: true };
}

export type WithdrawalUser = {
  id: string;
  username: string;
  avatarUrl: string | null;
  phone: string;
  rCoinBalance: number;
  userType: string;
  status: string;
};

export type AdminWithdrawal = Omit<WithdrawalDto, 'user'> & { user: WithdrawalUser };

const WITHDRAWAL_SELECT = `
  SELECT w.*, u.username, u.avatar_url, u.phone,
         u.r_coin_balance AS user_r_coin_balance,
         u.user_type AS user_type, u.status AS user_status
    FROM withdrawal_requests w
    JOIN users u ON u.id = w.user_id`;

type WithdrawalJoinedRow = WithdrawalRow & {
  username: string;
  avatar_url: string | null;
  phone: string;
  user_r_coin_balance: number;
  user_type: string;
  user_status: string;
};

function toAdminWithdrawal(row: WithdrawalJoinedRow): AdminWithdrawal {
  const base = toWithdrawal(row);
  return {
    ...base,
    user: {
      id: row.user_id,
      username: row.username,
      avatarUrl: row.avatar_url ?? null,
      phone: row.phone,
      rCoinBalance: row.user_r_coin_balance,
      userType: row.user_type,
      status: row.user_status,
    },
  };
}

export async function listWithdrawals(status?: string): Promise<{ withdrawals: AdminWithdrawal[] }> {
  const params: unknown[] = [];
  let clause = '';
  if (status) clause = `WHERE w.status = $${params.push(status)}::withdrawal_status`;
  const rows = await many<WithdrawalJoinedRow>(
    `${WITHDRAWAL_SELECT} ${clause} ORDER BY w.created_at DESC LIMIT 200`,
    params,
  );
  return { withdrawals: rows.map(toAdminWithdrawal) };
}

/** Same payload shape as the list, used after an approve/reject decision. */
export async function getAdminWithdrawal(withdrawalId: string): Promise<AdminWithdrawal | null> {
  const row = await one<WithdrawalJoinedRow>(`${WITHDRAWAL_SELECT} WHERE w.id = $1`, [withdrawalId]);
  return row ? toAdminWithdrawal(row) : null;
}

export async function findAdminByUsername(username: string): Promise<AdminRow | null> {
  const rows = await many<AdminRow>('SELECT * FROM admins WHERE username = $1', [username]);
  return rows[0] ?? null;
}

/** Read from the table on every authorised request, never from the token claim. */
export async function findAdminById(id: string): Promise<AdminRow | null> {
  return one<AdminRow>('SELECT * FROM admins WHERE id = $1', [id]);
}
