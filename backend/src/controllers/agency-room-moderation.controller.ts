import { Request, Response } from 'express';
import { asyncHandler, optionalInt, optionalString, requireBoolean, requireString } from '../utils/http';
import { agencyBanRoomMember, agencyKickRoomMember, agencyMuteRoomMember, agencyUnbanRoomMember, listAgencyRoomModerationAudit } from '../services/agency-room-moderation.service';
import { broadcastSeatUpdate, emitToUser } from '../services/socket.service';

const roomId = (req: Request) => requireString(req.params.id, 'roomId', { min: 36, max: 36 });
const targetId = (req: Request) => requireString(req.params.userId, 'userId', { min: 36, max: 36 });

export const muteMember = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const target = requireString(req.body?.userId, 'userId', { min: 36, max: 36 });
  const muted = requireBoolean(req.body?.muted, 'muted');
  const result = await agencyMuteRoomMember(req.user!.sub, id, target, muted);
  await broadcastSeatUpdate(id);
  res.json(result);
});

export const kickMember = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const target = targetId(req);
  const reason = optionalString(req.body?.reason, 'reason', 200);
  const result = await agencyKickRoomMember(req.user!.sub, id, target, reason);
  emitToUser(target, 'room:kicked', { roomId: id, reason: reason ?? 'Removed by agency moderator' });
  await broadcastSeatUpdate(id);
  res.json(result);
});

export const banMember = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const target = targetId(req);
  const reason = optionalString(req.body?.reason, 'reason', 200);
  const minutes = optionalInt(req.body?.minutes, 'minutes', { min: 1, max: 525600 });
  const result = await agencyBanRoomMember(req.user!.sub, id, target, reason, minutes);
  emitToUser(target, 'room:kicked', { roomId: id, reason: reason ?? 'Banned by agency moderator' });
  await broadcastSeatUpdate(id);
  res.json(result);
});

export const unbanMember = asyncHandler(async (req: Request, res: Response) => {
  res.json(await agencyUnbanRoomMember(req.user!.sub, roomId(req), targetId(req)));
});

export const moderationAudit = asyncHandler(async (req: Request, res: Response) => {
  const limit = optionalInt(req.query?.limit, 'limit', { min: 1, max: 100 }) ?? 50;
  res.json({ entries: await listAgencyRoomModerationAudit(req.user!.sub, roomId(req), limit) });
});
