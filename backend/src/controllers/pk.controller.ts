import { Request, Response } from 'express';
import {
  acceptBattle,
  battleById,
  battleForRoom,
  battleHistoryForRoom,
  cancelBattle,
  declineBattle,
  inviteBattle,
  readPkSettings,
} from '../services/pk.service';
import { asyncHandler, optionalInt, requireUuid } from '../utils/http';

/**
 * `/api/pk` — head-to-head gift races between two rooms (migration 0021).
 *
 * Every route that changes something is host-only and is checked against `rooms.host_id` by the
 * service, not against anything the caller sends. No route accepts a score, a winner or an
 * experience value: the score is summed from the same `transactions` rows that moved the
 * diamonds, and the prize is paid by settlement.
 */

export const roomBattle = asyncHandler(async (req: Request, res: Response) => {
  const roomId = requireUuid(req.params.roomId, 'roomId');
  res.json({ battle: await battleForRoom(roomId) });
});

/**
 * The dials a member is allowed to know: the duration range the invitation form must offer, and
 * whether battles are on at all. The prize and the timeout are here too — they are printed on the
 * invitation, so hiding them would only make the phone read the wrong numbers.
 */
export const settings = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ settings: await readPkSettings() });
});

export const battle = asyncHandler(async (req: Request, res: Response) => {
  const id = requireUuid(req.params.id, 'battleId');
  res.json({ battle: await battleById(id) });
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  const roomId = requireUuid(req.params.roomId, 'roomId');
  const limit = optionalInt(req.query.limit, 'limit', { min: 1, max: 50 });
  res.json({ battles: await battleHistoryForRoom(roomId, limit ?? 10) });
});

export const invite = asyncHandler(async (req: Request, res: Response) => {
  const roomId = requireUuid(req.body?.roomId, 'roomId');
  const opponentRoomId = requireUuid(req.body?.opponentRoomId, 'opponentRoomId');
  // The duration is validated against the operator's range inside the service; anything else on
  // the body is ignored.
  const result = await inviteBattle(req.user!.sub, roomId, opponentRoomId, req.body?.durationSeconds);
  res.status(201).json({ battle: result });
});

export const accept = asyncHandler(async (req: Request, res: Response) => {
  const id = requireUuid(req.params.id, 'battleId');
  res.json({ battle: await acceptBattle(req.user!.sub, id) });
});

export const decline = asyncHandler(async (req: Request, res: Response) => {
  const id = requireUuid(req.params.id, 'battleId');
  res.json({ battle: await declineBattle(req.user!.sub, id) });
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const id = requireUuid(req.params.id, 'battleId');
  res.json({ battle: await cancelBattle(req.user!.sub, id) });
});
