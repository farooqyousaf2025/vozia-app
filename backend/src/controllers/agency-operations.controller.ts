import { Request, Response } from 'express';
import { ApiError, asyncHandler, optionalInt, requireUuid } from '../utils/http';
import { agencyOperationsAudit, agencyOperationsReport } from '../services/agency-operations.service';

export const operations = asyncHandler(async (req: Request, res: Response) => {
  const windowDays = optionalInt(req.query?.days, 'days', { min: 7, max: 30 }) ?? 30;
  const inactiveDays = optionalInt(req.query?.inactiveDays, 'inactiveDays', { min: 7, max: 30 }) ?? 7;
  if (windowDays !== 7 && windowDays !== 30) {
    throw ApiError.badRequest('days must be 7 or 30', 'invalid_report_window');
  }
  if (inactiveDays !== 7 && inactiveDays !== 14 && inactiveDays !== 30) {
    throw ApiError.badRequest('inactiveDays must be 7, 14 or 30', 'invalid_inactivity_window');
  }
  const agencyLimit = optionalInt(req.query?.agencyLimit, 'agencyLimit', { min: 1, max: 500 }) ?? 200;
  const hostLimit = optionalInt(req.query?.hostLimit, 'hostLimit', { min: 1, max: 1000 }) ?? 500;
  res.json(await agencyOperationsReport({ windowDays, inactiveDays, agencyLimit, hostLimit }));
});

export const audit = asyncHandler(async (req: Request, res: Response) => {
  const agencyId = requireUuid(req.params.id, 'agencyId');
  const limit = optionalInt(req.query?.limit, 'limit', { min: 1, max: 100 }) ?? 50;
  res.json({ entries: await agencyOperationsAudit(agencyId, limit) });
});
