import { Request, Response } from 'express';
import { asyncHandler, optionalInt } from '../utils/http';
import {
  agencySelfPosition,
  agencySelfRoster,
  agencySelfSettlements,
  agencySelfSubs,
} from '../services/agency.service';

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
