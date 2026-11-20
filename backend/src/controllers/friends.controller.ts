import { Request, Response } from 'express';
import {
  acceptFriendRequest,
  declineFriendRequest,
  listFriendRequests,
  listFriends,
  sendFriendRequest,
  setDoNotContact,
  unfriend,
  setFriendLocationSharing,
  updateOwnFriendLocation,
  listFriendDistances,
  getFriendLocationSharing,
} from '../services/friends.service';
import { emitToUser } from '../services/socket.service';
import { asyncHandler, optionalInt, requireString } from '../utils/http';
import { ApiError } from '../utils/http';

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
export const locationSharing = asyncHandler(async (req: Request, res: Response) => {
  if (typeof req.body?.enabled !== 'boolean') throw ApiError.badRequest('enabled must be boolean', 'invalid_location_sharing');
  res.json(await setFriendLocationSharing(req.user!.sub, req.body.enabled));
});
export const updateLocation = asyncHandler(async (req: Request, res: Response) => {
  const latitude = Number(req.body?.latitude);
  const longitude = Number(req.body?.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw ApiError.badRequest('Valid latitude and longitude are required', 'invalid_location');
  }
  res.json(await updateOwnFriendLocation(req.user!.sub, latitude, longitude));
});
export const locations = asyncHandler(async (req: Request, res: Response) => {
  res.json({ locations: await listFriendDistances(req.user!.sub) });
});

export const locationSharingStatus = asyncHandler(async (req: Request, res: Response) => {
  res.json(await getFriendLocationSharing(req.user!.sub));
});
