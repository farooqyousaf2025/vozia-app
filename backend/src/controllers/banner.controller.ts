import { Request, Response } from 'express';
import {
  BANNER_PLACEMENTS,
  listLiveBanners,
  recordBannerEvent,
} from '../services/banner.service';
import {
  asyncHandler,
  optionalEnum,
  requireEnum,
  requireUuid,
} from '../utils/http';

/**
 * `GET /api/banners` — the live campaigns for one surface, or for all four.
 *
 * Public like `GET /api/emoji` and `GET /api/ranks`: a banner carries no member data, only which art
 * the platform is currently showing and what it invites the member to do — and the splash is drawn
 * before a signed-out member has anything to authenticate with.
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  const placement = optionalEnum(req.query.placement, 'placement', BANNER_PLACEMENTS) ?? null;
  res.json({ banners: await listLiveBanners(placement) });
});

const BANNER_EVENTS = ['IMPRESSION', 'TAP'] as const;

/**
 * `POST /api/banners/track` — one counted look at, or one tap on, a banner.
 *
 * Authenticated, even though the read is public: these two columns are the only answer to "did that
 * campaign work", and an endpoint any script can call is an endpoint no operator can believe. A row
 * that is not live right now answers 404 rather than quietly accepting a count nobody will read.
 */
export const track = asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = requireUuid(body.id, 'id');
  const event = requireEnum(body.event, 'event', BANNER_EVENTS);
  await recordBannerEvent(id, event);
  res.json({ ok: true });
});
