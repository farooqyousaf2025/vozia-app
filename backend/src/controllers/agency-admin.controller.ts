import { Request, Response } from 'express';
import { withTransaction } from '../config/db';
import {
  ApiError,
  asyncHandler,
  optionalEnum,
  optionalInt,
  optionalString,
  requireEnum,
  requireString,
  requireUuid,
} from '../utils/http';
import {
  AGENCY_PAYOUT_METHODS,
  AGENCY_SETTLEMENT_STATUSES,
  AGENCY_STATUSES,
  AgencySettlementDto,
  agencyDetail,
  agencySettlementEntries,
  approveAgencySettlement,
  listAgencies,
  listAgencySettlements,
  payAgencySettlement,
  raiseAgencySettlement,
  setAgencyRate,
  setHostRate,
  voidAgencySettlement,
} from '../services/agency.service';
import { claimIdempotency, completeIdempotency } from '../services/purpose-account.service';

/**
 * The agency desk: what each agency's share is, and the batches that pay it.
 *
 * Reading is `finance:read` because an agency position is a statement about money the platform owes,
 * and any operator who can read the book should be able to answer the agency's question from it.
 * Writing a rate and moving a batch are `commission:manage`, the same permission that decides a BD or
 * seller payout — a rate is that decision taken in advance, for every gift the roster has not sold
 * yet.
 *
 * Money does not move here. The accrual is written by the gift path, and the only route in this file
 * that touches the journal is the one that records a transfer that already happened outside the
 * platform's rails.
 */

const adminId = (req: Request): string => req.admin!.sub;

const RAISE_SCOPE = 'admin:agency:settlement-raise';
const PAY_SCOPE = 'admin:agency:settlement-pay';
const VOID_SCOPE = 'admin:agency:settlement-void';

function page(req: Request): { limit: number; offset: number; page: number } {
  const pageNumber = optionalInt(req.query?.page, 'page', { min: 1 }) ?? 1;
  const limit = optionalInt(req.query?.limit, 'limit', { min: 1, max: 200 }) ?? 25;
  return { limit, offset: (pageNumber - 1) * limit, page: pageNumber };
}

/**
 * A rate, or the decision to inherit one.
 *
 * The field has to be *present*: a PUT that omitted it and changed nothing would leave an operator
 * believing they had cleared an override, which is the opposite of what they meant and invisible in
 * the balance until the next gift.
 */
function rateField(body: Record<string, unknown> | undefined, field: string): number | null {
  if (!body || !(field in body)) throw ApiError.badRequest(`${field} is required: send a number, or null to inherit`, 'rate_required');
  const raw = body[field];
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw ApiError.badRequest(`${field} must be a whole number of basis points, or null`, 'bad_rate');
  }
  if (raw < 0 || raw > 10_000) throw ApiError.badRequest(`${field} must be between 0 and 10000 basis points`, 'bad_rate');
  return raw;
}

function periodField(body: Record<string, unknown> | undefined, field: string): Date {
  const raw = body?.[field];
  if (typeof raw !== 'string' || !raw) throw ApiError.badRequest(`${field} must be an ISO date`, 'bad_date');
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw ApiError.badRequest(`${field} must be an ISO date`, 'bad_date');
  return date;
}

export const agencies = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset, page: pageNumber } = page(req);
  const search = typeof req.query?.search === 'string' && req.query.search.trim() ? req.query.search.trim() : undefined;
  const status = optionalEnum(req.query?.status, 'status', AGENCY_STATUSES);
  const result = await listAgencies({ search, status, limit, offset });
  res.json({ ...result, page: pageNumber, limit });
});

export const agency = asyncHandler(async (req: Request, res: Response) => {
  res.json(await agencyDetail(requireUuid(req.params.id, 'agencyId')));
});

export const putAgencyRate = asyncHandler(async (req: Request, res: Response) => {
  const agencyId = requireUuid(req.params.id, 'agencyId');
  res.json({ agency: await setAgencyRate(adminId(req), agencyId, rateField(req.body, 'commissionBps')) });
});

export const putHostRate = asyncHandler(async (req: Request, res: Response) => {
  const agencyId = requireUuid(req.params.id, 'agencyId');
  const hostUserId = requireUuid(req.params.userId, 'hostUserId');
  res.json({ host: await setHostRate(adminId(req), agencyId, hostUserId, rateField(req.body, 'commissionBps')) });
});

export const settlements = asyncHandler(async (req: Request, res: Response) => {
  const agencyId = req.query?.agencyId ? requireUuid(req.query.agencyId, 'agencyId') : undefined;
  const status = optionalEnum(req.query?.status, 'status', AGENCY_SETTLEMENT_STATUSES);
  const limit = optionalInt(req.query?.limit, 'limit', { min: 1, max: 200 }) ?? 50;
  res.json({ settlements: await listAgencySettlements({ agencyId, status, limit }) });
});

export const settlement = asyncHandler(async (req: Request, res: Response) => {
  res.json(await agencySettlementEntries(requireUuid(req.params.id, 'settlementId')));
});

/**
 * Claim a period's accruals for one payout.
 *
 * The key matters more here than almost anywhere else in the panel: two raises over the same window
 * would each see the other's claims only after the first commits, and an operator who double-clicks
 * on a slow connection would otherwise get one batch and a confusing second refusal rather than one
 * batch and the answer they already had.
 */
export const raiseSettlement = asyncHandler(async (req: Request, res: Response) => {
  const agencyId = requireUuid(req.params.id, 'agencyId');
  const periodFrom = periodField(req.body, 'periodFrom');
  const periodTo = periodField(req.body, 'periodTo');
  const payoutMethod = req.body?.payoutMethod
    ? requireEnum(req.body.payoutMethod, 'payoutMethod', AGENCY_PAYOUT_METHODS)
    : null;
  const key = requireString(req.body?.idempotencyKey, 'idempotencyKey', { max: 80 });

  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, RAISE_SCOPE, key, adminId(req));
    if (claim.replay) return { settlement: claim.response as unknown as AgencySettlementDto, replay: true };

    const created = await raiseAgencySettlement(adminId(req), { agencyId, periodFrom, periodTo, payoutMethod });
    await completeIdempotency(client, RAISE_SCOPE, key, created.id, created as unknown as Record<string, unknown>);
    return { settlement: created, replay: false };
  });
  res.status(result.replay ? 200 : 201).json(result);
});

export const approveSettlement = asyncHandler(async (req: Request, res: Response) => {
  const id = requireUuid(req.params.id, 'settlementId');
  res.json({ settlement: await approveAgencySettlement(adminId(req), id) });
});

/** Record the transfer. Needs the reference that proves it, and it is the only route here that writes a journal line. */
export const paySettlement = asyncHandler(async (req: Request, res: Response) => {
  const id = requireUuid(req.params.id, 'settlementId');
  const payoutReference = requireString(req.body?.payoutReference, 'payoutReference', { min: 3, max: 120 });
  const payoutMethod = req.body?.payoutMethod
    ? requireEnum(req.body.payoutMethod, 'payoutMethod', AGENCY_PAYOUT_METHODS)
    : null;
  const note = optionalString(req.body?.note, 'note', 200) ?? null;
  const key = requireString(req.body?.idempotencyKey, 'idempotencyKey', { max: 80 });

  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, PAY_SCOPE, key, adminId(req));
    if (claim.replay) return { settlement: claim.response as unknown as AgencySettlementDto, replay: true };

    const paid = await payAgencySettlement(adminId(req), id, { payoutReference, payoutMethod, note });
    await completeIdempotency(client, PAY_SCOPE, key, id, paid as unknown as Record<string, unknown>);
    return { settlement: paid, replay: false };
  });
  // 200, not 201: this describes a transfer that already happened outside the platform's rails, and
  // neither a first attempt nor a replay creates a resource.
  res.json(result);
});

export const voidSettlement = asyncHandler(async (req: Request, res: Response) => {
  const id = requireUuid(req.params.id, 'settlementId');
  const reason = requireString(req.body?.reason, 'reason', { min: 8, max: 200 });
  const key = requireString(req.body?.idempotencyKey, 'idempotencyKey', { max: 80 });

  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, VOID_SCOPE, key, adminId(req));
    if (claim.replay) return { settlement: claim.response as unknown as AgencySettlementDto, replay: true };

    const voided = await voidAgencySettlement(adminId(req), id, reason);
    await completeIdempotency(client, VOID_SCOPE, key, id, voided as unknown as Record<string, unknown>);
    return { settlement: voided, replay: false };
  });
  res.json(result);
});
