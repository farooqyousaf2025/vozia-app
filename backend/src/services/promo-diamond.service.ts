import { PoolClient } from 'pg';
import { many, withTransaction } from '../config/db';
import { ApiError } from '../utils/http';
import { FIN_ACCOUNTS, coinFaceMinor, postJournal } from './finance-journal.service';
import { iso } from '../utils/serialize';

/**
 * Promotional diamonds — the coins the platform gives rather than sells.
 *
 * Three rules shape this module, and each is here because the alternative is a bug somebody would
 * find in a wallet:
 *
 *   * **A grant is a row, not a number.** `users.promo_diamond_balance` is what a phone shows, but the
 *     thing that expires is `promo_grants.remaining`. Spending therefore picks grants nearest their
 *     death first; a member with a bonus expiring Friday and one expiring next month loses the first,
 *     not whichever a random-access balance happened to debit.
 *   * **Every coin minted is booked.** A grant posts `PROMO_GRANT` against `COIN_LIABILITY` at the
 *     operator's face value, and a grant that dies unspent posts `PROMO_LAPSE` to release it. Coins
 *     minted without a journal line are the hole 0034 closed, and a marketing giveaway is the most
 *     likely place to repeat it.
 *   * **Nothing here can be cashed out by its holder.** Diamonds leave an account by being spent on
 *     someone else; withdrawal is priced in R-coins, and `transactions` refuses a row whose sender is
 *     its receiver. So the spend paths may take bonus coins, and no member can turn them into a payout.
 *
 * What this module deliberately does *not* do is cap what a member earns in a day. That is the earning
 * rules engine (#61), and it needs the grant rows written here before it can count them.
 */

/** 0029 seeded this dial before anything could read it; 0037 merged 0036's parallel key into it. */
export const PROMO_CONFIG_KEY = 'accounts.promotional';

/** The four paths that take diamonds. A purpose missing from `usableFor` is refused at the guard. */
export type PromoPurpose = 'GIFT' | 'BOX' | 'STORE' | 'GAME';

/** Closed list, mirrored by the CHECK on `promo_grants.source_kind`. */
export const PROMO_SOURCE_KINDS = ['CHECKIN', 'QUEST', 'CAMPAIGN', 'REFERRAL', 'EVENT', 'ACHIEVEMENT', 'ADMIN'] as const;
export type PromoSourceKind = (typeof PROMO_SOURCE_KINDS)[number];

type PromoGrantRow = {
  id: string;
  user_id: string;
  status: 'ACTIVE' | 'EXHAUSTED' | 'LAPSED' | 'REVERSED';
  amount: number;
  spent: number;
  lapsed: number;
  remaining: number;
  source_kind: string;
  source_id: string | null;
  reason: string;
  granted_by: string | null;
  expires_at: Date | string;
  created_at: Date | string;
};

export type PromoGrantDto = {
  id: string;
  amount: number;
  remaining: number;
  status: string;
  sourceKind: string;
  reason: string;
  expiresAt: string;
  createdAt: string;
};

export type PromoPolicy = { expiryDays: number; usableFor: PromoPurpose[] };

const DEFAULT_POLICY: PromoPolicy = { expiryDays: 30, usableFor: ['GIFT', 'BOX', 'STORE', 'GAME'] };

function toGrantDto(row: PromoGrantRow): PromoGrantDto {
  return {
    id: row.id,
    amount: row.amount,
    remaining: row.remaining,
    status: row.status,
    sourceKind: row.source_kind,
    reason: row.reason,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

/**
 * The operator's two promo dials, read inside the caller's transaction.
 *
 * `usableFor` defaults to everything rather than nothing: a config row written before this key existed,
 * or a JSON value with the field misspelled, must not silently stop bonus coins from working. An
 * operator who wants a restriction says so in the value.
 */
export async function promoPolicy(client?: PoolClient): Promise<PromoPolicy> {
  const rows = client
    ? (await client.query<{ value: Record<string, unknown> }>('SELECT value FROM system_config WHERE key = $1', [
        PROMO_CONFIG_KEY,
      ])).rows
    : await many<{ value: Record<string, unknown> }>('SELECT value FROM system_config WHERE key = $1', [
        PROMO_CONFIG_KEY,
      ]);
  const value = rows[0]?.value ?? {};
  const days = Number(value.expiryDays);
  const usable = Array.isArray(value.usableFor)
    ? (value.usableFor as unknown[]).filter((p): p is PromoPurpose => p === 'GIFT' || p === 'BOX' || p === 'STORE' || p === 'GAME')
    : DEFAULT_POLICY.usableFor;
  return {
    expiryDays: Number.isInteger(days) && days > 0 && days <= 3650 ? days : DEFAULT_POLICY.expiryDays,
    usableFor: usable.length ? usable : DEFAULT_POLICY.usableFor,
  };
}

/**
 * Award promotional diamonds.
 *
 * Idempotent on `(sourceKind, sourceId)` when an id is given, which is the whole reason a reward hook
 * can call this from inside the transaction that recorded the qualifying action: a check-in swept by a
 * retry, or a quest completed twice in one request, grants once. The caller's client is required for
 * that guarantee to mean anything, so an omitted one opens its own transaction.
 *
 * The journal entry is keyed on the grant, not the trigger, because the grant is the row that says how
 * many coins left the platform.
 */
export async function grantPromoDiamonds(
  input: {
    userId: string;
    amount: number;
    sourceKind: PromoSourceKind;
    sourceId?: string | null;
    reason: string;
    grantedBy?: string | null;
    /** Absolute deadline. Omit to get `accounts.promotional.expiryDays` from now. */
    expiresAt?: Date;
  },
  client?: PoolClient,
): Promise<{ grant: PromoGrantDto; alreadyGranted: boolean }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw ApiError.badRequest('A promotional grant needs a positive whole number of diamonds', 'bad_promo_amount');
  }
  if (input.amount > 10_000_000) {
    throw ApiError.badRequest('Promotional grant too large', 'promo_amount_too_large');
  }
  if (!PROMO_SOURCE_KINDS.includes(input.sourceKind)) {
    throw ApiError.badRequest(`Unknown promotional reward source ${input.sourceKind}`, 'bad_promo_source');
  }
  const reason = input.reason?.trim();
  if (!reason) throw ApiError.badRequest('A promotional grant needs a reason an operator can read', 'promo_reason_required');

  const run = async (tx: PoolClient) => {
    const policy = await promoPolicy(tx);
    const expiresAt = input.expiresAt ?? new Date(Date.now() + policy.expiryDays * 86_400_000);
    if (!(expiresAt.getTime() > Date.now())) {
      throw ApiError.badRequest('A promotional grant has to expire in the future', 'bad_promo_expiry');
    }

    // The account is locked before its grants are written, in the same order every other coin path
    // uses. A grant racing a spend of the same balance otherwise reads a stale cached total.
    const user = await tx.query<{ id: string }>(
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      [input.userId],
    );
    if (!user.rows[0]) throw ApiError.notFound('Account not found', 'user_not_found');

    const inserted = await tx.query<PromoGrantRow>(
      `INSERT INTO promo_grants (user_id, amount, spent, lapsed, remaining, source_kind, source_id, reason,
                                 granted_by, expires_at)
       VALUES ($1,$2,0,0,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (source_kind, source_id) WHERE source_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        input.userId,
        input.amount,
        input.sourceKind,
        input.sourceId ?? null,
        reason.slice(0, 200),
        input.grantedBy ?? null,
        expiresAt,
      ],
    );
    if (!inserted.rows.length) {
      const existing = await tx.query<PromoGrantRow>(
        'SELECT * FROM promo_grants WHERE source_kind = $1 AND source_id = $2',
        [input.sourceKind, input.sourceId],
      );
      const row = existing.rows[0];
      if (!row) throw ApiError.conflict('That promotional grant is already closed', 'promo_grant_conflict');
      return { grant: toGrantDto(row), alreadyGranted: true };
    }
    const grant = inserted.rows[0];

    await tx.query('UPDATE users SET promo_diamond_balance = promo_diamond_balance + $2 WHERE id = $1', [
      input.userId,
      input.amount,
    ]);

    const face = await coinFaceMinor(tx);
    const minor = input.amount * face;
    if (minor > 0) {
      await postJournal(tx, {
        sourceKind: 'PROMO_GRANT',
        sourceId: grant.id,
        memo: `${grant.source_kind} grant — ${grant.amount} promotional diamonds to ${grant.user_id}: ${grant.reason}`.slice(0, 300),
        createdBy: grant.granted_by,
        lines: [
          { accountCode: FIN_ACCOUNTS.promoBudget, direction: 'DEBIT', amountCents: minor },
          { accountCode: FIN_ACCOUNTS.coinLiability, direction: 'CREDIT', amountCents: minor },
        ],
      });
    }

    return { grant: toGrantDto(grant), alreadyGranted: false };
  };

  return client ? run(client) : withTransaction(run);
}

export type PromoSpendAllocation = { grantId: string; diamonds: number };

/**
 * Take up to `needed` diamonds off the promotional balance, nearest expiry first.
 *
 * Returns what it actually took rather than throwing, because a spend is normally paid from two
 * pockets: the caller checks `diamond_balance + consumed` covers the price and then debits the rest
 * from purchased diamonds. Partial is the expected case, not the failure.
 *
 * The caller must already hold the lock on the user row — every coin path in this backend takes it
 * first, and grants are always locked second, which is what keeps a grant sweep and a gift send from
 * deadlocking on the same account.
 */
export async function planPromoSpend(
  client: PoolClient,
  input: { userId: string; needed: number; purpose: PromoPurpose },
): Promise<{ consumed: number; allocations: PromoSpendAllocation[] }> {
  if (input.needed <= 0) return { consumed: 0, allocations: [] };
  const policy = await promoPolicy(client);
  if (!policy.usableFor.includes(input.purpose)) return { consumed: 0, allocations: [] };

  const wallet = await client.query<{ promo_diamond_balance: number }>(
    'SELECT promo_diamond_balance FROM users WHERE id = $1',
    [input.userId],
  );
  if (!wallet.rows[0] || wallet.rows[0].promo_diamond_balance <= 0) return { consumed: 0, allocations: [] };

  // SKIP LOCKED is not needed and would be wrong: the user row is already held, so nothing else can be
  // consuming this account's grants. A plain FOR UPDATE is what makes the cached total and the grant
  // rows move together.
  const grants = await client.query<Pick<PromoGrantRow, 'id' | 'remaining'>> (
    `SELECT id, remaining FROM promo_grants
      WHERE user_id = $1 AND status = 'ACTIVE' AND remaining > 0
      ORDER BY expires_at ASC, created_at ASC
        FOR UPDATE`,
    [input.userId],
  );

  let left = Math.min(input.needed, wallet.rows[0].promo_diamond_balance);
  const allocations: PromoSpendAllocation[] = [];
  for (const grant of grants.rows) {
    if (left <= 0) break;
    const take = Math.min(grant.remaining, left);
    left -= take;
    allocations.push({ grantId: grant.id, diamonds: take });
    await client.query(
      `UPDATE promo_grants
          SET spent = spent + $2,
              remaining = remaining - $2,
              status = CASE WHEN remaining = $2 THEN 'EXHAUSTED'::promo_grant_status ELSE status END
        WHERE id = $1`,
      [grant.id, take],
    );
  }

  const consumed = allocations.reduce((sum, allocation) => sum + allocation.diamonds, 0);
  if (consumed > 0) {
    await client.query('UPDATE users SET promo_diamond_balance = promo_diamond_balance - $2 WHERE id = $1', [
      input.userId,
      consumed,
    ]);
  }
  return { consumed, allocations };
}

/**
 * Attach the spend receipts to the ledger row that paid for them.
 *
 * Separate from `planPromoSpend` because the transaction id does not exist when the balance moves —
 * the gift is posted a few statements later, in the same SQL transaction. Splitting it keeps the grant
 * decrements where the guard is and puts the receipts where the id is, and the unique
 * `(grant_id, transaction_id)` means a replayed gift cannot consume a grant twice.
 */
export async function recordPromoSpend(
  client: PoolClient,
  transactionId: string,
  allocations: readonly PromoSpendAllocation[],
): Promise<void> {
  for (const allocation of allocations) {
    await client.query(
      `INSERT INTO promo_grant_spends (grant_id, transaction_id, diamonds)
       VALUES ($1,$2,$3)
       ON CONFLICT (grant_id, transaction_id) DO NOTHING`,
      [allocation.grantId, transactionId, allocation.diamonds],
    );
  }
}

/**
 * Give bonus coins back after a reversal, grant by grant.
 *
 * Two outcomes, and both are needed for the book to stay whole. A grant still inside its expiry takes the
 * coins back into `remaining` — including an EXHAUSTED one, which returns to ACTIVE because `remaining > 0`
 * and `status = 'ACTIVE'` are the same fact under the CHECK the table carries — and the holder's pocket
 * grows. A grant whose expiry has passed takes them into `lapsed` instead: the reversal means those coins
 * bought nothing, so the liability the platform carries for them is released and no wallet changes.
 * Skipping either branch loses a coin — a refund that restores nothing leaves a purchased diamond in the
 * place of a bonus one, and a refund that mints a wallet credit leaves the same coin counted twice.
 *
 * `REVERSED` — the status for a grant the platform itself took back — receives nothing.
 * The receipt stays in every case, so the reversal reads as what happened to whom.
 */
export async function refundPromoDiamonds(
  client: PoolClient,
  transactionId: string,
): Promise<{ returned: number; lapsed: number }> {
  const rows = await client.query<{ grant_id: string; user_id: string; diamonds: number; live: boolean }>(
    `SELECT s.grant_id, g.user_id, s.diamonds,
            (g.status IN ('ACTIVE','EXHAUSTED') AND g.expires_at > now()) AS live
       FROM promo_grant_spends s
       JOIN promo_grants g ON g.id = s.grant_id
      WHERE s.transaction_id = $1
        AND g.status <> 'REVERSED'`,
    [transactionId],
  );

  let returned = 0;
  let lapsed = 0;
  let holder: string | null = null;
  for (const row of rows.rows) {
    holder = row.user_id;
    if (row.live) {
      await client.query(
        `UPDATE promo_grants
            SET spent = spent - $2,
                remaining = remaining + $2,
                status = 'ACTIVE'
          WHERE id = $1`,
        [row.grant_id, row.diamonds],
      );
      await client.query('UPDATE users SET promo_diamond_balance = promo_diamond_balance + $2 WHERE id = $1', [
        row.user_id,
        row.diamonds,
      ]);
      returned += row.diamonds;
    } else {
      // `remaining` does not move, so the amount identity `remaining = amount - spent - lapsed` holds and
      // the status stays whatever death it already died.
      await client.query('UPDATE promo_grants SET spent = spent - $2, lapsed = lapsed + $2 WHERE id = $1', [
        row.grant_id,
        row.diamonds,
      ]);
      lapsed += row.diamonds;
    }
  }

  if (lapsed > 0) {
    const face = await coinFaceMinor(client);
    const minor = lapsed * face;
    if (minor > 0) {
      await postJournal(client, {
        sourceKind: 'PROMO_LAPSE',
        // Keyed on the spend being reversed, not on the grant: one grant can legitimately have two
        // releases — its own expiry sweep and a later refund of a coin that had already been spent — and
        // `postJournal` writes one entry per (kind, id), so a grant key would silently drop the second.
        sourceId: transactionId,
        memo: `${lapsed} refunded promotional diamonds lapsed on return to ${holder}`.slice(0, 300),
        lines: [
          { accountCode: FIN_ACCOUNTS.coinLiability, direction: 'DEBIT', amountCents: minor },
          { accountCode: FIN_ACCOUNTS.promoBudget, direction: 'CREDIT', amountCents: minor },
        ],
      });
    }
  }
  return { returned, lapsed };
}

/**
 * Expire what the clock has overtaken.
 *
 * One sweep statement, then one journal entry per grant: the liability is released back to the
 * promotional budget it was minted against, which is why it is not booked as platform revenue — an
 * unspent campaign budget is money the platform keeps, but it is not a coin take, and a report that
 * mixes the two cannot be read.
 */
export async function lapsePromoGrants(limit = 500): Promise<{ lapsed: number; diamonds: number }> {
  return withTransaction(async (client) => {
    const due = await client.query<Pick<PromoGrantRow, 'id' | 'user_id' | 'remaining'>>(
      `SELECT id, user_id, remaining FROM promo_grants
        WHERE status = 'ACTIVE' AND remaining > 0 AND expires_at <= now()
        ORDER BY expires_at
        LIMIT $1
          FOR UPDATE`,
      [limit],
    );
    if (!due.rows.length) return { lapsed: 0, diamonds: 0 };

    const face = await coinFaceMinor(client);
    let diamonds = 0;
    for (const grant of due.rows) {
      await client.query(
        `UPDATE promo_grants
            SET lapsed = lapsed + remaining,
                remaining = 0,
                status = 'LAPSED'
          WHERE id = $1 AND status = 'ACTIVE' AND remaining > 0`,
        [grant.id],
      );
      await client.query('UPDATE users SET promo_diamond_balance = promo_diamond_balance - $2 WHERE id = $1', [
        grant.user_id,
        grant.remaining,
      ]);
      const minor = grant.remaining * face;
      if (minor > 0) {
        await postJournal(client, {
          sourceKind: 'PROMO_LAPSE',
          sourceId: grant.id,
          memo: `${grant.remaining} promotional diamonds expired unspent on ${grant.user_id}`.slice(0, 300),
          lines: [
            { accountCode: FIN_ACCOUNTS.coinLiability, direction: 'DEBIT', amountCents: minor },
            // Back to the budget it came from: an expiry is an expense the platform took back, not
            // income it earned. Booking it as revenue would make an unspent campaign look like a take.
            { accountCode: FIN_ACCOUNTS.promoBudget, direction: 'CREDIT', amountCents: minor },
          ],
        });
      }
      diamonds += grant.remaining;
    }
    return { lapsed: due.rows.length, diamonds };
  });
}

/** What a member has, and when each piece of it stops being theirs. */
export async function listPromoGrants(userId: string, includeSpent = false): Promise<PromoGrantDto[]> {
  const rows = includeSpent
    ? await many<PromoGrantRow>(
        `SELECT * FROM promo_grants WHERE user_id = $1
          ORDER BY (status = 'ACTIVE') DESC, expires_at ASC, created_at DESC LIMIT 50`,
        [userId],
      )
    : await many<PromoGrantRow>(
        `SELECT * FROM promo_grants WHERE user_id = $1 AND remaining > 0 ORDER BY expires_at ASC LIMIT 50`,
        [userId],
      );
  return rows.map(toGrantDto);
}
