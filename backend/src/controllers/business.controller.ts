import { Request, Response } from 'express';
import { rateLimit } from '../config/redis';
import { ApiError, asyncHandler, optionalString, optionalUuid, requireInt, requireString } from '../utils/http';
import { BusinessAccountDto, toBusinessAccount, toRechargePackage } from '../utils/serialize';
import { BUSINESS_KIND_PERMISSIONS } from '../services/rbac.service';
import { BusinessAccountRow, RechargeOrderStatus } from '../types/db';
import { changeOwnBusinessPassword, listSellersForBd, loginBusinessAccount } from '../services/business.service';
import {
  MANUAL_RAILS,
  SellerCashBook,
  cancelOrder,
  createRechargeOrder,
  listPackagesForSeller,
  listRechargeOrders,
  lookupCustomer,
  markOrderPaid,
  rechargeStats,
  sellerCashBook,
} from '../services/seller-recharge.service';
import { commissionSummary, listCommissionEntries, listCommissionSettlements } from '../services/commission.service';
import { decodeUploadPayload } from '../services/media.service';
import { getPayoutForSeller, listPayoutsForSeller } from '../services/payout.service';
import { readReceiptForSeller, safeDownloadName, saveReceipt } from '../services/receipt.service';

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
  // Same reasoning as the operator console: a seller/BD code is a stable identifier and the password
  // behind it does not rotate, so the guess ceiling has to live here.
  const allowed = await rateLimit(`business-login:${req.ip}:${code}`, 10, 60);
  if (allowed === -1) throw ApiError.tooManyRequests('Too many sign-in attempts. Try again in a minute.');
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

/**
 * Receipts and payouts (migration 0041).
 *
 * Both exist because the cash between a member and a seller never touches this server: the upload
 * is how a seller proves a handover they claim happened, and the payout queue is how a seller
 * learns a member asked them to make one. Neither is allowed to credit anything — the finance
 * decision stays the only door to a balance change, and `markOrderPaid` still stops at
 * `AWAITING_VERIFICATION`.
 */

export const uploadReceipt = asyncHandler(async (req: Request, res: Response) => {
  const orderId = optionalUuid(req.body?.orderId, 'orderId');
  const withdrawalId = optionalUuid(req.body?.withdrawalId, 'withdrawalId');
  if (orderId && withdrawalId) {
    throw ApiError.badRequest('A receipt belongs to one record — send either orderId or withdrawalId', 'receipt_target_ambiguous');
  }
  const { receipt, duplicate } = await saveReceipt({
    seller: account(req),
    orderId: orderId ?? undefined,
    withdrawalId: withdrawalId ?? undefined,
    fileName: requireString(req.body?.fileName, 'fileName', { max: 120 }),
    buffer: decodeUploadPayload(req.body?.data),
  });
  // 200 rather than 201 when the same document was already on that record: nothing new was stored.
  res.status(duplicate ? 200 : 201).json({ receipt, duplicate });
});

/** The uploader reads their own slip back. Nobody else can reach it on this router. */
export const ownReceipt = asyncHandler(async (req: Request, res: Response) => {
  const { bytes, contentType, fileName } = await readReceiptForSeller(uuid(req.params.id, 'id'), account(req));
  res.setHeader('content-type', contentType);
  res.setHeader('content-disposition', `inline; filename="${safeDownloadName(fileName)}"`);
  res.setHeader('cache-control', 'no-store');
  res.send(bytes);
});

/** Payouts a member asked this seller to hand over in cash, oldest first. */
export const payouts = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, offset } = pageAndLimit(req);
  const result = await listPayoutsForSeller(account(req).id, {
    status: optionalString(req.query?.status, 'status', 12)?.toUpperCase(),
    limit,
    offset,
  });
  res.json({ ...result, page, limit });
});

export const payout = asyncHandler(async (req: Request, res: Response) => {
  res.json({ payout: await getPayoutForSeller(account(req).id, uuid(req.params.id, 'id')) });
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

/**
 * A partner's statement: its own commission lines, its own settlement batches, and — for a coin
 * seller — the cash they are holding for the platform (0042). The money half and the R-coin half
 * sit on one surface because it is one relationship, but they are never added: the cash a member
 * received for their R-coins was agreed outside the platform and the book does not price it.
 */
export const statement = asyncHandler(async (req: Request, res: Response) => {
  const caller = account(req);
  const { page, limit, offset } = pageAndLimit(req);
  const [entries, summary, settlements, cash] = await Promise.all([
    listCommissionEntries({ beneficiaryId: caller.id, limit, offset }),
    commissionSummary(caller.id),
    listCommissionSettlements({ beneficiaryId: caller.id, limit: 50 }),
    // A BD manager holds no cash, so there is no receivable to state.
    caller.kind === 'COIN_SELLER' ? sellerCashBook(caller.id) : Promise.resolve(undefined),
  ]);
  const report = {
    account: toBusinessAccount(caller),
    summary,
    entries: entries.entries,
    total: entries.total,
    settlements,
    cash,
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
  cash: SellerCashBook | undefined;
}): string {
  const row = (cells: string[]): string => cells.map(csvCell).join(',');
  const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
  const cash = report.cash;
  // The R-coin half is exported in its own unit: `currency` reads `rcoin` on those rows so a
  // spreadsheet cannot sum them into the money column and produce a number nobody agreed to.
  const cashRows = cash
    ? [
        row(['cash', '', '', '', 'collected', '', '', String(cash.collectedNetCents), cash.currency, '', '', '', 'cash collected on credited orders, net of rail cost']),
        row(['cash', '', '', '', 'refunded', '', '', String(cash.refundedCents), cash.currency, '', '', '', 'reversals handed back']),
        row(['cash', '', '', '', 'commission_netted', '', '', String(cash.commissionSettledCents), cash.currency, '', '', '', 'commission kept out of the cash collected']),
        row(['cash', '', '', '', 'remittance', '', '', String(cash.remittanceCents), cash.currency, '', '', '', 'still to hand over to the platform']),
        row(['cash', '', '', '', 'accrued', '', '', String(cash.commissionAccruedCents), cash.currency, '', '', '', 'commission accrued and not yet batched']),
        row(['cash', '', '', '', 'after_accrued', '', '', String(cash.afterAccruedCents), cash.currency, '', '', '', 'remittance less accrued commission']),
        ...cash.cashOut.map((payout) =>
          row([
            'cash_out',
            payout.reference,
            payout.paidAt,
            payout.username,
            'R_COIN_SALE',
            'PAID',
            String(payout.amountRCoins),
            String(payout.netRCoins),
            'rcoin',
            '',
            '',
            '',
            `fee ${payout.feeRCoins} R-coins; payout ${payout.payoutReference}; ${payout.receiptCount} receipt(s); cash agreed outside the platform`,
          ]),
        ),
        row(['cash_out', '', '', '', 'awaiting', '', '', String(cash.awaitingCashOutRCoins), 'rcoin', '', '', '', 'requested and not yet released by finance']),
      ]
    : [];
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
    ...cashRows,
    row(['total', '', '', '', '', '', '', String(report.summary.accruedCents), report.summary.currency, '', '', '', 'accrued']),
    row(['total', '', '', '', '', '', '', String(report.summary.settledCents), report.summary.currency, '', '', '', 'settled']),
    row(['total', '', '', '', '', '', '', String(report.summary.reversedCents), report.summary.currency, '', '', '', 'reversed']),
  ];
  return lines.join('\n');
}
