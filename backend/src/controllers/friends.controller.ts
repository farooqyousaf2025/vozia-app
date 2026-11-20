import { Request, Response } from 'express';
import {
  acceptFriendRequest,
  declineFriendRequest,
  listFriendRequests,
  listFriends,
  sendFriendRequest,
  setDoNotContact,
  unfriend,
} from '../services/friends.service';
import { emitToUser } from '../services/socket.service';
import { asyncHandler, optionalInt, requireString } from '../utils/http';

export const sendRequest = asyncHandler(async (req: Request, res: Response) => {
  const targetId = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const request = await sendFriendRequest(req.user!.sub, targetId);
  emitToUser(targetId, 'friend:request', { request });
  res.status(201).json({ request });
});

export const requests = asyncHandler(async (req: Request, res: Response) => {
  const direction = req.query.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const page = optionalInt(req.query.page, 'page', { min: 1 }) ?? 1;
  const limit = optionalInt(req.query.limit, 'limit', { min: 1, max: 100 }) ?? 20;
  res.json(await listFriendRequests(req.user!.sub, direction, page, limit));
});

export const accept = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'requestId', { min: 36, max: 36 });
  const result = await acceptFriendRequest(id, req.user!.sub);
  res.json(result);
});

export const decline = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'requestId', { min: 36, max: 36 });
  const result = await declineFriendRequest(id, req.user!.sub);
  res.json(result);
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const page = optionalInt(req.query.page, 'page', { min: 1 }) ?? 1;
  const limit = optionalInt(req.query.limit, 'limit', { min: 1, max: 100 }) ?? 50;
  res.json(await listFriends(req.user!.sub, page, limit));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const targetId = requireString(req.params.userId, 'userId', { min: 36, max: 36 });
  res.json(await unfriend(req.user!.sub, targetId));
});

export const doNotContact = asyncHandler(async (req: Request, res: Response) => {
  const targetId = requireString(req.params.userId, 'userId', { min: 36, max: 36 });
  const value = req.method === 'DELETE' ? false : req.body?.value !== false;
  res.json(await setDoNotContact(req.user!.sub, targetId, value));
});