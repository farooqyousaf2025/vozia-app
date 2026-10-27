import { Request, Response } from 'express';
import {
  cancelSession,
  createSession,
  joinSession,
  leaveSession,
  listDefinitions,
  listRoomSessions,
  listUserHistory,
  raiseDispute,
  setReady,
  startSession,
  submitAction,
  loadSession,
} from '../services/game.service';
import { GameAction } from '../games/types';
import { ApiError, asyncHandler, requireInt, requireString } from '../utils/http';

/**
 * Game HTTP surface.
 *
 * Every route here is a thin validation layer over the engine: the money, the seats, the
 * timers and the winners are decided in `game.service`, and nothing in this file is
 * allowed to compute any of them from what the client sent.
 */

const id = (value: unknown, field: string): string => requireString(value, field, { min: 36, max: 36 });

export const catalog = asyncHandler(async (req: Request, res: Response) => {
  const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : undefined;
  if (roomId) {
    res.json({ sessions: await listRoomSessions(id(roomId, 'roomId')), games: await listDefinitions({ activeOnly: true }) });
    return;
  }
  res.json({ games: await listDefinitions({ activeOnly: true }) });
});

export const history = asyncHandler(async (req: Request, res: Response) => {
  const limit = requireInt(req.query?.limit ?? 20, 'limit', { min: 1, max: 100 });
  res.json({ games: await listUserHistory(req.user!.sub, limit) });
});

export const show = asyncHandler(async (req: Request, res: Response) => {
  res.json({ session: await loadSession(id(req.params.id, 'id')) });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const session = await createSession(req.user!.sub, {
    gameKey: requireString(req.body?.gameKey, 'gameKey', { max: 32 }),
    roomId: id(req.body?.roomId, 'roomId'),
  });
  res.status(201).json({ session });
});

export const join = asyncHandler(async (req: Request, res: Response) => {
  res.json({ session: await joinSession(req.user!.sub, id(req.params.id, 'id')) });
});

export const ready = asyncHandler(async (req: Request, res: Response) => {
  res.json({ session: await setReady(req.user!.sub, id(req.params.id, 'id')) });
});

export const start = asyncHandler(async (req: Request, res: Response) => {
  res.json({ session: await startSession(req.user!.sub, id(req.params.id, 'id')) });
});

/**
 * A move. The action envelope is the only thing the client controls, and its payload is
 * re-validated by the game's own driver — a body that claims a win, a dice value or a
 * score simply has no field the engine reads for those.
 */
export const act = asyncHandler(async (req: Request, res: Response) => {
  const type = requireString(req.body?.type, 'type', { max: 32 }).toUpperCase();
  const payload = (req.body?.payload ?? {}) as Record<string, unknown>;
  if (typeof payload !== 'object' || Array.isArray(payload)) throw ApiError.badRequest('payload must be an object');
  const action: GameAction = { type, payload };
  res.json({ session: await submitAction(req.user!.sub, id(req.params.id, 'id'), action) });
});

export const leave = asyncHandler(async (req: Request, res: Response) => {
  res.json({ session: await leaveSession(req.user!.sub, id(req.params.id, 'id')) });
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const reason = requireString(req.body?.reason ?? 'Cancelled by host', 'reason', { max: 200 });
  res.json({ session: await cancelSession(req.user!.sub, id(req.params.id, 'id'), reason) });
});

export const dispute = asyncHandler(async (req: Request, res: Response) => {
  const created = await raiseDispute(req.user!.sub, id(req.params.id, 'id'), requireString(req.body?.reason, 'reason', { max: 500 }));
  res.status(201).json({ dispute: created });
});
