import { Request, Response } from 'express';
import { rankLadder } from '../services/rank.service';
import { asyncHandler } from '../utils/http';

/**
 * `GET /api/ranks` — the level ladder as the operator set it today: rung numbers, names, badge
 * URLs, colours and the experience each one unlocks at.
 *
 * Public like `GET /api/emoji` and `GET /api/rooms/themes`: it carries no member data, only which
 * art and which thresholds the platform is showing. A phone needs it to draw the ladder a member
 * is climbing (the profile's level sheet); everything about a *particular* person's rung already
 * arrives inside that person's own DTO, resolved server-side.
 */
export const ladder = asyncHandler(async (_req: Request, res: Response) => {
  res.json(rankLadder());
});
