import { Request, Response } from 'express';
import { ApiError, asyncHandler, optionalString, requireInt, requireString } from '../utils/http';
import { BusinessAccountDto, toBusinessAccount, toRechargePackage } from '../utils/serialize';
import { BUSINESS_KIND_PERMISSIONS } from '../services/rbac.service';
import { BusinessAccountRow, RechargeOrderStatus } from '../types/db';
import { changeOwnBusinessPassword, listSellersForBd, loginBusinessAccount } from '../services/business.service';
import {
  MANUAL_RAILS,
  cancelOrder,
  createRechargeOrder,
  listPackagesForSeller,
  listRechargeOrders,
  lookupCustomer,
  markOrderPaid,
  rechargeStats,
} from '../services/seller-recharge.service';
import { commissionSummary, listCommissionEntries, listCommissionSettlements } from '../services/commission.service';

/**
 * The BD / coin-seller surface (§21, §22).
 *
 * Nothing here takes an identity from the request body. `requireBusiness` has already read the
 * caller's account row, so "whose orders", "whose territory" and "whose statement" are derived
 * from the credential — a partner cannot ask for another partner's book even by guessing an id,
 * and no route here resolves outside its own scope.
 */

const uuid = (value: unknown, field: string): string => requireString(value, field, { min: 36, max: 36 });

function account(req: Request): BusinessAccountRow {
  const row = req.businessRow;
  if (!row) throw ApiError.unauthorized('Business account required');
  return row;
}

function pageAndLimit(req: Request): { page: number; limit: number; offset: number } {
  const page = requireInt(req.query?.page ?? 1, 'page', { min: 1, max: 100_000 });
  const limit = requireInt(req.query?.limit ?? 25, 'limit', { min: 1, max: 200 });
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * Scope filter for the caller's kind: a seller sees its own orders, a BD sees every order whose
 * `seller_id` sits anywhere inside its territory. Nothing else has a path in.
 */
function scope(req: Request): { sellerId?: string; bdTerritoryId?: string } {
  const caller = account(req);
  return caller.kind === 'COIN_SELLER' ? { sellerId: caller.id } : { bdTerritoryId: caller.id };
}

export const login = asyncHandler(async (req: Request, res: Response) => {
  const code = requireString(req.body?.code, 'code', { max: 24 });
  const password = requireString(req.body?.password, 'password', { max: 200 });
  const { token, account: signedIn } = await loginBusinessAccount(code, password);
  res.json({ token, account: signedIn });
});

export const whoami = asyncHandler(async (req: Request, res: Response) => {
  const caller = account(req);
  res.json({
    account: toBusinessAccount(caller),
    permissions: BUSINESS_KIND_PERMISSIONS[caller.kind],
    paymentRails: MANUAL_RAILS,
  });
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  await changeOwnBusinessPassword(
    account(req).id,
    requireString(req.body?.currentPassword, 'currentPassword', { max: 200 }),
    requireString(req.body?.newPassword, 'newPassword', { min: 8, max: 200 }),
  );
  res.json({ changed: true });
});

export const packages = asyncHandler(async (req: Request, res: Response) => {
  const caller = account(req);
  // A BD sells nothing; it reads its sellers' numbers. The catalog is only ever offered to the
  // account that will be asked to move the money.
  const rows = caller.kind === 'COIN_SELLER' ? await listPackagesForSeller(caller.id) : [];
  res.json({ packages: rows.map(toRechargePackage) });
});

export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  const order = await createRechargeOrder(account(req), {
    phone: requireString(req.body?.phone, 'phone', { max: 24 }),
    packageKey: requireString(req.body?.packageKey, 'packageKey', { max: 48 }),
    paymentMethod: requireString(req.body?.paymentMethod, 'paymentMethod', { max: 24 }),
    note: optionalString(req.body?.note, 'note', 200),
  });
  res.status(201).json({ order });
});

export const orders = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, offset } = pageAndLimit(req);
  const result = await listRechargeOrders({
    ...scope(req),
    status: optionalString(req.query?.status, 'status', 24) as RechargeOrderStatus | undefined,
    search: optionalString(req.query?.search, 'search', 60),
    limit,
    offset,
  });
  res.json({ ...result, page, limit });
});

export const showOrder = asyncHandler(async (req: Request, res: Response) => {
  // Read through the same scoped query as the list, so a guessed order id that belongs to
  // someone else answers 404 rather than confirming it exists.
  const { orders: found } = await listRechargeOrders({ ...scope(req), orderId: uuid(req.params.id, 'id'), limit: 1, offset: 0 });
  if (!found.length) throw ApiError.notFound('Recharge order not found');
  res.json({ order: found[0] });
});

export const markPaid = asyncHandler(async (req: Request, res: Response) => {
  const order = await markOrderPaid(account(req), uuid(req.params.id, 'id'), {
    paymentRef: requireString(req.body?.paymentRef, 'paymentRef', { min: 4, max: 120 }),
    evidence: (req.body?.evidence ?? {}) as Record<string, unknown>,
  });
  res.json({ order });
});

export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const order = await cancelOrder(
    account(req),
    uuid(req.params.id, 'id'),
    requireString(req.body?.reason, 'reason', { min: 3, max: 200 }),
  );
  res.json({ order });
});

export const customerLookup = asyncHandler(async (req: Request, res: Response) => {
  res.json({ customer: await lookupCustomer(account(req), requireString(req.query?.phone, 'phone', { max: 24 })) });
});

export const dashboard = asyncHandler(async (req: Request, res: Response) => {
  const caller = account(req);
  const [stats, summary, sellers] = await Promise.all([
    rechargeStats(scope(req)),
    commissionSummary(caller.id),
    caller.kind === 'COIN_SELLER' ? Promise.resolve([] as BusinessAccountDto[]) : listSellersForBd(caller.id),
  ]);
  res.json({
    account: toBusinessAccount(caller),
    recharge: stats,
    commission: summary,
    // §22's "available commission balance": accrued and not yet paid out in a settlement batch.
    availableCommissionCents: summary.accruedCents,
    sellers,
  });
});

export const sellerRoster = asyncHandler(async (req: Request, res: Response) => {
  const rows = await listSellersForBd(account(req).id);
  res.json({
    sellers: await Promise.all(
      rows.map(async (seller) => ({ ...seller, recharge: await rechargeStats({ sellerId: seller.id }) })),
    ),
  });
});

/** One seller's book, visible to the BD that owns it: numbers, commission, orders. */
export const sellerReport = asyncHandler(async (req: Request, res: Response) => {
  const sellerId = uuid(req.params.id, 'id');
  const territory = await listSellersForBd(account(req).id);
  const seller = territory.find((row) => row.id === sellerId);
  if (!seller) throw ApiError.notFound('Seller is not in this account’s territory');

  const { page, limit, offset } = pageAndLimit(req);
  const [ordersResult, entries, summary, settlements] = await Promise.all([
    listRechargeOrders({ sellerId, limit, offset }),
    listCommissionEntries({ beneficiaryId: sellerId, limit, offset }),
    commissionSummary(sellerId),
    listCommissionSettlements({ beneficiaryId: sellerId, limit: 20 }),
  ]);
  res.json({
    seller,
    recharge: await rechargeStats({ sellerId }),
    commission: summary,
    entries: entries.entries,
    settlements,
    orders: ordersResult.orders,
    page,
    limit,
  });
});

/** A partner's statement: its own commission lines and its own settlement batches. */
export const statement = asyncHandler(async (req: Request, res: Response) => {
  const caller = account(req);
  const { page, limit, offset } = pageAndLimit(req);
  const [entries, summary, settlements] = await Promise.all([
    listCommissionEntries({ beneficiaryId: caller.id, limit, offset }),
    commissionSummary(caller.id),
    listCommissionSettlements({ beneficiaryId: caller.id, limit: 50 }),
  ]);
  const report = {
    account: toBusinessAccount(caller),
    summary,
    entries: entries.entries,
    total: entries.total,
    settlements,
    page,
    limit,
  };
  if (req.query?.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${caller.code}-statement.csv"`);
    res.send(statementCsv(report));
    return;
  }
  res.json(report);
});

const csvCell = (value: string): string => `"${value.replace(/"/g, '""')}"`;

function statementCsv(report: {
  summary: { accruedCents: number; settledCents: number; reversedCents: number; currency: string };
  entries: Array<Record<string, unknown>>;
  settlements: Array<Record<string, unknown>>;
}): string {
  const row = (cells: string[]): string => cells.map(csvCell).join(',');
  const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
  const lines = [
    row(['section', 'reference', 'date', 'order', 'kind', 'status', 'basis_cents', 'amount_cents', 'currency', 'settled_at', 'period_from', 'period_to', 'note']),
    ...report.entries.map((entry) =>
      row([
        'entry',
        text(entry.id),
        text(entry.createdAt),
        text(entry.orderReference),
        text(entry.kind),
        text(entry.status),
        text(entry.basisCents),
        text(entry.amountCents),
        text(entry.currency),
        text(entry.settledAt),
        '',
        '',
        text(entry.reversalReason),
      ]),
    ),
    ...report.settlements.map((batch) =>
      row([
        'settlement',
        text(batch.reference),
        text(batch.createdAt),
        '',
        text(batch.beneficiary),
        text(batch.status),
        '',
        text(batch.amountCents),
        text(batch.currency),
        text(batch.paidAt),
        text(batch.periodFrom),
        text(batch.periodTo),
        text(batch.note),
      ]),
    ),
    row(['total', '', '', '', '', '', '', String(report.summary.accruedCents), report.summary.currency, '', '', '', 'accrued']),
    row(['total', '', '', '', '', '', '', String(report.summary.settledCents), report.summary.currency, '', '', '', 'settled']),
    row(['total', '', '', '', '', '', '', String(report.summary.reversedCents), report.summary.currency, '', '', '', 'reversed']),
  ];
  return lines.join('\n');
}
