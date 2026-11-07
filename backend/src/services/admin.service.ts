import { many, one, query, withTransaction } from '../config/db';
import { onlineUserCount } from '../config/redis';
import { PoolClient } from 'pg';
import { AdminRow, GiftBoxOutcomeRow, GiftCategoryRow, GiftRow, ParticipantRow, RoomRow, UserRow, WithdrawalRow } from '../types/db';
import { ApiError } from '../utils/http';
import { GiftDto, ChatMessageDto, RoomDto, SeatDto, WithdrawalDto, toGift, toRoom, toWithdrawal } from '../utils/serialize';
import { BoxOutcome, BoxOutcomeDto, toBoxOutcomeDtos, toBoxOutcomes, validateLuckyBox } from './lucky-box.service';
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
 * Experience is a record of what a member already did, so an operator touches it only to correct
 * what the ladder mis-scored — a refund of a wrongly-awarded gift, a cheat's history. It is a
 * delta, not an absolute set, so a concurrent gift cannot be overwritten by a stale form value,
 * and the endpoint is audited like the VIP setter.
 *
 * `users.xp` is what the badge is resolved from; there is no stored level to keep in step.
 */
export async function adjustUserXp(userId: string, delta: number): Promise<UserRow> {
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000_000) {
    throw ApiError.badRequest('delta must be a whole number other than zero, up to 1,000,000,000', 'xp_delta_invalid');
  }
  const row = await one<UserRow>(
    'UPDATE users SET xp = xp + $2, updated_at = now() WHERE id = $1 AND xp + $2 >= 0 RETURNING *',
    [userId, delta],
  );
  if (row) return row;
  if (!(await one<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId]))) throw ApiError.notFound('User not found');
  throw ApiError.badRequest(
    'That would take this account below zero experience — their history cannot be negative',
    'xp_would_go_negative',
  );
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

export async function listGifts(opts: { includeInactive?: boolean; includeWeights?: boolean } = {}): Promise<GiftDto[]> {
  const rows = await many<GiftRow>(
    `SELECT * FROM gifts ${opts.includeInactive ? '' : 'WHERE is_active'} ORDER BY sort_order, diamond_price`,
  );
  // `includeWeights` is the operator's view: the panel shows the raw weights beside the odds they
  // produce, because editing 4,000 against 100 is how an operator reasons. A device gets `chanceBps`,
  // which is the same fact at a scale a phone can print without doing arithmetic on a payout.
  return attachBoxOutcomes(rows.map(toGift), opts.includeWeights ?? false);
}

/** How loudly a gift plays on screen — see the `effect_kind` column comment. */
export const GIFT_EFFECT_KINDS = ['TICKER', 'FULLSCREEN'] as const;

/** Which renderer plays `animation_url`; the client routes on this, never on the file name. */
export const GIFT_ANIMATION_FORMATS = ['LOTTIE', 'SVGA', 'MP4'] as const;

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
  animationFormat?: 'LOTTIE' | 'SVGA' | 'MP4';
  durationMs?: number;
  displayPriority?: number;
  comboEnabled?: boolean;
  comboWindowMs?: number;
  isActive: boolean;
  isLuckyBox?: boolean;
  receiverShareBps?: number;
  /**
   * The whole prize table, not a patch: the panel edits a box's outcomes as one list, so a write
   * replaces the rows rather than merging into them. Present only when the caller means to change
   * the draw — an update that leaves the key out keeps the box's prizes exactly as they were.
   */
  boxOutcomes?: BoxOutcome[];
};

/**
 * The prizes of every box in `gifts`, in one query.
 *
 * Attached by the loaders rather than mapped inside `toGift`, because that function turns one row
 * into one DTO and a prize table is a dozen rows; a gift that is not a box is left without the key
 * at all, which is how a device tells "this gift has no odds" from "this box has none configured".
 */
/** Every prize of every box named, in the order the draw walks them. */
const BOX_OUTCOME_READ = `SELECT * FROM gift_box_outcomes WHERE gift_id = ANY($1::uuid[])
                            ORDER BY sort_order ASC, label ASC`;

async function attachBoxOutcomes<T extends Pick<GiftDto, 'id' | 'isLuckyBox'>>(
  gifts: T[],
  includeWeights: boolean,
  client?: PoolClient,
): Promise<T[]> {
  const boxIds = gifts.filter((gift) => gift.isLuckyBox).map((gift) => gift.id);
  if (!boxIds.length) return gifts;
  const rows = client
    ? (await client.query<GiftBoxOutcomeRow>(BOX_OUTCOME_READ, [boxIds])).rows
    : (await query<GiftBoxOutcomeRow>(BOX_OUTCOME_READ, [boxIds])).rows;
  const byGift = new Map<string, BoxOutcome[]>();
  for (const row of rows) {
    const list = byGift.get(row.gift_id) ?? [];
    list.push({ label: row.label, multiplierBps: row.multiplier_bps, weight: row.weight });
    byGift.set(row.gift_id, list);
  }
  return gifts.map((gift) => {
    const outcomes = byGift.get(gift.id);
    if (!outcomes) return gift;
    return { ...gift, boxOutcomes: toBoxOutcomeDtos(outcomes, includeWeights) as BoxOutcomeDto[] };
  });
}

/**
 * Replaces a box's prize table.
 *
 * Delete-then-insert rather than a diff, because the caller sends the list it wants to exist; the
 * rows have no identity a client could meaningfully patch, and `gifts` rows are not referenced by
 * receipts. Runs on the caller's client so a rejected validation never leaves half a table written.
 */
async function writeBoxOutcomes(client: PoolClient, giftId: string, outcomes: BoxOutcome[]): Promise<void> {
  await client.query('DELETE FROM gift_box_outcomes WHERE gift_id = $1', [giftId]);
  if (!outcomes.length) return;
  const placeholders = outcomes
    .map((_, i) => `($1,$${i * 3 + 2},$${i * 3 + 3},$${i * 3 + 4},${(i + 1) * 10})`)
    .join(',');
  const params = outcomes.reduce<unknown[]>((acc, o) => {
    acc.push(o.label, o.multiplierBps, o.weight);
    return acc;
  }, [giftId]);
  await client.query(
    `INSERT INTO gift_box_outcomes (gift_id, label, multiplier_bps, weight, sort_order) VALUES ${placeholders}`,
    params,
  );
}

export async function createGift(input: GiftInput): Promise<GiftDto> {
  await assertGiftCategoryExists(input.category);
  const isBox = input.isLuckyBox ?? false;
  const outcomes = input.boxOutcomes ?? [];
  if (outcomes.length && !isBox) {
    throw ApiError.badRequest('Only a lucky box has prizes to roll — set isLuckyBox with these outcomes', 'lucky_box_outcomes_without_box');
  }
  validateLuckyBox({
    isLuckyBox: isBox,
    receiverShareBps: input.receiverShareBps ?? 10_000,
    rCoinValue: input.rCoinValue,
    outcomes,
  });

  const gift = await withTransaction(async (client) => {
    const res = await client.query<GiftRow>(
      `INSERT INTO gifts (name, icon_url, animation_url, sound_url, diamond_price, r_coin_value,
                          category, min_vip_level, sort_order, effect_kind, animation_format,
                          duration_ms, display_priority, combo_enabled, combo_window_ms, is_active,
                          is_lucky_box, receiver_share_bps)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
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
        input.animationFormat ?? 'LOTTIE',
        input.durationMs ?? 0,
        input.displayPriority ?? 0,
        input.comboEnabled ?? false,
        input.comboWindowMs ?? 5_000,
        input.isActive,
        isBox,
        input.receiverShareBps ?? 10_000,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error('Gift insert failed');
    if (isBox && outcomes.length) await writeBoxOutcomes(client, row.id, outcomes);
    return toGift(row);
  });
  const [withOutcomes] = await attachBoxOutcomes([gift], true);
  return withOutcomes;
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
  animationFormat: 'animation_format',
  durationMs: 'duration_ms',
  displayPriority: 'display_priority',
  comboEnabled: 'combo_enabled',
  comboWindowMs: 'combo_window_ms',
  isActive: 'is_active',
  isLuckyBox: 'is_lucky_box',
  receiverShareBps: 'receiver_share_bps',
};

export async function updateGift(giftId: string, patch: Partial<GiftInput>): Promise<GiftDto> {
  if (patch.category !== undefined) await assertGiftCategoryExists(patch.category);
  const patchHas = (key: keyof GiftInput) => key in patch && patch[key] !== undefined;

  const gift = await withTransaction(async (client) => {
    // The row is read under a lock before the arithmetic below, so a box cannot be reweighted by two
    // overlapping PATCHes into a table that satisfies neither of them on its own.
    const currentRes = await client.query<GiftRow>('SELECT * FROM gifts WHERE id = $1 FOR UPDATE', [giftId]);
    const current = currentRes.rows[0];
    if (!current) throw ApiError.notFound('Gift not found');

    const effective = {
      isLuckyBox: patchHas('isLuckyBox') ? Boolean(patch.isLuckyBox) : current.is_lucky_box,
      receiverShareBps: patchHas('receiverShareBps') ? Number(patch.receiverShareBps) : current.receiver_share_bps,
      rCoinValue: patchHas('rCoinValue') ? Number(patch.rCoinValue) : current.r_coin_value,
    };
    // Absent `boxOutcomes` means "leave the draw alone"; an empty list is still an answer, and
    // `validateLuckyBox` below is what refuses it — a box nobody can roll is how a payout disappears.
    const rewritingOutcomes = patchHas('boxOutcomes');
    const outcomes = rewritingOutcomes ? patch.boxOutcomes ?? [] : null;
    if (outcomes && !effective.isLuckyBox) {
      throw ApiError.badRequest('Only a lucky box has prizes to roll — set isLuckyBox with these outcomes', 'lucky_box_outcomes_without_box');
    }
    if (effective.isLuckyBox) {
      // Validate the table that will exist once this write lands: the one being written now, or the
      // one already stored when the patch only moves the share dial or the price.
      const table = outcomes ?? toBoxOutcomes(
        (await client.query<GiftBoxOutcomeRow>(
          'SELECT * FROM gift_box_outcomes WHERE gift_id = $1 ORDER BY sort_order ASC, label ASC',
          [giftId],
        )).rows,
      );
      validateLuckyBox({ ...effective, outcomes: table });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(GIFT_FIELDS)) {
      // `in` alone is not enough: an explicitly-undefined key would write NULL.
      if (!(key in patch) || patch[key as keyof GiftInput] === undefined) continue;
      params.push((patch as Record<string, unknown>)[key]);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length && !rewritingOutcomes) throw ApiError.badRequest('Nothing to update');

    let row = current;
    if (sets.length) {
      params.push(giftId);
      const updated = await client.query<GiftRow>(
        `UPDATE gifts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      row = updated.rows[0];
      if (!row) throw ApiError.notFound('Gift not found');
    }
    // A box that stops being one loses its prizes: nothing reads them while the flag is off, and
    // leaving a stale draw behind would mean the next time this gift is switched on it rolls odds
    // nobody has looked at since.
    if (current.is_lucky_box && !effective.isLuckyBox) {
      await client.query('DELETE FROM gift_box_outcomes WHERE gift_id = $1', [giftId]);
    } else if (outcomes && effective.isLuckyBox) {
      await writeBoxOutcomes(client, giftId, outcomes);
    }
    return toGift(row);
  });
  const [withOutcomes] = await attachBoxOutcomes([gift], true);
  return withOutcomes;
}

export async function deleteGift(giftId: string): Promise<{ ok: true }> {
  const res = await query('DELETE FROM gifts WHERE id = $1', [giftId]);
  if (!res.rowCount) throw ApiError.notFound('Gift not found');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Gift categories — the shelves the gift panel tabs are built from
// ---------------------------------------------------------------------------
//
// Migration 0025 turned these from a comment in `schema.sql` into a table, so the list an operator
// edits here is the same list a device reads. The key stays immutable for the reason every other
// identity in this codebase does: gift rows and the tabs derived from them name it, so a rename is
// an edit to `name` and never to `key`.

/** `gift_categories` (migration 0025) — one tab in the gift panel. */
export type GiftCategoryDto = {
  key: string;
  name: string;
  sortOrder: number;
  /** Gifts filed here, unpublished ones included — an empty shelf is a shelf nobody can buy from. */
  gifts: number;
};

const CATEGORY_KEY_PATTERN = /^[A-Z0-9][A-Z0-9_]{1,23}$/;

export async function listGiftCategories(): Promise<GiftCategoryDto[]> {
  const rows = await many<GiftCategoryRow & { gifts: string }>(
    `SELECT c.key, c.name, c.sort_order,
            (SELECT COUNT(*) FROM gifts g WHERE g.category = c.key)::text AS gifts
       FROM gift_categories c ORDER BY c.sort_order ASC, c.key ASC`,
  );
  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    sortOrder: row.sort_order,
    gifts: Number(row.gifts ?? 0),
  }));
}

/**
 * Refuse a gift write that names a shelf nobody added.
 *
 * The foreign key would reject it too, but as a 500 carrying a constraint name; a price list an
 * operator is editing by hand deserves the sentence that says which word is unrecognised.
 */
export async function assertGiftCategoryExists(key: string): Promise<void> {
  const found = await one<{ key: string }>('SELECT key FROM gift_categories WHERE key = $1', [key]);
  if (!found) {
    throw ApiError.badRequest(
      `${key} is not a gift category — add it under Categories first, or pick one of the existing shelves`,
      'gift_category_unknown',
    );
  }
}

export async function createGiftCategory(input: { key: string; name: string; sortOrder: number }): Promise<GiftCategoryDto> {
  if (!CATEGORY_KEY_PATTERN.test(input.key)) {
    throw ApiError.badRequest(
      'A category key is 2-24 characters of upper-case letters, digits and underscores — it is what every gift row stores',
      'category_key_invalid',
    );
  }
  if (await one<{ key: string }>('SELECT key FROM gift_categories WHERE key = $1', [input.key])) {
    throw ApiError.conflict(`A category already uses the key ${input.key}`, 'category_exists');
  }
  const row = await one<GiftCategoryRow>(
    'INSERT INTO gift_categories (key, name, sort_order) VALUES ($1,$2,$3) RETURNING *',
    [input.key, input.name, input.sortOrder],
  );
  if (!row) throw new Error('Category insert failed');
  return { key: row.key, name: row.name, sortOrder: row.sort_order, gifts: 0 };
}

export async function updateGiftCategory(
  key: string,
  patch: { name?: string; sortOrder?: number },
): Promise<GiftCategoryDto> {
  const existing = await one<GiftCategoryRow>('SELECT * FROM gift_categories WHERE key = $1', [key]);
  if (!existing) throw ApiError.notFound('Category not found', 'category_not_found');

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.sortOrder !== undefined) {
    params.push(patch.sortOrder);
    sets.push(`sort_order = $${params.length}`);
  }
  if (!sets.length) throw ApiError.badRequest('Nothing to update');

  params.push(key);
  const row = await one<GiftCategoryRow>(
    `UPDATE gift_categories SET ${sets.join(', ')} WHERE key = $${params.length} RETURNING *`,
    params,
  );
  const gifts = await one<{ n: string }>('SELECT COUNT(*)::text n FROM gifts WHERE category = $1', [key]);
  return { key: row!.key, name: row!.name, sortOrder: row!.sort_order, gifts: Number(gifts?.n ?? 0) };
}

/**
 * Remove a shelf. Refused while any gift is filed under it, by name: deleting the category and
 * letting the gifts fall through to a default would re-file rows nobody asked to move, and the
 * operator would only find out from the app.
 */
export async function deleteGiftCategory(key: string): Promise<{ ok: true; key: string }> {
  const existing = await one<{ key: string }>('SELECT key FROM gift_categories WHERE key = $1', [key]);
  if (!existing) throw ApiError.notFound('Category not found', 'category_not_found');

  const inUse = await many<{ name: string }>('SELECT name FROM gifts WHERE category = $1 ORDER BY name', [key]);
  if (inUse.length) {
    throw ApiError.conflict(
      `${key} still holds ${inUse.length} gift(s): ${inUse.slice(0, 5).map((r) => r.name).join(', ')}${
        inUse.length > 5 ? ', …' : ''
      } — move them to another category first`,
      'category_in_use',
    );
  }
  await query('DELETE FROM gift_categories WHERE key = $1', [key]);
  return { ok: true, key };
}

// ---------------------------------------------------------------------------
// Gift analytics
// ---------------------------------------------------------------------------

/**
 * What the gifts earned, per gift.
 *
 * Read from the ledger rather than from `gifts`, because the question an operator asks is about
 * money that actually moved: a catalogue row says the Rose costs 1 diamond and the transactions say
 * it was sent 4,000 times, and only the second half is a fact about the business. `gift_id` is
 * `ON DELETE SET NULL`, so a retired gift stops appearing here while its diamonds stay in `totals` —
 * which is why the totals are summed from the rows and not from the per-gift list.
 */
export type GiftAnalyticsRow = {
  giftId: string;
  name: string;
  iconUrl: string;
  category: string;
  /** Ledger rows, i.e. taps of the send button — a combo of ten Roses is one `send` of quantity 10. */
  sends: number;
  /** Individual gifts, which is `quantity` summed. */
  gifts: number;
  diamonds: number;
  rCoins: number;
  senders: number;
  /** Diamonds per gift sent, so a 1-diamond Rose and a 9,999 castle are comparable. */
  averageDiamonds: number;
  /**
   * true = this row is a lucky box, whose `rCoins / diamonds` is the realised payout of the draw
   * rather than the catalogue's fixed rate. Beside the box's published share, that is the one number
   * that tells an operator whether a box is paying what they meant it to.
   */
  isLuckyBox: boolean;
};

export async function giftAnalytics(opts: { days?: number } = {}): Promise<{
  days: number;
  totals: { sends: number; gifts: number; diamonds: number; rCoins: number; averageDiamondPerGift: number; unattributedDiamonds: number };
  gifts: GiftAnalyticsRow[];
}> {
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);

  const [totals, rows, unattributed] = await Promise.all([
    one<{ sends: string; gifts: string; diamonds: string; rcoins: string }>(
      `SELECT COUNT(*)::text AS sends,
              COALESCE(SUM(quantity), 0)::text AS gifts,
              COALESCE(SUM(amount_diamonds), 0)::text AS diamonds,
              COALESCE(SUM(amount_r_coins), 0)::text AS rcoins
         FROM transactions
        WHERE type = 'GIFT_SENT' AND status = 'COMPLETED'
          AND created_at >= now() - ($1 || ' days')::interval`,
      [days],
    ),
    many<{
      gift_id: string;
      name: string;
      icon_url: string;
      category: string;
      is_lucky_box: boolean;
      sends: string;
      gifts: string;
      diamonds: string;
      rcoins: string;
      senders: string;
    }>(
      `SELECT t.gift_id, g.name, g.icon_url, g.category, g.is_lucky_box,
              COUNT(*)::text AS sends,
              COALESCE(SUM(t.quantity), 0)::text AS gifts,
              COALESCE(SUM(t.amount_diamonds), 0)::text AS diamonds,
              COALESCE(SUM(t.amount_r_coins), 0)::text AS rcoins,
              COUNT(DISTINCT t.sender_id)::text AS senders
         FROM transactions t
         JOIN gifts g ON g.id = t.gift_id
        WHERE t.type = 'GIFT_SENT' AND t.status = 'COMPLETED'
          AND t.created_at >= now() - ($1 || ' days')::interval
        GROUP BY t.gift_id, g.name, g.icon_url, g.category, g.is_lucky_box
        ORDER BY COALESCE(SUM(t.amount_diamonds), 0) DESC, COUNT(*) DESC
        LIMIT 100`,
      [days],
    ),
    one<{ diamonds: string }>(
      `SELECT COALESCE(SUM(amount_diamonds), 0)::text AS diamonds
         FROM transactions
        WHERE type = 'GIFT_SENT' AND status = 'COMPLETED' AND gift_id IS NULL
          AND created_at >= now() - ($1 || ' days')::interval`,
      [days],
    ),
  ]);

  const diamonds = Number(totals?.diamonds ?? 0);
  const gifts = Number(totals?.gifts ?? 0);

  return {
    days,
    totals: {
      sends: Number(totals?.sends ?? 0),
      gifts,
      diamonds,
      rCoins: Number(totals?.rcoins ?? 0),
      averageDiamondPerGift: gifts > 0 ? Math.round((diamonds / gifts) * 100) / 100 : 0,
      unattributedDiamonds: Number(unattributed?.diamonds ?? 0),
    },
    gifts: rows.map((row) => {
      const rowGifts = Number(row.gifts);
      const rowDiamonds = Number(row.diamonds);
      return {
        giftId: row.gift_id,
        name: row.name,
        iconUrl: row.icon_url,
        category: row.category,
        sends: Number(row.sends),
        gifts: rowGifts,
        diamonds: rowDiamonds,
        rCoins: Number(row.rcoins),
        senders: Number(row.senders),
        averageDiamonds: rowGifts > 0 ? Math.round((rowDiamonds / rowGifts) * 100) / 100 : 0,
        isLuckyBox: row.is_lucky_box,
      };
    }),
  };
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
