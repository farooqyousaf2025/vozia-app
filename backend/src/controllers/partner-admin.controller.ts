import { Request, Response } from 'express';
import { ApiError, asyncHandler, optionalInt, optionalString, requireBoolean, requireEnum, requireInt, requireString, requireUuid } from '../utils/http';
import { toRechargePackage } from '../utils/serialize';
import {
  BusinessAccountKind,
  BusinessAccountStatus,
  CommissionBeneficiary,
  CommissionRuleKind,
  RechargeOrderStatus,
} from '../types/db';
import {
  COMMISSION_BENEFICIARIES,
  COMMISSION_RULE_KINDS,
  CommissionTier,
  createCommissionSettlement,
  approveCommissionSettlement,
  listCommissionEntries,
  listCommissionRules,
  listCommissionSettlements,
  markCommissionSettlementPaid,
  putCommissionRule,
  retireCommissionRule,
  commissionSummary,
} from '../services/commission.service';
import {
  createBusinessAccount,
  listBusinessAccounts,
  listSellersForBd,
  readConfig,
  resetBusinessPassword,
  setBusinessAccountStatus,
  updateBusinessAccount,
  writeConfig,
} from '../services/business.service';
import {
  approveOrder,
  expireStaleOrders,
  getRechargeOrder,
  listPackages,
  listRechargeOrders,
  listSellerPackageKeys,
  rejectOrder,
  savePackage,
  setPackageActive,
  setSellerPackages,
  reverseOrder,
} from '../services/seller-recharge.service';
import { accountBalance, listFinAccounts, listJournal, trialBalance } from '../services/finance-journal.service';
import { reconciliationCsv, reconciliationReport } from '../services/reconciliation.service';

/**
 * The operator side of §21-§23: partners, orders, packages, rates, settlements, the journal and
 * the switches that govern them.
 *
 * Each route names the permission it needs, and the guard reads the operator's role from the
 * database on every call. Creating a partner, deciding that money arrived, setting a rate and
 * turning on "a webhook may credit coins without a human" are four different jobs held by four
 * different capabilities — an operations administrator cannot pay itself, and a finance
 * administrator cannot mint a seller.
 */

const uuid = (value: unknown, field: string): string => requireUuid(value, field);
const adminId = (req: Request): string => req.admin!.sub;

const ORDER_STATUSES: readonly RechargeOrderStatus[] = [
  'AWAITING_PAYMENT',
  'AWAITING_VERIFICATION',
  'CREDITED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'REVERSED',
];

function page(req: Request): { limit: number; offset: number; page: number } {
  const pageNumber = optionalInt(req.query?.page, 'page', { min: 1 }) ?? 1;
  const limit = optionalInt(req.query?.limit, 'limit', { min: 1, max: 200 }) ?? 25;
  return { limit, offset: (pageNumber - 1) * limit, page: pageNumber };
}

function windowDates(req: Request): { from?: Date; to?: Date } {
  const parse = (value: unknown, field: string): Date | undefined => {
    if (typeof value !== 'string' || !value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw ApiError.badRequest(`${field} must be an ISO date`, 'bad_date');
    return date;
  };
  return { from: parse(req.query?.from, 'from'), to: parse(req.query?.to, 'to') };
}

// ---------------------------------------------------------------------------
// Partner accounts
// ---------------------------------------------------------------------------

export const accounts = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset, page: pageNumber } = page(req);
  const result = await listBusinessAccounts({
    kind: optionalString(req.query?.kind, 'kind', 20) as BusinessAccountKind | undefined,
    status: optionalString(req.query?.status, 'status', 12) as BusinessAccountStatus | undefined,
    parentId: optionalString(req.query?.parentId, 'parentId', 36),
    search: optionalString(req.query?.search, 'search', 60),
    limit,
    offset,
  });
  res.json({ ...result, page: pageNumber, limit });
});

/**
 * The partner roster, named but not described.
 *
 * `GET /accounts` answers the operations question ("who are these partners and what are their
 * limits"), so it is gated on `business:manage`. The finance desk has the different question:
 * it holds `commission:manage` and must name a beneficiary when it files a rate version, and it
 * filters the recharge queue by seller. Answering either with the operations endpoint would hand
 * over order limits and contact details along with the name, so this projects the identity
 * fields and nothing else — enough to point at a partner, not to edit one.
 */
export const partnerRoster = asyncHandler(async (req: Request, res: Response) => {
  const { accounts } = await listBusinessAccounts({
    kind: optionalString(req.query?.kind, 'kind', 20) as BusinessAccountKind | undefined,
    status: optionalString(req.query?.status, 'status', 12) as BusinessAccountStatus | undefined,
    limit: 500,
    offset: 0,
  });
  res.json({
    partners: accounts.map((account) => ({
      id: account.id,
      kind: account.kind,
      code: account.code,
      displayName: account.displayName,
      status: account.status,
    })),
  });
});

export const createAccount = asyncHandler(async (req: Request, res: Response) => {
  const kind = requireEnum(req.body?.kind, 'kind', ['BD_MANAGER', 'BD_AGENT', 'COIN_SELLER'] as const);
  const account = await createBusinessAccount(adminId(req), {
    kind,
    displayName: requireString(req.body?.displayName, 'displayName', { min: 2, max: 120 }),
    code: optionalString(req.body?.code, 'code', 24),
    contactEmail: optionalString(req.body?.contactEmail, 'contactEmail', 120),
    contactPhone: optionalString(req.body?.contactPhone, 'contactPhone', 24),
    marketCountry: optionalString(req.body?.marketCountry, 'marketCountry', 2),
    parentId: optionalString(req.body?.parentId, 'parentId', 36),
    password: optionalString(req.body?.password, 'password', 200),
    maxOrderDiamonds: optionalInt(req.body?.maxOrderDiamonds, 'maxOrderDiamonds', { min: 1, max: 10_000_000 }),
    dailyDiamondLimit: optionalInt(req.body?.dailyDiamondLimit, 'dailyDiamondLimit', { min: 1, max: 100_000_000 }),
    dailyOrderLimit: optionalInt(req.body?.dailyOrderLimit, 'dailyOrderLimit', { min: 1, max: 100_000 }),
  });
  res.status(201).json({ account });
});

export const updateAccount = asyncHandler(async (req: Request, res: Response) => {
  const account = await updateBusinessAccount(adminId(req), uuid(req.params.id, 'id'), {
    displayName: optionalString(req.body?.displayName, 'displayName', 120),
    contactEmail: optionalString(req.body?.contactEmail, 'contactEmail', 120),
    contactPhone: optionalString(req.body?.contactPhone, 'contactPhone', 24),
    marketCountry: optionalString(req.body?.marketCountry, 'marketCountry', 2),
    parentId: optionalString(req.body?.parentId, 'parentId', 36),
    maxOrderDiamonds: optionalInt(req.body?.maxOrderDiamonds, 'maxOrderDiamonds', { min: 1, max: 10_000_000 }),
    dailyDiamondLimit: optionalInt(req.body?.dailyDiamondLimit, 'dailyDiamondLimit', { min: 1, max: 100_000_000 }),
    dailyOrderLimit: optionalInt(req.body?.dailyOrderLimit, 'dailyOrderLimit', { min: 1, max: 100_000 }),
  });
  res.json({ account });
});

/** Approve, suspend, reactivate or close. A suspension always carries a reason. */
export const accountStatus = asyncHandler(async (req: Request, res: Response) => {
  const status = requireEnum(req.body?.status, 'status', ['PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED'] as const);
  const account = await setBusinessAccountStatus(
    adminId(req),
    uuid(req.params.id, 'id'),
    status as BusinessAccountStatus,
    optionalString(req.body?.reason, 'reason', 200),
  );
  res.json({ account });
});

export const accountPassword = asyncHandler(async (req: Request, res: Response) => {
  await resetBusinessPassword(adminId(req), uuid(req.params.id, 'id'), requireString(req.body?.password, 'password', { min: 8, max: 200 }));
  res.json({ reset: true });
});

export const accountTerritory = asyncHandler(async (req: Request, res: Response) => {
  res.json({ sellers: await listSellersForBd(uuid(req.params.id, 'id')) });
});

// ---------------------------------------------------------------------------
// Recharge orders
// ---------------------------------------------------------------------------

export const rechargeOrders = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset, page: pageNumber } = page(req);
  const result = await listRechargeOrders({
    sellerId: optionalString(req.query?.sellerId, 'sellerId', 36),
    bdId: optionalString(req.query?.bdId, 'bdId', 36),
    userId: optionalString(req.query?.userId, 'userId', 36),
    status: optionalString(req.query?.status, 'status', 24) as RechargeOrderStatus | undefined,
    search: optionalString(req.query?.search, 'search', 60),
    ...windowDates(req),
    limit,
    offset,
  });
  res.json({ ...result, page: pageNumber, limit });
});

export const rechargeOrder = asyncHandler(async (req: Request, res: Response) => {
  res.json({ order: await getRechargeOrder(uuid(req.params.id, 'id')) });
});

export const approveRecharge = asyncHandler(async (req: Request, res: Response) => {
  const { order, credited } = await approveOrder(adminId(req), uuid(req.params.id, 'id'), {
    decisionNote: optionalString(req.body?.decisionNote, 'decisionNote', 200),
    feeCents: optionalInt(req.body?.feeCents, 'feeCents', { min: 0, max: 1_000_000_000 }),
  });
  res.json({ order, credited });
});

export const rejectRecharge = asyncHandler(async (req: Request, res: Response) => {
  res.json({ order: await rejectOrder(adminId(req), uuid(req.params.id, 'id'), requireString(req.body?.reason, 'reason', { min: 3, max: 200 })) });
});

export const reverseRecharge = asyncHandler(async (req: Request, res: Response) => {
  const order = await reverseOrder(adminId(req), uuid(req.params.id, 'id'), {
    reason: requireString(req.body?.reason, 'reason', { min: 3, max: 200 }),
    refundCents: optionalInt(req.body?.refundCents, 'refundCents', { min: 0, max: 1_000_000_000 }),
    // Default true: a refunded collection should take its coins back unless finance says the
    // customer keeps them. The clawback can never exceed what the balance still holds.
    clawback: req.body?.clawback === undefined ? true : requireBoolean(req.body?.clawback, 'clawback'),
  });
  res.json({ order });
});

/** Orders that passed their verification window. Wired to the scheduler, and callable by hand. */
export const sweepRechargeExpiry = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await expireStaleOrders());
});

export const rechargeStatuses = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ statuses: ORDER_STATUSES });
});

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

export const packages = asyncHandler(async (req: Request, res: Response) => {
  const rows = await listPackages({ includeInactive: req.query?.includeInactive === 'true' });
  res.json({ packages: rows.map(toRechargePackage) });
});

export const savePackageEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const row = await savePackage(adminId(req), {
    key: requireString(req.body?.key, 'key', { min: 2, max: 48 }),
    label: requireString(req.body?.label, 'label', { min: 2, max: 80 }),
    diamonds: requireInt(req.body?.diamonds, 'diamonds', { min: 1, max: 10_000_000 }),
    amountCents: requireInt(req.body?.amountCents, 'amountCents', { min: 0, max: 1_000_000_000 }),
    currency: optionalString(req.body?.currency, 'currency', 3),
    feeBps: optionalInt(req.body?.feeBps, 'feeBps', { min: 0, max: 10_000 }),
  });
  res.status(201).json({ package: toRechargePackage(row) });
});

export const packageActive = asyncHandler(async (req: Request, res: Response) => {
  const row = await setPackageActive(adminId(req), requireString(req.params.key, 'key', { max: 48 }), requireBoolean(req.body?.isActive, 'isActive'));
  res.json({ package: toRechargePackage(row) });
});

export const assignPackages = asyncHandler(async (req: Request, res: Response) => {
  const keys = req.body?.packageKeys;
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) {
    throw ApiError.badRequest('packageKeys must be an array of package keys', 'bad_package_keys');
  }
  res.json(await setSellerPackages(adminId(req), uuid(req.params.id, 'id'), keys as string[]));
});

/**
 * What is pinned, not what resolves. An empty list here means the seller may sell every active
 * package; the panel must not draw that as "nothing selected", so it reads the raw allowlist.
 */
export const readPackages = asyncHandler(async (req: Request, res: Response) => {
  res.json({ packageKeys: await listSellerPackageKeys(uuid(req.params.id, 'id')) });
});

// ---------------------------------------------------------------------------
// Commission rates, accruals and settlements
// ---------------------------------------------------------------------------

export const commissionRules = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    rules: await listCommissionRules({
      beneficiary: optionalString(req.query?.beneficiary, 'beneficiary', 12) as CommissionBeneficiary | undefined,
      kind: optionalString(req.query?.kind, 'kind', 20) as CommissionRuleKind | undefined,
      appliesToId: optionalString(req.query?.appliesToId, 'appliesToId', 36),
      includeInactive: req.query?.includeInactive === 'true',
    }),
    kinds: COMMISSION_RULE_KINDS,
    beneficiaries: COMMISSION_BENEFICIARIES,
  });
});

export const putCommissionRuleEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const rule = await putCommissionRule(adminId(req), {
    kind: requireEnum(body.kind, 'kind', COMMISSION_RULE_KINDS),
    appliesToId: optionalString(body.appliesToId, 'appliesToId', 36),
    percentBps: optionalInt(body.percentBps, 'percentBps', { min: 0, max: 10_000 }),
    fixedCents: optionalInt(body.fixedCents, 'fixedCents', { min: 0, max: 100_000_000 }),
    tiers: Array.isArray(body.tiers) ? (body.tiers as CommissionTier[]) : undefined,
    minOrderCents: optionalInt(body.minOrderCents, 'minOrderCents', { min: 0, max: 1_000_000_000 }),
    maxOrderCents: optionalInt(body.maxOrderCents, 'maxOrderCents', { min: 0, max: 1_000_000_000 }),
    currency: optionalString(body.currency, 'currency', 3),
    effectiveFrom: typeof body.effectiveFrom === 'string' ? new Date(body.effectiveFrom) : undefined,
    note: optionalString(body.note, 'note', 300),
  });
  res.status(201).json({ rule });
});

export const retireCommissionRuleEndpoint = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    rule: await retireCommissionRule(adminId(req), uuid(req.params.id, 'id'), requireString(req.body?.reason, 'reason', { min: 3, max: 300 })),
  });
});

export const commissionEntries = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset, page: pageNumber } = page(req);
  const result = await listCommissionEntries({
    beneficiaryId: optionalString(req.query?.beneficiaryId, 'beneficiaryId', 36),
    status: optionalString(req.query?.status, 'status', 16),
    ...windowDates(req),
    limit,
    offset,
  });
  res.json({ ...result, page: pageNumber, limit });
});

export const commissionTotals = asyncHandler(async (req: Request, res: Response) => {
  res.json({ summary: await commissionSummary(uuid(req.params.id, 'id')) });
});

export const settlements = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    settlements: await listCommissionSettlements({
      beneficiaryId: optionalString(req.query?.beneficiaryId, 'beneficiaryId', 36),
      status: optionalString(req.query?.status, 'status', 16),
      limit: optionalInt(req.query?.limit, 'limit', { min: 1, max: 200 }) ?? 50,
    }),
  });
});

export const createSettlement = asyncHandler(async (req: Request, res: Response) => {
  const parse = (field: string): Date => {
    const value = req.body?.[field];
    if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
      throw ApiError.badRequest(`${field} must be an ISO date`, 'bad_date');
    }
    return new Date(value);
  };
  const batch = await createCommissionSettlement(adminId(req), {
    beneficiary: requireEnum(req.body?.beneficiary, 'beneficiary', ['SELLER', 'BD'] as const),
    beneficiaryId: uuid(req.body?.beneficiaryId, 'beneficiaryId'),
    periodFrom: parse('periodFrom'),
    periodTo: parse('periodTo'),
    payoutMethod: optionalString(req.body?.payoutMethod, 'payoutMethod', 40),
  });
  res.status(201).json({ settlement: batch });
});

export const approveSettlement = asyncHandler(async (req: Request, res: Response) => {
  res.json({ settlement: await approveCommissionSettlement(adminId(req), uuid(req.params.id, 'id')) });
});

export const paySettlement = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    settlement: await markCommissionSettlementPaid(
      adminId(req),
      uuid(req.params.id, 'id'),
      optionalString(req.body?.note, 'note', 300),
    ),
  });
});

// ---------------------------------------------------------------------------
// The journal, the chart and the switches
// ---------------------------------------------------------------------------

export const journal = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset, page: pageNumber } = page(req);
  const result = await listJournal({
    sourceKind: optionalString(req.query?.sourceKind, 'sourceKind', 24),
    sourceId: optionalString(req.query?.sourceId, 'sourceId', 64),
    accountCode: optionalString(req.query?.accountCode, 'accountCode', 32),
    ...windowDates(req),
    limit,
    offset,
  });
  res.json({ ...result, page: pageNumber, limit });
});

export const chart = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ accounts: await listFinAccounts() });
});

/**
 * §25's daily cross-check: re-derive the tie-outs between the coin ledger, the journal and the
 * partner books straight from the tables, rather than repeating what the services said about
 * themselves. `?format=csv` is the file the finance team files.
 */
export const reconciliation = asyncHandler(async (req: Request, res: Response) => {
  const range = windowDates(req);
  const report = await reconciliationReport(range.from, range.to);
  if (req.query?.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="voiza-reconciliation-${report.generatedAt.slice(0, 10)}.csv"`);
    res.send(reconciliationCsv(report));
    return;
  }
  res.json(report);
});

export const balances = asyncHandler(async (req: Request, res: Response) => {
  const range = windowDates(req);
  if (req.params.code) {
    res.json({ account: await accountBalance(requireString(req.params.code, 'code', { max: 32 }), range.from, range.to) });
    return;
  }
  res.json({ trial: await trialBalance(range.from, range.to) });
});

/** One `system_config` key. Reading is finance:read; writing is config:manage. */
export const readConfigEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const key = requireString(req.params.key, 'key', { min: 3, max: 48 });
  res.json({ key, value: await readConfig(key, {}) });
});

export const writeConfigEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const key = requireString(req.params.key, 'key', { min: 3, max: 48 });
  const value = req.body?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('value must be a JSON object', 'bad_config_value');
  }
  const row = await writeConfig(adminId(req), key, value as Record<string, unknown>);
  res.json({ key, value: row.value, updatedAt: new Date(row.updated_at).toISOString() });
});
