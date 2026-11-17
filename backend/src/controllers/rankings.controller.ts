import { Request, Response } from 'express';
import {
  claimRankingReward,
  RANKING_BOARDS,
  RANKING_PERIODS,
  rankingBoard,
} from '../services/rankings.service';
import { asyncHandler, requireEnum } from '../utils/http';

/**
 * The landing boards. Public like the room list — a scoreboard names members, not permissions —
 * but a signed-in caller also gets their own row and their podium reward state, which is why the
 * route reads the token when one is present instead of demanding it.
 */
export const board = asyncHandler(async (req: Request, res: Response) => {
  const boardKey = requireEnum(req.query.board ?? 'host', 'board', RANKING_BOARDS);
  const period = requireEnum(req.query.period ?? 'day', 'period', RANKING_PERIODS);
  const settled = req.query.settled === 'true' || req.query.settled === '1';
  res.json(await rankingBoard(req.user?.sub ?? null, boardKey, period, settled));
});

/** Collect a finished period's podium reward. The position is recomputed here, never taken from the body. */
export const claim = asyncHandler(async (req: Request, res: Response) => {
  const boardKey = requireEnum(req.body?.board, 'board', RANKING_BOARDS);
  const period = requireEnum(req.body?.period, 'period', RANKING_PERIODS);
  res.json(await claimRankingReward(req.user!.sub, boardKey, period));
});