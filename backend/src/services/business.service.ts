import { many, one, query, withTransaction } from '../config/db';
import {
  BusinessAccountKind,
  BusinessAccountRow,
  BusinessAccountStatus,
  SystemConfigRow,
} from '../types/db';
import { ApiError } from '../utils/http';
import { shortCode } from '../utils/ids';
import { hashSecret, verifySecret } from '../utils/crypto';
import { BusinessAccountDto, toBusinessAccount } from '../utils/serialize';
import { recordAudit } from './audit.service';
import { signBusinessToken } from './token.service';

/**
 * BD representatives and coin sellers (§21, §22).
 *
 * These are business identities, not party accounts: they never join a room, they never hold
 * a wallet, and they are not operators. Every mutation below writes its audit row on the same
 * SQL transaction as the change, so there is no version of this table where a partner was
 * created, approved or suspended and nobody can say who did it.
 */

const ACCOUNT_SELECT = `
  SELECT b.*, p.code AS parent_code, p.display_name AS parent_name
    FROM business_accounts b
    LEFT JOIN business_accounts p ON p.id = b.parent_id`;

const CODE_PREFIX: Record<BusinessAccountKind, string> = {
  BD_MANAGER: 'BD',
  BD_AGENT: 'BDA',
  COIN_SELLER: 'SLR',
};

/** Status moves the panel is allowed to make, and where each one may go next. */
const ALLOWED_TRANSITIONS: Record<BusinessAccountStatus, BusinessAccountStatus[]> = {
  PENDING: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['SUSPENDED', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

export async function getBusinessAccount(id: string): Promise<BusinessAccountRow | null> {
  return one<BusinessAccountRow>(`${ACCOUNT_SELECT} WHERE b.id = $1`, [id]);
}

export async function findBusinessAccountByCode(code: string): Promise<BusinessAccountRow | null> {
  return one<BusinessAccountRow>(`SELECT * FROM business_accounts WHERE code = $1`, [code]);
}

async function nextCode(kind: BusinessAccountKind): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = shortCode(`${CODE_PREFIX[kind]}-`, 4);
    const taken = await one<{ id: string }>('SELECT id FROM business_accounts WHERE code = $1', [candidate]);
    if (!taken) return candidate;
  }
  throw ApiError.conflict('Could not allocate a business ID; try again');
}

/**
 * Read a `system_config` row with its defaults.
 *
 * These are the switches the programme insists must be administrator-owned rather than
 * hardcoded: the recharge window, whether manual orders need evidence, whether more than one
 * BD manager may exist, and the order in which commission kinds are applied.
 */
export async function readConfig<T extends Record<string, unknown>>(key: string, defaults: T): Promise<T> {
  const row = await one<SystemConfigRow>('SELECT * FROM system_config WHERE key = $1', [key]);
  if (!row) return defaults;
  return { ...defaults, ...(row.value as object) } as T;
}

export async function writeConfig(adminId: string, key: string, value: Record<string, unknown>): Promise<SystemConfigRow> {
  const row = await withTransaction(async (client) => {
    const result = await client.query<SystemConfigRow>(
      `INSERT INTO system_config (key, value, updated_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`,
      [key, JSON.stringify(value), adminId],
    );
    await recordAudit(
      {
        adminId,
        action: 'SYSTEM_CONFIG_UPDATE',
        targetType: 'system_config',
        targetId: key,
        summary: `Changed configuration ${key}`,
        details: { value },
      },
      client,
    );
    return result.rows[0];
  });
  return row;
}

export type CreateBusinessInput = {
  kind: BusinessAccountKind;
  displayName: string;
  code?: string;
  contactEmail?: string;
  contactPhone?: string;
  marketCountry?: string;
  parentId?: string;
  password?: string;
  maxOrderDiamonds?: number;
  dailyDiamondLimit?: number;
  dailyOrderLimit?: number;
};

export async function createBusinessAccount(adminId: string, input: CreateBusinessInput): Promise<BusinessAccountDto> {
  const code = input.code ?? (await nextCode(input.kind));
  const duplicate = await findBusinessAccountByCode(code);
  if (duplicate) throw ApiError.conflict(`Business ID ${code} already exists`, 'code_taken');

  if (input.kind === 'COIN_SELLER' && !input.parentId) {
    // Not a formality: an unassigned seller accrues no BD commission, and letting one slip
    // through would make the missing attribution look like a zero-rate rule.
    throw ApiError.badRequest('A coin seller must be assigned to a BD account', 'seller_unassigned');
  }

  if (input.parentId) {
    const parent = await getBusinessAccount(input.parentId);
    if (!parent) throw ApiError.notFound('Parent business account not found', 'parent_not_found');
    if (input.kind === 'COIN_SELLER' && parent.kind === 'COIN_SELLER') {
      throw ApiError.badRequest('Coin sellers report to a BD account', 'invalid_parent');
    }
    if (input.kind === 'BD_AGENT' && parent.kind !== 'BD_MANAGER') {
      throw ApiError.badRequest('A BD agent reports to a BD manager', 'invalid_parent');
    }
    if (input.kind === 'BD_MANAGER') throw ApiError.badRequest('A BD manager has no parent account', 'invalid_parent');
  }

  if (input.kind === 'BD_MANAGER') {
    const bd = await readConfig('business.bd', { multiManager: false });
    if (!bd.multiManager) {
      const existing = await one<{ n: string }>(
        "SELECT COUNT(*) AS n FROM business_accounts WHERE kind = 'BD_MANAGER' AND status <> 'CLOSED'",
      );
      if (Number(existing?.n ?? 0) > 0) {
        throw ApiError.forbidden(
          'More than one BD manager is not enabled. Turn on business.bd -> multiManager in system configuration first.',
          'multi_manager_disabled',
        );
      }
    }
  }

  const row = await withTransaction(async (client) => {
    const inserted = await client.query<BusinessAccountRow>(
      `INSERT INTO business_accounts
         (kind, code, display_name, contact_email, contact_phone, market_country, parent_id, password_hash,
          max_order_diamonds, daily_diamond_limit, daily_order_limit, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING')
       RETURNING *`,
      [
        input.kind,
        code,
        input.displayName,
        input.contactEmail ?? null,
        input.contactPhone ?? null,
        input.marketCountry ?? null,
        input.parentId ?? null,
        input.password ? hashSecret(input.password) : null,
        input.maxOrderDiamonds ?? 100_000,
        input.dailyDiamondLimit ?? 1_000_000,
        input.dailyOrderLimit ?? 200,
        adminId,
      ],
    );
    await recordAudit(
      {
        adminId,
        action: 'BUSINESS_ACCOUNT_CREATE',
        targetType: 'business_account',
        targetId: inserted.rows[0].id,
        summary: `Created ${input.kind} ${code} (${input.displayName})`,
        details: { kind: input.kind, code, parentId: input.parentId ?? null },
      },
      client,
    );
    return inserted.rows[0];
  });

  const enriched = await getBusinessAccount(row.id);
  return toBusinessAccount(enriched ?? row);
}

export type UpdateBusinessInput = Partial<Omit<CreateBusinessInput, 'kind' | 'code' | 'password'>>;

/**
 * Edit the profile and the limits. Status and commission rates are separate calls on purpose:
 * approval is a decision somebody must be able to find in the audit log on its own.
 */
export async function updateBusinessAccount(
  adminId: string,
  accountId: string,
  patch: UpdateBusinessInput,
): Promise<BusinessAccountDto> {
  const current = await getBusinessAccount(accountId);
  if (!current) throw ApiError.notFound('Business account not found');

  const columns: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown) => {
    params.push(value);
    columns.push(`${column} = $${params.length}`);
  };

  if (patch.displayName !== undefined) add('display_name', patch.displayName);
  if (patch.contactEmail !== undefined) add('contact_email', patch.contactEmail);
  if (patch.contactPhone !== undefined) add('contact_phone', patch.contactPhone);
  if (patch.marketCountry !== undefined) add('market_country', patch.marketCountry);
  if (patch.maxOrderDiamonds !== undefined) add('max_order_diamonds', patch.maxOrderDiamonds);
  if (patch.dailyDiamondLimit !== undefined) add('daily_diamond_limit', patch.dailyDiamondLimit);
  if (patch.dailyOrderLimit !== undefined) add('daily_order_limit', patch.dailyOrderLimit);
  if (patch.parentId !== undefined) add('parent_id', patch.parentId);
  if (!columns.length) throw ApiError.badRequest('Nothing to change');

  const row = await withTransaction(async (client) => {
    params.push(accountId);
    const result = await client.query<BusinessAccountRow>(
      `UPDATE business_accounts SET ${columns.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    await recordAudit(
      {
        adminId,
        action: 'BUSINESS_ACCOUNT_UPDATE',
        targetType: 'business_account',
        targetId: accountId,
        summary: `Updated ${current.code}`,
        // Only the changed fields, so an operator can see what was moved — including a seller
        // changing BD, which must never be mistaken for re-attributing past orders.
        details: { changes: Object.fromEntries(columns.map((c, i) => [c.split(' = ')[0], params[i]])) },
      },
      client,
    );
    return result.rows[0];
  });

  const enriched = await getBusinessAccount(row.id);
  return toBusinessAccount(enriched ?? row);
}

export async function setBusinessAccountStatus(
  adminId: string,
  accountId: string,
  status: BusinessAccountStatus,
  reason?: string,
): Promise<BusinessAccountDto> {
  const current = await getBusinessAccount(accountId);
  if (!current) throw ApiError.notFound('Business account not found');
  if (!ALLOWED_TRANSITIONS[current.status].includes(status)) {
    throw ApiError.conflict(`A ${current.status} account cannot become ${status}`, 'invalid_status_transition');
  }
  if (status === 'SUSPENDED' && !reason) throw ApiError.badRequest('Suspending an account needs a reason');

  const row = await withTransaction(async (client) => {
    const result = await client.query<BusinessAccountRow>(
      // The status literals are cast to the enum: without a cast PostgreSQL would deduce `$2`
      // as text from the comparisons and as `business_account_status` from the assignment.
      `UPDATE business_accounts
          SET status = $2,
              approved_by = CASE WHEN $2 = 'ACTIVE'::business_account_status THEN $3 ELSE approved_by END,
              approved_at = CASE WHEN $2 = 'ACTIVE'::business_account_status AND approved_at IS NULL THEN now() ELSE approved_at END,
              suspended_reason = CASE WHEN $2 = 'SUSPENDED'::business_account_status THEN $4 ELSE NULL END
        WHERE id = $1 RETURNING *`,
      [accountId, status, adminId, reason ?? null],
    );
    await recordAudit(
      {
        adminId,
        action: `BUSINESS_ACCOUNT_${status}`,
        targetType: 'business_account',
        targetId: accountId,
        summary: `${current.code}: ${current.status} -> ${status}${reason ? ` — ${reason}` : ''}`,
        details: { from: current.status, to: status, reason: reason ?? null },
      },
      client,
    );
    return result.rows[0];
  });

  const enriched = await getBusinessAccount(row.id);
  return toBusinessAccount(enriched ?? row);
}

/** An operator hands out (or resets) credentials. Partners never set their own rates. */
export async function resetBusinessPassword(adminId: string, accountId: string, password: string): Promise<void> {
  const account = await getBusinessAccount(accountId);
  if (!account) throw ApiError.notFound('Business account not found');
  await withTransaction(async (client) => {
    await client.query('UPDATE business_accounts SET password_hash = $2 WHERE id = $1', [accountId, hashSecret(password)]);
    await recordAudit(
      {
        adminId,
        action: 'BUSINESS_CREDENTIAL_RESET',
        targetType: 'business_account',
        targetId: accountId,
        summary: `Reset sign-in credentials for ${account.code}`,
      },
      client,
    );
  });
}

export async function changeOwnBusinessPassword(accountId: string, current: string, next: string): Promise<void> {
  const row = await one<BusinessAccountRow>('SELECT * FROM business_accounts WHERE id = $1', [accountId]);
  if (!row || !verifySecret(current, row.password_hash)) {
    throw ApiError.unauthorized('Current password is wrong', 'invalid_credentials');
  }
  await query('UPDATE business_accounts SET password_hash = $2 WHERE id = $1', [accountId, hashSecret(next)]);
}

export async function loginBusinessAccount(
  code: string,
  password: string,
): Promise<{ token: string; account: BusinessAccountDto }> {
  const row = await one<BusinessAccountRow>('SELECT * FROM business_accounts WHERE code = $1', [code]);
  // One error for "no such account" and "wrong password": the ID space is business-visible and
  // must not double as an enumeration oracle.
  if (!row || !verifySecret(password, row.password_hash)) {
    throw ApiError.unauthorized('Wrong business ID or password', 'invalid_credentials');
  }
  if (row.status !== 'ACTIVE') {
    throw ApiError.forbidden(`This account is ${row.status.toLowerCase()}`, 'business_account_inactive');
  }
  await query('UPDATE business_accounts SET last_login_at = now() WHERE id = $1', [row.id]);
  return {
    token: signBusinessToken({ sub: row.id, code: row.code, kind: row.kind }),
    account: toBusinessAccount(row),
  };
}

export async function listBusinessAccounts(opts: {
  kind?: BusinessAccountKind;
  status?: BusinessAccountStatus;
  parentId?: string;
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ accounts: BusinessAccountDto[]; total: number }> {
  const params: unknown[] = [];
  const where: string[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (opts.kind) where.push(`b.kind = ${bind(opts.kind)}`);
  if (opts.status) where.push(`b.status = ${bind(opts.status)}`);
  if (opts.parentId) where.push(`b.parent_id = ${bind(opts.parentId)}`);
  if (opts.search) {
    // One term, two columns: partners look each other up by name or by the ID on their letterhead.
    where.push(`(b.display_name ILIKE ${bind(`%${opts.search}%`)} OR b.code ILIKE ${bind(`%${opts.search}%`)})`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Number(opts.limit) || 50;
  const offset = Number(opts.offset) || 0;

  const rows = await many<BusinessAccountRow>(
    `${ACCOUNT_SELECT} ${clause} ORDER BY b.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const count = await one<{ n: string }>(`SELECT COUNT(*) AS n FROM business_accounts b ${clause}`, params);
  return { accounts: rows.map(toBusinessAccount), total: Number(count?.n ?? 0) };
}

/**
 * Everything a BD is responsible for, transitively: its own sellers, and the sellers belonging
 * to its agents. §21's "only see data belonging to their authorized business scope" is decided
 * by this one query, so every BD-facing report filters through it.
 */
export async function listSellersForBd(bdAccountId: string): Promise<BusinessAccountDto[]> {
  const rows = await many<BusinessAccountRow>(
    `WITH RECURSIVE territory AS (
       SELECT id FROM business_accounts WHERE id = $1
       UNION ALL
       SELECT s.id FROM business_accounts s JOIN territory t ON s.parent_id = t.id
     )
     SELECT b.* FROM business_accounts b WHERE b.id IN (SELECT id FROM territory) AND b.kind = 'COIN_SELLER'
      ORDER BY b.display_name`,
    [bdAccountId],
  );
  return rows.map(toBusinessAccount);
}
