import { Request, Response } from 'express';
import { asyncHandler, optionalInt } from '../utils/http';
import {
  agencySelfPosition,
  agencySelfRoster,
  agencySelfHostActivity,
  agencySelfSettlements,
  agencySelfSubs,
} from '../services/agency.service';
import { listAgencyActiveRooms } from '../services/agency-room-moderation.service';

/**
 * An agency's own book, read by the member who runs it.
 *
 * There is no agency id in any of these paths. `requireAgencyOwner` resolves the caller's agency from
 * `agencies.owner_user_id`, so the only agency a member can ask about is the one they own — a uuid
 * pasted into a URL reaches nothing, which is the whole of the authorisation design here.
 */

const agencyId = (req: Request): string => req.agencyRow!.id;

export const position = asyncHandler(async (req: Request, res: Response) => {
  res.json({ agency: await agencySelfPosition(agencyId(req)) });
});

export const hostActivity = asyncHandler(async (req: Request, res: Response) => {
  const days = optionalInt(req.query?.days, 'days', { min: 7, max: 30 }) ?? 7;
  if (days !== 7 && days !== 30) {
    res.status(400).json({ error: 'days must be 7 or 30' });
    return;
  }
  res.json({ report: await agencySelfHostActivity(agencyId(req), days) });
});

export const hosts = asyncHandler(async (req: Request, res: Response) => {
  const limit = optionalInt(req.query?.limit, 'limit', { min: 1, max: 200 }) ?? 50;
  res.json({ hosts: await agencySelfRoster(agencyId(req), limit) });
});

/** Master-only. A sub-agency reaches this route and is refused by `requireMasterAgency`. */
export const subAgencies = asyncHandler(async (req: Request, res: Response) => {
  res.json({ subAgencies: await agencySelfSubs(agencyId(req)) });
});

export const settlements = asyncHandler(async (req: Request, res: Response) => {
  const limit = optionalInt(req.query?.limit, 'limit', { min: 1, max: 100 }) ?? 25;
  res.json({ settlements: await agencySelfSettlements(agencyId(req), limit) });
});


export const rooms = asyncHandler(async (req: Request, res: Response) => {
  res.json({ rooms: await listAgencyActiveRooms(req.user!.sub, agencyId(req)) });
});
