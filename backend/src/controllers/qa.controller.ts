import { Request, Response } from 'express';
import { asyncHandler, optionalEnum, optionalInt, optionalString } from '../utils/http';
import {
  QA_OWNER_KINDS,
  listQaIdentities,
  listQaMoney,
  markQaCohort,
  qaMoneySummary,
  readCohortBody,
  readMarkBody,
  readMoneyQuery,
  setQaMarking,
} from '../services/qa.service';

/**
 * The QA programme's operator surface (migration 0039), mounted under `/api/admin/qa`.
 *
 * Every route here is behind `qa:read` or `qa:manage`; none of them can move a balance. The roster
 * carries phone-free display names and internal references, which is why reading it is a permission
 * of its own rather than a side effect of `user:read`.
 */

const adminId = (req: Request): string => req.admin!.sub;

export const roster = asyncHandler(async (req: Request, res: Response) => {
  res.json(
    await listQaIdentities({
      ownerKind: optionalEnum(req.query?.ownerKind, 'ownerKind', QA_OWNER_KINDS),
      country: optionalString(req.query?.country, 'country', 2),
      search: optionalString(req.query?.search, 'search', 60),
      includeProduction: req.query?.includeProduction === 'true',
      page: optionalInt(req.query?.page, 'page', { min: 1, max: 100_000 }),
      limit: optionalInt(req.query?.limit, 'limit', { min: 1, max: 200 }),
    }),
  );
});

export const mark = asyncHandler(async (req: Request, res: Response) => {
  const body = readMarkBody(req.body ?? {});
  res.json(await setQaMarking(adminId(req), body.ownerKind, body.ownerId, { isTest: body.isTest, qaRef: body.qaRef }));
});

export const markCohort = asyncHandler(async (req: Request, res: Response) => {
  const accounts = readCohortBody(req.body ?? {});
  res.json({ accounts: await markQaCohort(adminId(req), accounts) });
});

export const moneySummary = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await qaMoneySummary());
});

export const money = asyncHandler(async (req: Request, res: Response) => {
  res.json(await listQaMoney(readMoneyQuery((req.query ?? {}) as Record<string, unknown>)));
});