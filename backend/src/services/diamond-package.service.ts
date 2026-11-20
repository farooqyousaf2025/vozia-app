import { many, one } from '../config/db';
import { DiamondPackageRow } from '../types/db';
import { ApiError } from '../utils/http';

/**
 * The paid-diamond catalogue and the first-recharge gate.
 *
 * Two rules live here so every caller reads the same answer:
 *
 *  * A price is read from `diamond_packages` by id, never from the request body. The client may
 *    draw any pack it likes; the server credits the diamonds and charges the cents on its row.
 *  * Spending diamonds is unlocked by one completed recharge. That is a product decision, not a
 *    fraud check, so it is applied where diamonds are spent (the store) and reported on the wallet
 *    so the app can explain the lock instead of showing a dead button.
 */

export type DiamondPackageDto = {
  id: string;
  code: string;
  name: string;
  diamonds: number;
  bonusDiamonds: number;
  /** Diamonds the buyer actually receives: the pack plus its advertised bonus. */
  totalDiamonds: number;
  priceCents: number;
  currency: string;
  sortOrder: number;
};

function toPackage(row: DiamondPackageRow): DiamondPackageDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    diamonds: row.diamonds,
    bonusDiamonds: row.bonus_diamonds,
    totalDiamonds: row.diamonds + row.bonus_diamonds,
    priceCents: row.price_cents,
    currency: row.currency,
    sortOrder: row.sort_order,
  };
}

/** The packs an operator has switched on, cheapest first. */
export async function listDiamondPackages(): Promise<DiamondPackageDto[]> {
  const rows = await many<DiamondPackageRow>(
    `SELECT id, code, name, diamonds, bonus_diamonds, price_cents, currency, sort_order
       FROM diamond_packages
      WHERE active
      -- 'name' and 'code' only break ties an operator left equal; the ordering the buyer sees is
      -- the one the panel set.
      ORDER BY sort_order, diamonds, name, code`,
  );
  return rows.map(toPackage);
}

/**
 * The pack behind a checkout request. A missing or retired id is a 404 rather than a silent
 * fallback to the client's amount: falling back would let an old APK post any price.
 */
export async function resolveDiamondPackage(id: string): Promise<DiamondPackageDto> {
  const row = await one<DiamondPackageRow>(
    `SELECT id, code, name, diamonds, bonus_diamonds, price_cents, currency, sort_order
       FROM diamond_packages
      WHERE id = $1 AND active`,
    [id],
  );
  if (!row) throw ApiError.notFound('That diamond package is not available', 'package_not_available');
  return toPackage(row);
}

export type FirstRechargeStatus = {
  /** True until the account has one completed RECHARGE row. */
  required: boolean;
  completed: boolean;
  completedAt: string | null;
  /** Every completed recharge, so the wallet can show progress rather than a binary. */
  count: number;
};

type FirstRechargeRow = { count: string; first_at: Date | null };

/**
 * Derived from the ledger, not a counter column: a refund or a repaired row must not leave an
 * account "unlocked" on the strength of a flag that no transaction backs.
 */
export async function firstRechargeStatus(userId: string): Promise<FirstRechargeStatus> {
  const row = await one<FirstRechargeRow>(
    `SELECT COUNT(*)::text AS count, MIN(created_at) AS first_at
       FROM transactions
      WHERE receiver_id = $1 AND type = 'RECHARGE' AND status = 'COMPLETED'`,
    [userId],
  );
  const count = Number(row?.count ?? 0);
  const completed = count > 0;
  return {
    required: !completed,
    completed,
    completedAt: row?.first_at ? row.first_at.toISOString() : null,
    count,
  };
}

/**
 * Throws `first_recharge_required` when the account has never topped up. Callers that debit
 * diamonds for a purchase call this before taking a lock, so the refusal names the real reason a
 * member cannot buy rather than an empty balance.
 */
export async function assertFirstRechargeDone(userId: string): Promise<void> {
  const status = await firstRechargeStatus(userId);
  if (!status.completed) {
    throw ApiError.forbidden(
      'Complete your first recharge to unlock diamond purchases',
      'first_recharge_required',
      { firstRecharge: status },
    );
  }
}
