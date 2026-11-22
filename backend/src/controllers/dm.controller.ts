import { Request, Response } from 'express';
import {
  listConversations,
  listMessages,
  markRead,
  sendMessage,
} from '../services/friends.service';
import { emitToUser } from '../services/socket.service';
import { pushToUser } from '../services/push.service';
import { asyncHandler, optionalInt, requireString } from '../utils/http';

export const conversations = asyncHandler(async (req: Request, res: Response) => {
  res.json({ conversations: await listConversations(req.user!.sub) });
});

export const messages = asyncHandler(async (req: Request, res: Response) => {
  const partnerId = requireString(req.params.userId, 'userId', { min: 36, max: 36 });
  const page = optionalInt(req.query.page, 'page', { min: 1 }) ?? 1;
  const limit = optionalInt(req.query.limit, 'limit', { min: 1, max: 100 }) ?? 50;
  res.json(await listMessages(req.user!.sub, partnerId, page, limit));
});

export const send = asyncHandler(async (req: Request, res: Response) => {
  const partnerId = requireString(req.params.userId, 'userId', { min: 36, max: 36 });
  const message = await sendMessage(req.user!.sub, partnerId, req.body?.content);
  // Notify the partner live; the sender already has the returned row.
  emitToUser(partnerId, 'dm:message', { message });
  // FCM is a best-effort companion to Socket.IO: never hold the message response open
  // or fail a message that has already been committed because a push provider is down.
  void pushToUser(partnerId, {
    title: 'New Vozia message',
    body: 'Open Vozia to read and reply.',
    data: { type: 'direct_message', partnerId: req.user!.sub },
  }).catch((error: unknown) => {
    console.error('[dm] push delivery failed', error);
  });
  res.status(201).json({ message });
});

export const read = asyncHandler(async (req: Request, res: Response) => {
  const partnerId = requireString(req.params.userId, 'userId', { min: 36, max: 36 });
  res.json(await markRead(req.user!.sub, partnerId));
});