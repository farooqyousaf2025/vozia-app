import crypto from 'node:crypto';
import { many } from '../config/db';
import { redis } from '../config/redis';
import { GiftDto, MiniUser, toGift } from '../utils/serialize';
import { LuckyRollDto } from './lucky-box.service';

/**
 * The realtime identity of a gift: what a room needs in order to replay what it missed.
 *
 * The ledger already knows every gift that was ever bought, so nothing here is a second source of
 * truth about money. What the ledger does not know is the two things an *animation* needs: an id a
 * device can deduplicate against (the transaction id serves, and because the same id comes back
 * from a reconnect replay, a gift delivered twice live and once from history plays exactly once),
 * and whether this send continues the one before it (a combo).
 */

/**
 * A combo is a fixed window aligned to the server clock, so its identity needs no state: the same
 * sender, receiver, gift and room inside the same window produce the same `comboId`, and the window
 * cannot be stretched by a client that keeps tapping — only by time, which the client does not own.
 *
 * Splitting a genuine tap-storm at a window edge is the accepted cost of that. A sliding window
 * would need the counter to be the authority on when it ends, and a counter that any re-publishing
 * can extend is a combo that never stops.
 */
export type GiftCombo = { comboId: string; count: number };

export async function countGiftCombo(input: {
  roomId: string;
  senderId: string;
  receiverId: string;
  giftId: string;
  windowMs: number;
  /** FALSE for a gift the operator left out of the combo system: every send stands alone. */
  comboEnabled: boolean;
}): Promise<GiftCombo> {
  const windowIndex = Math.floor(Date.now() / input.windowMs);
  const comboId = crypto
    .createHash('sha256')
    .update(`${input.roomId}|${input.senderId}|${input.receiverId}|${input.giftId}|${windowIndex}`)
    .digest('hex')
    .slice(0, 16);

  if (!input.comboEnabled) return { comboId, count: 1 };

  // The counter is the only state, and it is disposable: losing it to a Redis flush mid-window
  // restarts the on-screen count at 1, which is a cosmetic regression, not a financial one. Two
  // windows of TTL keeps a window's key from outliving its own id.
  const key = `gift:combo:${comboId}`;
  const count = await redis.incr(key).catch(() => 1);
  if (count === 1) await redis.pexpire(key, input.windowMs * 2).catch(() => undefined);
  return { comboId, count: Number(count) || 1 };
}

/** One gift event as a reconnecting device needs it — the same shape `room:gift_animated` carries. */
export type RoomGiftEventDto = {
  eventId: string;
  gift: GiftDto;
  sender: MiniUser;
  receiver: MiniUser;
  seatIndex: number | null;
  quantity: number;
  totalDiamonds: number;
  /** The credit the receiver was paid, from the same ledger row; not recomputed from the catalogue. */
  totalRCoins: number;
  /**
   * What a lucky box rolled, read out of the same ledger row that paid for it. NULL for every flat
   * gift, so a client that has never heard of a box ignores it — and a device reconnecting mid-room
   * sees the prize the send actually won rather than the table the operator happens to keep now.
   */
  lucky: LuckyRollDto | null;
  createdAt: string;
};

const ROOM_GIFT_EVENTS = `
  SELECT t.id, t.sender_id, t.receiver_id, t.quantity, t.amount_diamonds, t.amount_r_coins, t.created_at, t.meta,
         g.id AS gift_id, g.name AS gift_name, g.icon_url, g.animation_url, g.sound_url,
         g.diamond_price, g.r_coin_value, g.category, g.effect_kind, g.animation_format,
         g.duration_ms, g.display_priority, g.combo_enabled, g.combo_window_ms,
         g.min_vip_level, g.sort_order, g.is_active, g.is_lucky_box, g.receiver_share_bps,
         su.username AS sender_username, su.avatar_url AS sender_avatar_url,
         ru.username AS receiver_username, ru.avatar_url AS receiver_avatar_url,
         rp.seat_index
    FROM transactions t
    LEFT JOIN gifts g             ON g.id = t.gift_id
    JOIN users su                 ON su.id = t.sender_id
    JOIN users ru                 ON ru.id = t.receiver_id
    LEFT JOIN room_participants rp ON rp.room_id = t.room_id
                                 AND rp.user_id = t.receiver_id
                                 AND rp.left_at IS NULL
   WHERE t.room_id = $1 AND t.type = 'GIFT_SENT'`;

type RoomGiftEventRow = {
  id: string;
  sender_id: string;
  receiver_id: string;
  quantity: number;
  amount_diamonds: number;
  amount_r_coins: number | null;
  created_at: Date;
  meta: { giftName?: string; iconUrl?: string; lucky?: LuckyRollDto } | null;
  gift_id: string | null;
  gift_name: string | null;
  icon_url: string | null;
  animation_url: string | null;
  sound_url: string | null;
  diamond_price: number | null;
  r_coin_value: number | null;
  category: string | null;
  effect_kind: string | null;
  animation_format: string | null;
  duration_ms: number | null;
  display_priority: number | null;
  combo_enabled: boolean | null;
  combo_window_ms: number | null;
  min_vip_level: number | null;
  sort_order: number | null;
  is_active: boolean | null;
  is_lucky_box: boolean | null;
  receiver_share_bps: number | null;
  sender_username: string | null;
  sender_avatar_url: string | null;
  receiver_username: string | null;
  receiver_avatar_url: string | null;
  seat_index: number | null;
};

/**
 * The most recent gift events in a room, newest first.
 *
 * This is what makes the dedupe worth having: a device that reconnects mid-room asks for the tail
 * of the room's gift history and replays it through the same queue the live socket feeds, and the
 * events it already saw are dropped by id. The window the client asks for is capped, so a room that
 * has been open for a week cannot be asked to send its whole ledger to a newcomer.
 */
export async function recentRoomGiftEvents(roomId: string, limit: number): Promise<RoomGiftEventDto[]> {
  const rows = await many<RoomGiftEventRow>(
    `${ROOM_GIFT_EVENTS} ORDER BY t.created_at DESC LIMIT $2`,
    [roomId, limit],
  );
  return rows.map(toRoomGiftEvent);
}

function toRoomGiftEvent(row: RoomGiftEventRow): RoomGiftEventDto {
  return {
    eventId: row.id,
    // An operator can delete a gift from the catalogue, and `transactions.gift_id` then has nothing
    // to point at. The receipt still has to animate — the send was authorised and paid for — so the
    // name and icon recorded in the ledger row at the time stand in for the missing catalogue entry,
    // and the event falls back to the quiet ticker rather than a full-screen effect it cannot size.
    gift: row.gift_id
      ? toGift({
          id: row.gift_id,
          name: row.gift_name ?? 'Gift',
          icon_url: row.icon_url ?? '',
          animation_url: row.animation_url,
          sound_url: row.sound_url,
          diamond_price: Number(row.diamond_price ?? 0),
          r_coin_value: Number(row.r_coin_value ?? 0),
          category: row.category ?? 'SPECIAL',
          effect_kind: (row.effect_kind ?? 'TICKER') as 'TICKER' | 'FULLSCREEN',
          animation_format: (row.animation_format ?? 'LOTTIE') as 'LOTTIE' | 'SVGA' | 'MP4',
          duration_ms: Number(row.duration_ms ?? 0),
          display_priority: Number(row.display_priority ?? 0),
          combo_enabled: Boolean(row.combo_enabled),
          combo_window_ms: Number(row.combo_window_ms ?? 5000),
          min_vip_level: Number(row.min_vip_level ?? 0),
          sort_order: Number(row.sort_order ?? 0),
          is_active: Boolean(row.is_active ?? true),
          is_lucky_box: Boolean(row.is_lucky_box),
          receiver_share_bps: Number(row.receiver_share_bps ?? 10_000),
        })
      : {
          id: '',
          name: row.meta?.giftName ?? row.gift_name ?? 'Gift',
          iconUrl: row.meta?.iconUrl ?? row.icon_url ?? '',
          animationUrl: null,
          soundUrl: null,
          diamondPrice: Number(row.amount_diamonds) / Math.max(1, Number(row.quantity)),
          rCoinValue: 0,
          category: 'SPECIAL',
          effectKind: 'TICKER',
          animationFormat: 'LOTTIE',
          durationMs: 0,
          displayPriority: 0,
          comboEnabled: false,
          comboWindowMs: 5000,
          minVipLevel: 0,
          sortOrder: 0,
          isActive: false,
          isLuckyBox: false,
        },
    sender: { id: row.sender_id, username: row.sender_username ?? 'unknown', avatarUrl: row.sender_avatar_url ?? null },
    receiver: { id: row.receiver_id, username: row.receiver_username ?? 'unknown', avatarUrl: row.receiver_avatar_url ?? null },
    seatIndex: row.seat_index,
    quantity: Number(row.quantity),
    totalDiamonds: Number(row.amount_diamonds),
    totalRCoins: Number(row.amount_r_coins ?? 0),
    lucky: row.meta?.lucky ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
