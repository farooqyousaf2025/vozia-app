import { Request, Response } from 'express';
import { withTransaction } from '../config/db';
import { ApiError, asyncHandler, optionalEnum, optionalInt, optionalString, requireEnum, requireInt, requireString } from '../utils/http';
import { buildCsv, buildWorkbook, WorkbookSheet } from '../utils/workbook';
import {
  ACCOUNT_CATEGORIES,
  ACCOUNT_OWNER_KINDS,
  ACCOUNT_STATUSES,
  HOLD_KINDS,
  AccountHoldDto,
  ReconciliationFinding,
  releaseHold,
  setAccountStatus,
  claimIdempotency,
  completeIdempotency,
  createHold,
  findAccount,
  listAccounts,
  listHolds,
  listMovements,
  reconcileAccounts,
} from '../services/purpose-account.service';

/**
 * The account surface for the back office.
 *
 * Every number here is read from the same projection the reconciliation report is computed
 * against, so an operator looking at a balance and an operator looking at why that balance moved
 * are looking at one definition rather than two that happen to agree today.
 *
 * What is deliberately absent is a second way to change a balance. `POST /admin/users/:id/balance`
 * is the only manual money route in the product, and it stays that way: two entry points for the
 * same act means two sets of guards, and the weaker set is the one that gets used at 02:00. What
 * this router does instead is let an operator hold, release, suspend and ask questions — actions
 * that constrain money without inventing it.
 */

const adminId = (req: Request): string => req.admin!.sub;

/**
 * Separate scopes per action, because one key is one intent. The same string reused for a hold and
 * a release would let a replay of one answer for the other.
 */
const HOLD_SCOPE = 'admin:account:hold';
const RELEASE_SCOPE = 'admin:account:hold-release';

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

/**
 * Two code conventions coexist in this book and both are legitimate.
 *
 * Derived accounts are `CATEGORY:owner` (section 5) — `USER_DIAMOND:<uuid>`. The nine platform
 * accounts that predate this migration are plain ledger names — `PLATFORM_REVENUE`,
 * `COIN_LIABILITY`, `REFUND_RESERVE` — read from `fin_journal_lines`, with no owner to append.
 * Requiring a colon made every one of those unreadable through the API, which is the opposite of
 * what a money book should do.
 *
 * So the shape is validated instead: an uppercase ledger name, optionally qualified by an owner.
 * Route shadowing does not depend on this — `/accounts/reconcile`, `/accounts/holds` and
 * `/accounts/:code` are registered in that order — but the shape still keeps a path segment like
 * `../../etc` out of a query parameter.
 */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,40}(:[A-Za-z0-9._-]{1,64})?$/;
const accountCode = (value: unknown): string => {
  const code = requireString(value, 'accountCode', { max: 110 });
  if (!CODE_PATTERN.test(code)) {
    throw ApiError.badRequest('An account code is a ledger name like PLATFORM_REVENUE, or CATEGORY:owner', 'bad_account_code');
  }
  return code;
};

const FORMAT_LABELS = ['json', 'csv', 'xlsx'] as const;
type ExportFormat = (typeof FORMAT_LABELS)[number];

/** The format the caller asked for, defaulting to JSON so every existing consumer is unaffected. */
function exportFormat(req: Request): ExportFormat {
  return optionalEnum(req.query?.format, 'format', FORMAT_LABELS) ?? 'json';
}

/** A `:` in a filename is not portable, and these codes are full of them. */
const fileStem = (code: string): string => code.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);

function sendExport(res: Response, args: { format: ExportFormat; stem: string; sheets: WorkbookSheet[] }): void {
  if (args.format === 'csv') {
    // CSV has no place for a second sheet, so the first one — the data — is what gets written.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${args.stem}.csv"`);
    res.send(buildCsv(args.sheets[0]));
    return;
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${args.stem}.xlsx"`);
  res.send(buildWorkbook(args.sheets));
}

/** The same sheet is the CSV and the XLSX, so the two exports cannot disagree about a figure. */
const movementColumns = [
  { key: 'occurredAt', header: 'Occurred at', width: 26 },
  { key: 'reference', header: 'Reference', width: 40 },
  { key: 'type', header: 'Type', width: 24 },
  { key: 'status', header: 'Status', width: 16 },
  { key: 'direction', header: 'Direction', width: 11 },
  { key: 'amount', header: 'Amount', width: 16, numeric: true },
  { key: 'currency', header: 'Unit', width: 10 },
  { key: 'counterparty', header: 'Counterparty', width: 34 },
  { key: 'description', header: 'Description', width: 60 },
];

const findingColumns = [
  { key: 'severity', header: 'Severity', width: 11 },
  { key: 'code', header: 'Finding', width: 34 },
  { key: 'accountCode', header: 'Account', width: 42 },
  { key: 'amount', header: 'Amount', width: 16, numeric: true },
  { key: 'currency', header: 'Unit', width: 10 },
  { key: 'detail', header: 'Detail', width: 90 },
];

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The overview (section 7): the book, paged, with the filters applied in SQL rather than here. */
export const overview = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset, page: pageNumber } = page(req);
  const { accounts, total } = await listAccounts({
    category: optionalEnum(req.query?.category, 'category', ACCOUNT_CATEGORIES),
    ownerKind: optionalEnum(req.query?.ownerKind, 'ownerKind', ACCOUNT_OWNER_KINDS),
    ownerId: optionalString(req.query?.ownerId, 'ownerId', 64),
    status: optionalEnum(req.query?.status, 'status', ACCOUNT_STATUSES),
    currency: optionalString(req.query?.currency, 'currency', 8),
    search: optionalString(req.query?.search, 'search', 60),
    onlyWithPosition: req.query?.onlyWithPosition === 'true',
    limit,
    offset,
  });
  res.json({ accounts, total, page: pageNumber, limit });
});

/** One account, and the source the balance is read from — a number with no provenance is not auditable. */
export const detail = asyncHandler(async (req: Request, res: Response) => {
  res.json({ account: await findAccount(accountCode(req.params.code)) });
});

/**
 * The statement behind a balance.
 *
 * The date window is honoured by the query, not applied to the page, because filtering after
 * paging would report a different total than the rows shown — the difference an operator would
 * otherwise spend an afternoon explaining to finance.
 */
export const movements = asyncHandler(async (req: Request, res: Response) => {
  const code = accountCode(req.params.code);
  const { limit, offset, page: pageNumber } = page(req);
  const format = exportFormat(req);
  const { from, to } = windowDates(req);
  const { movements: rows, unit, total } = await listMovements(code, { from, to, limit, offset });

  if (format !== 'json') {
    sendExport(res, {
      format,
      stem: `${fileStem(code)}-statement`,
      sheets: [{ name: 'Statement', columns: movementColumns, rows: rows as unknown as Record<string, unknown>[] }],
    });
    return;
  }
  res.json({ accountCode: code, unit, movements: rows, total, page: pageNumber, limit, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null });
});

/** Holds across the book, or one account's holds when a code is supplied. */
export const holds = asyncHandler(async (req: Request, res: Response) => {
  const { limit, offset, page: pageNumber } = page(req);
  const code = req.params.code ? accountCode(req.params.code) : undefined;
  const { holds: rows, total } = await listHolds({
    accountCode: code,
    status: optionalEnum(req.query?.status, 'status', ['OPEN', 'RELEASED', 'CONVERTED'] as const),
    limit,
    offset,
  });
  res.json({ holds: rows, total, page: pageNumber, limit });
});

// ---------------------------------------------------------------------------
// Writing — three actions, all audited, all replay-safe
// ---------------------------------------------------------------------------

/**
 * Freeze or earmark part of an account.
 *
 * The service validates kind, amount and reason and refuses a hold that would claim more than the
 * owner can spend; what the controller adds is the replay guard. A hold is money-shaped — it
 * changes what an owner can withdraw — so an operator double-clicking on a slow connection must
 * create one hold, not two.
 */
export const addHold = asyncHandler(async (req: Request, res: Response) => {
  const code = accountCode(req.params.code);
  const kind = requireEnum(req.body?.kind, 'kind', HOLD_KINDS);
  const amount = requireInt(req.body?.amount, 'amount', { min: 1, max: 1_000_000_000_000 });
  const reason = requireString(req.body?.reason, 'reason', { min: 8, max: 300 });
  const key = requireString(req.body?.idempotencyKey, 'idempotencyKey', { max: 80 });

  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, HOLD_SCOPE, key, adminId(req));
    if (claim.replay) return { hold: claim.response as unknown as AccountHoldDto, replay: true };

    const created = await createHold({ accountCode: code, kind, amount, reason, adminId: adminId(req), client });
    await completeIdempotency(client, HOLD_SCOPE, key, created.id, created as unknown as Record<string, unknown>);
    return { hold: created, replay: false };
  });

  // A replay answers with the hold the first attempt created, and says so rather than quietly
  // reporting a fresh 201 for money that was frozen minutes ago.
  res.status(result.replay ? 200 : 201).json(result);
});

/** Release a hold, optionally converting it into the settlement it was waiting for. */
export const releaseHoldEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'holdId', { max: 64 });
  const convertTo = optionalString(req.body?.convertTo, 'convertTo', 64) ?? null;
  const key = requireString(req.body?.idempotencyKey, 'idempotencyKey', { max: 80 });

  const result = await withTransaction(async (client) => {
    const claim = await claimIdempotency(client, RELEASE_SCOPE, key, adminId(req));
    if (claim.replay) return { ...claim.response, replay: true };
    const released = await releaseHold(id, adminId(req), convertTo, client);
    await completeIdempotency(client, RELEASE_SCOPE, key, id, released);
    return { ...released, replay: false };
  });
  res.json(result);
});

/**
 * Suspend, freeze, close or reopen an account.
 *
 * This changes what an owner may do with money already theirs, which is why a reason is required
 * for anything other than ACTIVE (the service enforces it) and why the write is audited there
 * rather than here — one path, one audit.
 */
export const status = asyncHandler(async (req: Request, res: Response) => {
  const code = accountCode(req.params.code);
  const next = requireEnum(req.body?.status, 'status', ACCOUNT_STATUSES);
  const reason = optionalString(req.body?.reason, 'reason', 200);
  res.json(await setAccountStatus(code, next, adminId(req), reason));
});

/**
 * Can the book explain itself? (section 9)
 *
 * The whole point of running this is to find the accounts that cannot, so the response is ordered
 * by severity and an ERROR is never averaged away into a summary figure. Exported as a workbook
 * because the operator takes it to finance, not the other way round.
 */
export const reconcile = asyncHandler(async (req: Request, res: Response) => {
  const format = exportFormat(req);
  const { generatedAt, findings } = await reconcileAccounts();
  const errors = findings.filter((f) => f.severity === 'ERROR').length;

  if (format !== 'json') {
    const rows = findings.map((f: ReconciliationFinding) => ({
      severity: f.severity,
      code: f.code,
      accountCode: f.accountCode,
      amount: f.amountMinor,
      currency: f.currency,
      detail: f.detail,
    }));
    sendExport(res, {
      format,
      stem: 'account-reconciliation',
      sheets: [
        {
          name: 'Summary',
          columns: [
            { key: 'label', header: 'Field', width: 26 },
            { key: 'value', header: 'Value', width: 40 },
          ],
          rows: [
            { label: 'Generated at', value: generatedAt },
            { label: 'Findings', value: findings.length },
            { label: 'Errors', value: errors },
            { label: 'Informational', value: findings.length - errors },
          ],
        },
        { name: 'Findings', columns: findingColumns, rows },
      ],
    });
    return;
  }
  res.json({ generatedAt, total: findings.length, errors, findings });
});
