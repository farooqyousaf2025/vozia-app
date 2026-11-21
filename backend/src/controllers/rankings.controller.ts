import { Request, Response } from 'express';
import {
  claimRankingReward,
  RANKING_BOARDS,
  RANKING_PERIODS,
  rankingBoard,
} from '../services/rankings.service';
import { ApiError, asyncHandler, optionalInt, optionalString, requireEnum } from '../utils/http';
import { discoveryRanking, type DiscoveryKind } from '../services/discovery-rankings.service';

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

/** Live discovery podiums, separate from financial reward boards. */
export const discovery = asyncHandler(async (req: Request, res: Response) => {
  const kind = requireEnum(req.query.kind ?? 'rooms', 'kind', ['rooms', 'hosts', 'agencies'] as const) as DiscoveryKind;
  const rawRegion = optionalString(req.query.region, 'region', 2);
  const region = rawRegion?.toUpperCase() ?? null;
  if (region && !/^[A-Z]{2}$/.test(region)) {
    throw ApiError.badRequest('region must be a two-letter ISO country code', 'region_invalid');
  }
  const limit = optionalInt(req.query.limit, 'limit', { min: 1, max: 50 }) ?? 20;
  res.json(await discoveryRanking(kind, region, limit));
});

/** Collect a finished period's podium reward. The position is recomputed here, never taken from the body. */
export const claim = asyncHandler(async (req: Request, res: Response) => {
  const boardKey = requireEnum(req.body?.board, 'board', RANKING_BOARDS);
  const period = requireEnum(req.body?.period, 'period', RANKING_PERIODS);
  res.json(await claimRankingReward(req.user!.sub, boardKey, period));
});