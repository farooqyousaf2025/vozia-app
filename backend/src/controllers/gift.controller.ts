import { Request, Response } from 'express';
import { many, one } from '../config/db';
import { RoomRow, TransactionRow, UserRow } from '../types/db';
import { ApiError, asyncHandler, optionalString, requireInt, requireString } from '../utils/http';
import { sendGift } from '../services/ledger.service';
import { appendSystemChat } from '../services/room.service';
import { listGiftCategories, listGifts } from '../services/admin.service';
import { countGiftCombo, recentRoomGiftEvents } from '../services/gift-events.service';
import { broadcastGiftAnimated, emitToRoom, emitToUser } from '../services/socket.service';
import { announceGiftScore } from '../services/pk.service';
import { pushToUser } from '../services/push.service';

export const catalog = asyncHandler(async (_req: Request, res: Response) => {
  // Two arrays, one response: the gifts, and the shelves they sort into in the operator's order with
  // the labels they chose. A device used to derive its tab strip from the distinct strings on the
  // gifts, which worked until somebody renamed a shelf and left the panel guessing at an order.
  const [gifts, categories] = await Promise.all([listGifts(), listGiftCategories()]);
  res.json({ gifts, categories });
});

/** How far back a reconnecting device may ask for the room's gift tail, in events. */
const MAX_RECENT_ROOM_GIFTS = 40;

/**
 * Buying a gift is the only path that moves diamonds between accounts, so the
 * money itself is one SQL transaction in the ledger service; everything here is
 * validation plus the realtime announcement afterwards.
 */
export const send = asyncHandler(async (req: Request, res: Response) => {
  const senderId = req.user!.sub;
  const giftId = requireString(req.body?.giftId, 'giftId', { min: 36, max: 36 });
  const receiverId = requireString(req.body?.receiverId, 'receiverId', { min: 36, max: 36 });
  const quantity = requireInt(req.body?.quantity ?? 1, 'quantity', { min: 1, max: 999 });
  const roomId = optionalString(req.body?.roomId, 'roomId', 36);
  // A client-generated key for this tap of Send. It is what lets a phone that never saw the
  // response retry without paying twice, so it is forwarded to the ledger, where the uniqueness
  // is enforced against the money — not deduplicated here, where a race would slip through.
  const idempotencyKey = optionalString(req.body?.idempotencyKey, 'idempotencyKey', 80);

  if (roomId) {
    const room = await one<RoomRow>('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (!room) throw ApiError.notFound('Room not found', 'room_not_found');
    if (room.status !== 'ACTIVE') throw ApiError.conflict('This room is closed', 'room_closed');
  } else {
    const receiver = await one<UserRow>('SELECT id FROM users WHERE id = $1', [receiverId]);
    if (!receiver) throw ApiError.notFound('Receiver not found');
  }

  const result = await sendGift({ senderId, receiverId, giftId, quantity, roomId, idempotencyKey });
  const { transaction, sender, receiver, gift, replayed, lucky } = result;

  // A replay of an already-paid request answers with the original receipt and publishes nothing:
  // the animation went out with the first response, and a second copy would be the duplicate this
  // key exists to prevent.
  if (replayed) {
    res.json({ transaction, sender, receiver, gift, lucky, replayed: true });
    return;
  }

  if (roomId) {
    const seatRow = await one<{ seat_index: number }>(
      'SELECT seat_index FROM room_seats WHERE room_id = $1 AND user_id = $2',
      [roomId, receiverId],
    );
    const line = `${sender.username} sent ${quantity}x ${gift.name} to ${receiver.username}`;
    const systemMessage = await appendSystemChat(roomId, line);

    // The combo window is opened by the server, after the money committed: a send that failed
    // validation advances nobody's counter, and a client cannot hold a window open by re-sending.
    const combo = await countGiftCombo({
      roomId,
      senderId,
      receiverId,
      giftId: gift.id,
      windowMs: gift.comboWindowMs,
      comboEnabled: gift.comboEnabled,
    });

    broadcastGiftAnimated({
      eventId: transaction.id,
      roomId,
      gift,
      sender,
      receiver,
      seatIndex: seatRow?.seat_index ?? null,
      quantity,
      animationUrl: gift.animationUrl,
      totalDiamonds: transaction.amountDiamonds,
      totalRCoins: transaction.amountRCoins,
      lucky,
      comboId: combo.comboId,
      comboCount: combo.count,
      createdAt: transaction.createdAt,
    });
    emitToRoom(roomId, 'room:chat_message', systemMessage);
    // If either room is fighting, the new score goes out now. The 201 does not wait for it: the
    // battle's score is the ledger, and a slow broadcast only makes the board a few hundred
    // milliseconds late, never wrong.
    announceGiftScore(roomId).catch((err) => console.warn('[gift] PK score', err.message));

    // The counter is also answered to the sender, but it is not what animates their own screen:
    // the sender's overlay comes from the broadcast like everyone else's, keyed by the same
    // `transaction.id`, so the reply and the event cannot each start a second copy of one gift.
    res.status(201).json({ transaction, sender, receiver, gift, lucky, replayed: false, combo });
    return;
  }

  // A private gift usually lands while the receiver is somewhere else, so it is
  // the one gift path that needs a notification; an in-room gift is already on
  // their screen. Fire-and-forget: Google being slow must not delay the 201.
  void pushToUser(receiverId, {
    title: `${sender.username} sent you a gift`,
    body: lucky ? `${quantity}x ${gift.name} — ${lucky.headline.label}` : `${quantity}x ${gift.name}`,
    data: { type: 'gift', senderId, giftId },
  });

  // Both parties' balance chips refresh without a round-trip to /api/wallet.
  emitToUser(senderId, 'wallet:update', { diamondBalance: sender.diamondBalance });
  emitToUser(receiverId, 'wallet:update', { rCoinBalance: receiver.rCoinBalance });

  res.status(201).json({ transaction, sender, receiver, gift, lucky, replayed: false });
});

/** The most recent gifts bought in one room, newest first — the reconnect tail for the queue. */
export const roomGifts = asyncHandler(async (req: Request, res: Response) => {
  const roomId = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  const limit = requireInt(req.query.limit ?? 20, 'limit', { min: 1, max: MAX_RECENT_ROOM_GIFTS });
  const room = await one<{ id: string }>('SELECT id FROM rooms WHERE id = $1', [roomId]);
  if (!room) throw ApiError.notFound('Room not found', 'room_not_found');
  res.json({ gifts: await recentRoomGiftEvents(roomId, limit) });
});

/**
 * The caller's own gift receipts, newest first.
 *
 * `/api/wallet` already prints the last 30 ledger rows of every kind, which is enough for a
 * balance screen and useless for a gift history: recharge noise pushes forty gifts off the page,
 * and there is no cursor to ask for the next forty. This is the same join the wallet uses, scoped
 * to GIFT_SENT and paged by the event id the previous page ended on.
 *
 * The cursor is an id, not a timestamp, because a combo buys several gifts inside one millisecond:
 * `created_at < cursor` would skip the siblings that share the boundary, and `(created_at, id) <`
 * walks them in order. A cursor that is not the caller's own row resolves to nothing, so a client
 * cannot read someone else's ledger by naming one of their transaction ids.
 */
export const history = asyncHandler(async (req: Request, res: Response) => {
  const senderId = req.user!.sub;
  const limit = requireInt(req.query.limit ?? 20, 'limit', { min: 1, max: 100 });
  const beforeEvent = optionalString(req.query.before, 'before', 36);
  const receiverId = optionalString(req.query.receiverId, 'receiverId', 36);

  const params: unknown[] = [senderId];
  const where = ['t.sender_id = $1', "t.type = 'GIFT_SENT'"];
  if (beforeEvent) {
    params.push(beforeEvent);
    where.push(`(t.created_at, t.id) < (
        SELECT cursor.created_at, cursor.id FROM transactions cursor
         WHERE cursor.id = $${params.length} AND cursor.sender_id = t.sender_id
      )`);
  }
  if (receiverId) {
    params.push(receiverId);
    where.push(`t.receiver_id = $${params.length}`);
  }
  params.push(limit);

  const rows = await many<TransactionRow & { gift_icon_url: string | null }>(
    `SELECT t.*, g.name AS gift_name, g.icon_url AS gift_icon_url,
            ru.username AS receiver_username, ru.avatar_url AS receiver_avatar_url
       FROM transactions t
       LEFT JOIN gifts g  ON g.id = t.gift_id
       LEFT JOIN users ru ON ru.id = t.receiver_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $${params.length}`,
    params,
  );

  res.json({
    gifts: rows.map((row) => ({
      eventId: row.id,
      quantity: Number(row.quantity),
      diamonds: Number(row.amount_diamonds),
      rCoins: Number(row.amount_r_coins),
      giftId: row.gift_id,
      giftName: row.gift_name,
      giftIconUrl: row.gift_icon_url,
      roomId: row.room_id,
      createdAt: new Date(row.created_at).toISOString(),
      receiver: row.receiver_id
        ? { id: row.receiver_id, username: row.receiver_username ?? 'unknown', avatarUrl: row.receiver_avatar_url ?? null }
        : null,
    })),
    // The id to pass back as `before`; null once the oldest receipt has been reached.
    nextCursor: rows.length === limit ? rows[rows.length - 1]?.id ?? null : null,
  });
});

