import { Request, Response } from 'express';
import { checkIn, questsForToday } from '../services/quest.service';
import { asyncHandler } from '../utils/http';

/**
 * `/api/quests` — the member's own daily activity (migration 0020).
 *
 * Both routes are authenticated and per-member. Neither accepts a progress value, a reward or an
 * experience total: progress is written by `quest.service` from server-side events, and the only
 * thing a member can do here is ask what today looks like and check in.
 */

export const today = asyncHandler(async (req: Request, res: Response) => {
  res.json(await questsForToday(req.user!.sub));
});

/** 201 because experience moved; the response carries the refreshed wallet and the new status. */
export const checkInEndpoint = asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json(await checkIn(req.user!.sub));
});
