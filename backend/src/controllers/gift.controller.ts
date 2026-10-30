import { Request, Response } from 'express';
import { one } from '../config/db';
import { RoomRow, UserRow } from '../types/db';
import { ApiError, asyncHandler, optionalString, requireInt, requireString } from '../utils/http';
import { sendGift } from '../services/ledger.service';
import { appendSystemChat } from '../services/room.service';
import { listGifts } from '../services/admin.service';
import { broadcastGiftAnimated, emitToRoom, emitToUser } from '../services/socket.service';
import { announceGiftScore } from '../services/pk.service';
import { pushToUser } from '../services/push.service';

export const catalog = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ gifts: await listGifts() });
});

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

  if (roomId) {
    const room = await one<RoomRow>('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (!room) throw ApiError.notFound('Room not found', 'room_not_found');
    if (room.status !== 'ACTIVE') throw ApiError.conflict('This room is closed', 'room_closed');
  } else {
    const receiver = await one<UserRow>('SELECT id FROM users WHERE id = $1', [receiverId]);
    if (!receiver) throw ApiError.notFound('Receiver not found');
  }

  const result = await sendGift({ senderId, receiverId, giftId, quantity, roomId });
  const { transaction, sender, receiver, gift } = result;

  if (roomId) {
    const seatRow = await one<{ seat_index: number }>(
      'SELECT seat_index FROM room_seats WHERE room_id = $1 AND user_id = $2',
      [roomId, receiverId],
    );
    const line = `${sender.username} sent ${quantity}x ${gift.name} to ${receiver.username}`;
    const systemMessage = await appendSystemChat(roomId, line);

    broadcastGiftAnimated({
      roomId,
      gift,
      sender,
      receiver,
      seatIndex: seatRow?.seat_index ?? null,
      quantity,
      animationUrl: gift.animationUrl,
      totalDiamonds: transaction.amountDiamonds,
      totalRCoins: transaction.amountRCoins,
    });
    emitToRoom(roomId, 'room:chat_message', systemMessage);
    // If either room is fighting, the new score goes out now. The 201 does not wait for it: the
    // battle's score is the ledger, and a slow broadcast only makes the board a few hundred
    // milliseconds late, never wrong.
    announceGiftScore(roomId).catch((err) => console.warn('[gift] PK score', err.message));
  } else {
    // A private gift usually lands while the receiver is somewhere else, so it is
    // the one gift path that needs a notification; an in-room gift is already on
    // their screen. Fire-and-forget: Google being slow must not delay the 201.
    void pushToUser(receiverId, {
      title: `${sender.username} sent you a gift`,
      body: `${quantity}x ${gift.name}`,
      data: { type: 'gift', senderId, giftId },
    });
  }

  // Both parties' balance chips refresh without a round-trip to /api/wallet.
  emitToUser(senderId, 'wallet:update', { diamondBalance: sender.diamondBalance });
  emitToUser(receiverId, 'wallet:update', { rCoinBalance: receiver.rCoinBalance });

  res.status(201).json({ transaction, sender, receiver, gift });
});
