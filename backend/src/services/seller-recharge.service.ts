import { PoolClient } from 'pg';
import { many, one, withTransaction } from '../config/db';
import {
  BusinessAccountRow,
  RechargeOrderRow,
  RechargeOrderStatus,
  RechargePackageRow,
  UserRow,
} from '../types/db';
import { ApiError, normalizePhone } from '../utils/http';
import { shortCode } from '../utils/ids';
import { RechargeOrderDto, toRechargeOrder } from '../utils/serialize';
import { recordAudit } from './audit.service';
import { emitToUser } from './socket.service';
import { postLedgerMoves, settlePaymentOnClient } from './ledger.service';
import { ensureRankRegistry } from './rank.service';
import {
  accrueOrderCommissions,
  planOrderCommissions,
  recordRulesSnapshot,
  reverseOrderCommissions,
} from './commission.service';
import { FIN_ACCOUNTS, postJournal } from './finance-journal.service';

/**
 * The seller-initiated recharge (§22), end to end.
 *
 * Nine steps in the programme's own order: a seller opens an order, the backend validates the
 * partner, the customer, the package, the price and the seller's limits, a unique reference is
 * minted, the payment is verified through a configured process, coins are credited exactly
 * once, the credit and its money-side entries are recorded, seller and BD commission accrue,
 * both sides are told the status, and a failure or reversal follows the reconciliation path.
 *
 * Two rules shape everything below.
 *
 * First, a seller's word is not a payment. `markOrderPaid` can only move an order to
 * `AWAITING_VERIFICATION`; coins move when finance approves it or a payment provider confirms
 * it, and §22 says so explicitly.
 *
 * Second, the credit and the commission and the journal are one decision. They happen inside a
 * single SQL transaction on one locked order row, reusing `settlePaymentOnClient` (whose
 * `payment_proofs` unique key is what makes "at most once" a database fact rather than a
 * convention) instead of a second recharge implementation.
 */

export const MANUAL_RAILS = ['CASH', 'BANK', 'EASYPAISA', 'JAZZCASH'] as const;
const SELLER_PROVIDER = 'seller';

const ORDER_SELECT = `
  SELECT o.*, s.code AS seller_code, s.display_name AS seller_name,
         b.code AS bd_code, u.username
    FROM recharge_orders o
    JOIN business_accounts s ON s.id = o.seller_id
    LEFT JOIN business_accounts b ON b.id = o.bd_id
    JOIN users u ON u.id = o.user_id`;

type RechargeConfig = {
  orderValidityMinutes: number;
  manualEvidenceRequired: boolean;
  autoCreditFromProvider: boolean;
};

/**
 * The three limit violations the trigger raises, by name. The message is the trigger's, so it
 * is matched rather than reparsed, and an unknown database error is never dressed up as one of
 * these.
 */
const LIMIT_ERRORS = ['seller_order_diamond_limit', 'seller_daily_order_limit', 'seller_daily_diamond_limit'] as const;

const limitMessage = (code: (typeof LIMIT_ERRORS)[number]): string =>
  code === 'seller_order_diamond_limit'
    ? 'This package is over the seller’s per-order diamond limit'
    : code === 'seller_daily_order_limit'
      ? 'This seller has reached its daily order limit'
      : 'This order would exceed the seller’s daily diamond limit';

async function rechargeConfig(): Promise<RechargeConfig> {
  const row = await one<{ value: RechargeConfig }>('SELECT value FROM system_config WHERE key = $1', [
    'business.recharge',
  ]);
  return {
    orderValidityMinutes: 60,
    manualEvidenceRequired: true,
    autoCreditFromProvider: true,
    ...(row?.value ?? {}),
  };
}

// ---------------------------------------------------------------------------
// The package catalog (§22: the administrator configures what a seller may sell)
// ---------------------------------------------------------------------------

export type PackageInput = {
  key: string;
  label: string;
  diamonds: number;
  amountCents: number;
  currency?: string;
  feeBps?: number;
};

export async function listPackages(opts: { includeInactive?: boolean } = {}): Promise<RechargePackageRow[]> {
  return many<RechargePackageRow>(
    `SELECT * FROM recharge_packages ${opts.includeInactive ? '' : 'WHERE is_active'} ORDER BY amount_cents`,
  );
}

/**
 * The packages one seller may actually sell. An empty allowlist means every active package;
 * once the finance team pins a set, only those are offered.
 */
export async function listPackagesForSeller(sellerId: string): Promise<RechargePackageRow[]> {
  return many<RechargePackageRow>(
    `SELECT p.* FROM recharge_packages p
      WHERE p.is_active
        AND (NOT EXISTS (SELECT 1 FROM recharge_package_sellers a WHERE a.business_account_id = $1)
             OR EXISTS (SELECT 1 FROM recharge_package_sellers a
                         WHERE a.business_account_id = $1 AND a.package_key = p.key))
      ORDER BY p.amount_cents`,
    [sellerId],
  );
}

/**
 * The explicit allowlist only, without the "empty means everything" fallback applied. An
 * operator editing the set has to see what is actually pinned, not the resolved list.
 */
export async function listSellerPackageKeys(sellerId: string): Promise<string[]> {
  const rows = await many<{ package_key: string }>(
    'SELECT package_key FROM recharge_package_sellers WHERE business_account_id = $1 ORDER BY package_key',
    [sellerId],
  );
  return rows.map((row) => row.package_key);
}

export async function savePackage(adminId: string, input: PackageInput): Promise<RechargePackageRow> {
  if (!/^[a-z0-9_]{2,48}$/i.test(input.key)) throw ApiError.badRequest('Package key must be a short slug', 'bad_key');
  if (!Number.isInteger(input.diamonds) || input.diamonds < 1) throw ApiError.badRequest('Package needs a diamond count');
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) throw ApiError.badRequest('Package needs a price');
  const feeBps = input.feeBps ?? 0;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw ApiError.badRequest('feeBps must be 0..10000');

  const row = await withTransaction(async (client) => {
    const result = await client.query<RechargePackageRow>(
      `INSERT INTO recharge_packages (key, label, diamonds, amount_cents, currency, fee_bps)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, diamonds = EXCLUDED.diamonds,
                                       amount_cents = EXCLUDED.amount_cents, currency = EXCLUDED.currency,
                                       fee_bps = EXCLUDED.fee_bps, is_active = true
       RETURNING *`,
      [input.key, input.label, input.diamonds, input.amountCents, input.currency ?? 'pkr', feeBps],
    );
    await recordAudit(
      {
        adminId,
        action: 'RECHARGE_PACKAGE_SAVE',
        targetType: 'recharge_package',
        targetId: input.key,
        summary: `Package ${input.key}: ${input.diamonds} diamonds for ${input.amountCents} ${result.rows[0].currency}`,
        details: { ...input },
      },
      client,
    );
    return result.rows[0];
  });
  return row;
}

export async function setPackageActive(adminId: string, key: string, isActive: boolean): Promise<RechargePackageRow> {
  const row = await withTransaction(async (client) => {
    const result = await client.query<RechargePackageRow>(
      'UPDATE recharge_packages SET is_active = $2 WHERE key = $1 RETURNING *',
      [key, isActive],
    );
    if (!result.rows.length) throw ApiError.notFound('Package not found');
    await recordAudit(
      {
        adminId,
        action: isActive ? 'RECHARGE_PACKAGE_ACTIVATE' : 'RECHARGE_PACKAGE_DEACTIVATE',
        targetType: 'recharge_package',
        targetId: key,
        summary: `${isActive ? 'Enabled' : 'Disabled'} package ${key}`,
      },
      client,
    );
    return result.rows[0];
  });
  return row;
}

/** Replace a seller's permitted set. Passing an empty array means "all active packages again". */
export async function setSellerPackages(
  adminId: string,
  sellerId: string,
  packageKeys: string[],
): Promise<{ sellerId: string; packageKeys: string[] }> {
  const seller = await one<BusinessAccountRow>('SELECT * FROM business_accounts WHERE id = $1', [sellerId]);
  if (!seller) throw ApiError.notFound('Business account not found');
  if (seller.kind !== 'COIN_SELLER') throw ApiError.badRequest('Only coin sellers have a permitted package list', 'not_a_seller');

  await withTransaction(async (client) => {
    await client.query('DELETE FROM recharge_package_sellers WHERE business_account_id = $1', [sellerId]);
    for (const key of packageKeys) {
      const inserted = await client.query(
        'INSERT INTO recharge_package_sellers (package_key, business_account_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [key, sellerId],
      );
      if (inserted.rowCount === 0) throw ApiError.badRequest(`Unknown package ${key}`, 'unknown_package');
    }
    await recordAudit(
      {
        adminId,
        action: 'BUSINESS_PACKAGE_ASSIGN',
        targetType: 'business_account',
        targetId: sellerId,
        summary: `Set permitted packages for ${seller.code}`,
        details: { packageKeys },
      },
      client,
    );
  });
  return { sellerId, packageKeys };
}

// ---------------------------------------------------------------------------
// Step 1-3: open an order
// ---------------------------------------------------------------------------

/**
 * Diamonds and price come from the package row, never the request body. A seller submitting
 * "1000 diamonds for 100 paisa" is not a price the platform will honour, and this is the only
 * place an order's money values are decided.
 */
export async function createRechargeOrder(
  seller: BusinessAccountRow,
  input: { phone: string; packageKey: string; paymentMethod: string; note?: string },
): Promise<RechargeOrderDto> {
  if (seller.kind !== 'COIN_SELLER') throw ApiError.forbidden('Only coin sellers may open recharge orders', 'not_a_seller');

  const paymentMethod = input.paymentMethod.trim().toUpperCase();
  if (!MANUAL_RAILS.includes(paymentMethod as (typeof MANUAL_RAILS)[number])) {
    throw ApiError.badRequest(
      `Unknown payment rail ${paymentMethod}. Seller-opened orders use one of ${MANUAL_RAILS.join(', ')}`,
      'unknown_payment_method',
    );
  }

  const config = await rechargeConfig();
  const phone = normalizePhone(input.phone);
  if (phone === seller.contact_phone) throw ApiError.badRequest('A seller cannot recharge their own contact number', 'self_recharge');

  const packageRow = await one<RechargePackageRow>(
    `SELECT * FROM recharge_packages WHERE key = $1 AND is_active`,
    [input.packageKey],
  );
  if (!packageRow) throw ApiError.notFound('That package is not on the catalog', 'unknown_package');

  const permitted = await listPackagesForSeller(seller.id);
  if (!permitted.some((p) => p.key === packageRow.key)) {
    throw ApiError.forbidden('This seller is not permitted to sell that package', 'package_not_permitted');
  }

  const amountCents = Number(packageRow.amount_cents);
  const feeCents = Math.floor((amountCents * packageRow.fee_bps) / 10_000);

  const order = await withTransaction(async (client) => {
    const customer = await client.query<UserRow>(
      'SELECT * FROM users WHERE phone = $1 FOR UPDATE',
      [phone],
    );
    const user = customer.rows[0];
    if (!user) throw ApiError.notFound('No account with that phone number', 'customer_not_found');
    if (user.status === 'BANNED') throw ApiError.forbidden('That account is banned', 'account_banned');

    // §22's per-seller limits, read as of this moment and enforced before anything is written.
    if (packageRow.diamonds > seller.max_order_diamonds) {
      throw ApiError.forbidden(
        `${packageRow.diamonds} diamonds is over this seller's per-order limit of ${seller.max_order_diamonds}`,
        'order_limit_exceeded',
        { limit: seller.max_order_diamonds },
      );
    }
    const today = await client.query<{ orders: string; diamonds: string }>(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(diamonds),0) AS diamonds
         FROM recharge_orders
        WHERE seller_id = $1 AND created_at >= date_trunc('day', now())
          AND status NOT IN ('CANCELLED','EXPIRED','REJECTED')`,
      [seller.id],
    );
    const openOrders = Number(today.rows[0]?.orders ?? 0);
    const openDiamonds = Number(today.rows[0]?.diamonds ?? 0);
    if (openOrders >= seller.daily_order_limit) {
      throw ApiError.forbidden('This seller has reached its daily order limit', 'daily_order_limit');
    }
    if (openDiamonds + packageRow.diamonds > seller.daily_diamond_limit) {
      throw ApiError.forbidden('This order would exceed the seller’s daily diamond limit', 'daily_diamond_limit', {
        used: openDiamonds,
        limit: seller.daily_diamond_limit,
      });
    }

    // Attribution frozen now: moving the seller to another BD next month must not rewrite
    // whose volume this order was.
    let bdId = seller.parent_id;
    if (bdId) {
      const parent = await client.query<BusinessAccountRow>('SELECT * FROM business_accounts WHERE id = $1', [bdId]);
      if (parent.rows[0]?.kind === 'BD_MANAGER') bdId = parent.rows[0].parent_id ?? bdId;
    }

    const inserted = await client.query<RechargeOrderRow>(
      `INSERT INTO recharge_orders
         (reference, seller_id, bd_id, user_id, package_key, diamonds, amount_cents, currency,
          payment_method, fee_cents, expires_at, evidence, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' minutes')::interval, $12, 'AWAITING_PAYMENT')
       RETURNING *`,
      [
        shortCode('RO-'),
        seller.id,
        bdId,
        user.id,
        packageRow.key,
        packageRow.diamonds,
        amountCents,
        packageRow.currency,
        paymentMethod,
        feeCents,
        String(config.orderValidityMinutes),
        JSON.stringify({ note: input.note ?? null, submittedPhone: phone }),
      ],
    ).catch((err: { message?: string }) => {
      // The trigger is the authority when two requests race: it locks the seller row and counts
      // what is already open, so the second transaction sees the first one's order. The checks
      // above exist to give a clear message early; this exists to be true under concurrency.
      const raced = LIMIT_ERRORS.find((code) => (err?.message ?? '').includes(code));
      if (raced) throw ApiError.forbidden(limitMessage(raced), raced);
      throw err;
    });
    const created = inserted.rows[0];

    await recordAudit(
      {
        adminId: null,
        businessId: seller.id,
        action: 'RECHARGE_ORDER_CREATE',
        targetType: 'recharge_order',
        targetId: created.id,
        summary: `${seller.code} opened ${created.reference}: ${created.diamonds} diamonds for ${amountCents} ${created.currency}`,
        details: { packageKey: packageRow.key, paymentMethod, userId: user.id, bdId },
      },
      client,
    );
    return created;
  });

  return toRechargeOrder(await enrichedOrder(order.id));
}

// ---------------------------------------------------------------------------
// Step 4: the seller says it is paid — which is a claim, not a payment
// ---------------------------------------------------------------------------

export async function markOrderPaid(
  seller: BusinessAccountRow,
  orderId: string,
  input: { paymentRef: string; evidence: Record<string, unknown> },
): Promise<RechargeOrderDto> {
  const config = await rechargeConfig();
  const evidence = input.evidence ?? {};
  const hasEvidence = Object.keys(evidence).length > 0;
  if (config.manualEvidenceRequired && !hasEvidence) {
    throw ApiError.badRequest(
      'Attach the payment evidence (receipt, transaction id, or operator note) before marking an order paid',
      'evidence_required',
    );
  }
  const paymentRef = input.paymentRef.trim();
  if (paymentRef.length < 4) throw ApiError.badRequest('The payment reference is too short to be useful', 'bad_payment_ref');

  const row = await withTransaction(async (client) => {
    const current = await lockOrder(client, orderId);
    if (current.seller_id !== seller.id) throw ApiError.forbidden('This order belongs to another seller', 'not_your_order');
    if (current.status !== 'AWAITING_PAYMENT') {
      throw ApiError.conflict(`Order ${current.reference} is already ${current.status}`, 'invalid_state');
    }

    const updated = await client.query<RechargeOrderRow>(
      `UPDATE recharge_orders
          SET status = 'AWAITING_VERIFICATION', payment_ref = $2, evidence = $3
        WHERE id = $1 RETURNING *`,
      [orderId, paymentRef, JSON.stringify({ ...evidence, paymentRef })],
    );
    await recordAudit(
      {
        adminId: null,
        businessId: seller.id,
        action: 'RECHARGE_ORDER_MARKED_PAID',
        targetType: 'recharge_order',
        targetId: orderId,
        summary: `${seller.code} claims ${paymentRef} paid for ${current.reference} — awaiting verification`,
        details: { paymentRef, evidenceKeys: Object.keys(evidence) },
      },
      client,
    );
    return updated.rows[0];
  });

  return toRechargeOrder(await enrichedOrder(row.id));
}

export async function cancelOrder(seller: BusinessAccountRow, orderId: string, reason: string): Promise<RechargeOrderDto> {
  const row = await withTransaction(async (client) => {
    const current = await lockOrder(client, orderId);
    if (current.seller_id !== seller.id) throw ApiError.forbidden('This order belongs to another seller', 'not_your_order');
    if (current.status !== 'AWAITING_PAYMENT' && current.status !== 'AWAITING_VERIFICATION') {
      throw ApiError.conflict(`Order ${current.reference} is ${current.status} and cannot be withdrawn`, 'invalid_state');
    }
    const updated = await client.query<RechargeOrderRow>(
      `UPDATE recharge_orders SET status = 'CANCELLED', decision_note = $2 WHERE id = $1 RETURNING *`,
      [orderId, reason.slice(0, 200)],
    );
    await recordAudit(
      {
        adminId: null,
        businessId: seller.id,
        action: 'RECHARGE_ORDER_CANCEL',
        targetType: 'recharge_order',
        targetId: orderId,
        summary: `${seller.code} withdrew ${current.reference}: ${reason}`,
      },
      client,
    );
    return updated.rows[0];
  });
  return toRechargeOrder(await enrichedOrder(row.id));
}

// ---------------------------------------------------------------------------
// Steps 5-8: verification, credit, commission, notification
// ---------------------------------------------------------------------------

/**
 * Finance approves a manual order. Everything the money side cares about happens here, in one
 * transaction, in the programme's order: coins, the ledger row, the collection journal, then
 * commission for the seller and the BD.
 */
export async function approveOrder(
  adminId: string,
  orderId: string,
  input: { decisionNote?: string; feeCents?: number } = {},
): Promise<{ order: RechargeOrderDto; credited: boolean }> {
  const outcome = await withTransaction(async (client) => creditOrder(client, orderId, { byAdmin: adminId, ...input }));
  notify(outcome);
  return { order: toRechargeOrder(await enrichedOrder(outcome.order.id)), credited: outcome.credited };
}

/**
 * Reject: no coins, no commission, and a reason a seller can read. Recorded rather than
 * deleted, because "who asked for what and why it was refused" is the reconciliation question.
 */
export async function rejectOrder(adminId: string, orderId: string, reason: string): Promise<RechargeOrderDto> {
  if (!reason || reason.trim().length < 3) throw ApiError.badRequest('A rejection needs a reason');
  const row = await withTransaction(async (client) => {
    const current = await lockOrder(client, orderId);
    if (current.status !== 'AWAITING_VERIFICATION') {
      throw ApiError.conflict(`Order ${current.reference} is ${current.status}, not awaiting verification`, 'invalid_state');
    }
    const updated = await client.query<RechargeOrderRow>(
      `UPDATE recharge_orders SET status = 'REJECTED', verified_by = $2, verified_at = now(), decision_note = $3
        WHERE id = $1 RETURNING *`,
      [orderId, adminId, reason.slice(0, 200)],
    );
    await recordAudit(
      {
        adminId,
        action: 'RECHARGE_ORDER_REJECT',
        targetType: 'recharge_order',
        targetId: orderId,
        summary: `Rejected ${current.reference}: ${reason}`,
      },
      client,
    );
    return updated.rows[0];
  });
  emitToUser(row.user_id, 'wallet:recharge_status', { reference: row.reference, status: 'REJECTED' });
  return toRechargeOrder(await enrichedOrder(row.id));
}

/**
 * A payment provider confirms money arrived. Whether that alone credits the coins is an
 * administrator switch: §22 wants manual verification gated by evidence and approval, and
 * §7's compliance posture says do not let a callback release value nobody reviewed.
 */
export async function verifyProviderPayment(input: {
  provider: string;
  externalId: string;
  amountCents?: number;
  feeCents?: number;
  meta?: Record<string, unknown>;
}): Promise<{ matched: boolean; order?: RechargeOrderDto; credited: boolean }> {
  const config = await rechargeConfig();
  const order = await one<RechargeOrderRow>(
    `${ORDER_SELECT} WHERE o.provider = $1 AND o.external_id = $2`,
    [input.provider, input.externalId],
  );
  if (!order) return { matched: false, credited: false };

  if (!config.autoCreditFromProvider) {
    if (order.status === 'AWAITING_PAYMENT') {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE recharge_orders SET status = 'AWAITING_VERIFICATION', payment_ref = COALESCE(payment_ref,$2),
                  evidence = evidence || $3::jsonb
            WHERE id = $1 AND status = 'AWAITING_PAYMENT'`,
          [order.id, input.externalId, JSON.stringify({ providerConfirmation: input.meta ?? {} })],
        );
      });
    }
    return { matched: true, order: toRechargeOrder(await enrichedOrder(order.id)), credited: false };
  }

  if (order.status === 'CREDITED') return { matched: true, order: toRechargeOrder(order), credited: false };

  const outcome = await withTransaction(async (client) =>
    creditOrder(client, order.id, {
      byAdmin: null,
      bySystem: `provider:${input.provider}`,
      feeCents: input.feeCents ?? Number(order.fee_cents ?? 0),
      decisionNote: `Provider ${input.provider} confirmed ${input.externalId}`,
    }),
  );
  notify(outcome);
  return { matched: true, order: toRechargeOrder(await enrichedOrder(outcome.order.id)), credited: outcome.credited };
}

/**
 * The credit itself. Takes the caller's client so a webhook handler and this service share one
 * transaction, and returns the already-credited order untouched when the work was done before —
 * a duplicate notification is an acknowledgement, not a second payment.
 */
async function creditOrder(
  client: PoolClient,
  orderId: string,
  opts: { byAdmin: string | null; bySystem?: string; decisionNote?: string; feeCents?: number },
): Promise<{ order: RechargeOrderRow; credited: boolean; commissionCents: number; diamondBalance: number | null }> {
  // Crediting an order returns a wallet, and a wallet resolves a rank — see ensureRankRegistry.
  await ensureRankRegistry();
  const order = await lockOrder(client, orderId);
  if (order.status === 'CREDITED') return { order, credited: false, commissionCents: 0, diamondBalance: null };
  if (order.status !== 'AWAITING_VERIFICATION' && order.status !== 'AWAITING_PAYMENT') {
    throw ApiError.conflict(`Order ${order.reference} is ${order.status} and cannot be credited`, 'invalid_state');
  }
  if (order.expires_at && order.expires_at.getTime() < Date.now()) {
    throw ApiError.conflict(
      `Order ${order.reference} expired before it was verified; open a new one instead of crediting a stale claim`,
      'order_expired',
    );
  }

  const amountCents = Number(order.amount_cents);
  const feeCents = Math.max(0, Math.min(opts.feeCents ?? Number(order.fee_cents ?? 0), amountCents));

  // Seller-opened orders prove themselves with their own reference, which is unique on the
  // order row and on the proof table — so even a hand-edited duplicate cannot double-issue coins.
  const settled = await settlePaymentOnClient(client, {
    userId: order.user_id,
    diamonds: order.diamonds,
    provider: order.provider ?? SELLER_PROVIDER,
    externalId: order.external_id ?? order.reference,
    amountCents,
    currency: order.currency,
    meta: { rechargeOrderId: order.id, reference: order.reference, sellerId: order.seller_id, bdId: order.bd_id },
  });
  if (!settled?.credited) {
    const raced = await lockOrder(client, orderId);
    if (raced.status === 'CREDITED') return { order: raced, credited: false, commissionCents: 0, diamondBalance: null };
    throw ApiError.conflict('A payment for this reference was already settled', 'duplicate_payment');
  }

  const plan = await planOrderCommissions({
    sellerId: order.seller_id,
    bdId: order.bd_id,
    amountCents,
    feeCents,
    periodVolumeCents: await sellerVolumeCents(client, order.seller_id, order.created_at) + amountCents,
    at: new Date(),
    client,
  });
  const accrued = await accrueOrderCommissions(client, {
    order: { id: order.id, reference: order.reference, currency: order.currency },
    lines: plan.lines,
  });
  await recordRulesSnapshot(client, order.id, {
    capturedAt: new Date().toISOString(),
    calculationOrder: plan.config.enabled,
    maxAllocationBps: plan.config.maxAllocationBps,
    basisNetCents: plan.netCents,
    ceilingCents: plan.ceilingCents,
    lines: plan.lines.map((line) => ({
      kind: line.kind,
      beneficiary: line.beneficiary,
      ruleId: line.ruleId,
      ruleVersion: line.ruleVersion,
      amountCents: line.amountCents,
    })),
  });

  // The collection is booked against the coin liability it created, never as revenue: coins are
  // a service still owed (§25). Fees and commission sit on their own accounts.
  await postJournal(client, {
    sourceKind: 'RECHARGE_ORDER',
    sourceId: order.id,
    memo: `Seller recharge ${order.reference}: ${order.diamonds} diamonds for ${amountCents} ${order.currency}`,
    currency: order.currency,
    createdBy: opts.byAdmin,
    lines: [
      { accountCode: FIN_ACCOUNTS.providerCollections, direction: 'DEBIT', amountCents: amountCents - feeCents },
      { accountCode: FIN_ACCOUNTS.providerFees, direction: 'DEBIT', amountCents: feeCents },
      { accountCode: FIN_ACCOUNTS.coinLiability, direction: 'CREDIT', amountCents },
    ],
  });

  const updated = await client.query<RechargeOrderRow>(
    `UPDATE recharge_orders
        SET status = 'CREDITED', transaction_id = $2, fee_cents = $3, verified_by = COALESCE($4, verified_by),
            verified_at = now(), decision_note = $5, expires_at = NULL
      WHERE id = $1 RETURNING *`,
    [order.id, settled.transaction?.id ?? null, feeCents, opts.byAdmin, opts.decisionNote?.slice(0, 200) ?? null],
  );
  const creditedRow = updated.rows[0];

  await recordAudit(
    {
      adminId: opts.byAdmin,
      businessId: null,
      actorSystem: opts.byAdmin ? null : opts.bySystem ?? 'provider',
      action: 'RECHARGE_ORDER_CREDIT',
      targetType: 'recharge_order',
      targetId: order.id,
      summary: `Credited ${order.reference}: ${order.diamonds} diamonds, ${accrued.entries.length} commission lines`,
      details: {
        userId: order.user_id,
        sellerId: order.seller_id,
        bdId: order.bd_id,
        amountCents,
        feeCents,
        transactionId: settled.transaction?.id ?? null,
        entries: accrued.entries.map((e) => ({ kind: e.kind, beneficiary: e.beneficiary, amountCents: Number(e.amount_cents) })),
      },
    },
    client,
  );

  const commissionCents = accrued.entries.reduce((sum, e) => sum + Number(e.amount_cents), 0);
  return { order: creditedRow, credited: true, commissionCents, diamondBalance: settled.user?.diamondBalance ?? null };
}

/**
 * Step 9: both sides are told. The customer's `wallet:update` carries the post-image balance the
 * ledger already computed — the same shape the Stripe path and gifts use, so no client has to
 * learn a second way to hear that coins arrived. The seller sees its own order move.
 */
function notify(outcome: { order: RechargeOrderRow; credited: boolean; diamondBalance: number | null }): void {
  if (!outcome.credited) return;
  emitToUser(outcome.order.user_id, 'wallet:update', {
    diamondBalance: outcome.diamondBalance ?? undefined,
    source: 'seller_recharge',
    reference: outcome.order.reference,
  });
  emitToUser(outcome.order.user_id, 'wallet:recharge_status', { reference: outcome.order.reference, status: 'CREDITED' });
}

/**
 * Refunded or charged back after the coins went out.
 *
 * The posted rows stay. Coins are clawed back with a compensating debit for as much as the
 * balance still holds — a customer who already spent them cannot be driven negative, and the
 * shortfall is recorded rather than hidden — while the commission accruals are reversed and the
 * journal shows the collection coming back off the coin liability.
 */
export async function reverseOrder(
  adminId: string,
  orderId: string,
  input: { reason: string; refundCents?: number; clawback: boolean },
): Promise<RechargeOrderDto> {
  if (!input.reason || input.reason.trim().length < 3) throw ApiError.badRequest('A reversal needs a reason');

  const row = await withTransaction(async (client) => {
    const order = await lockOrder(client, orderId);
    if (order.status !== 'CREDITED') {
      throw ApiError.conflict(`Only a credited order can be reversed; ${order.reference} is ${order.status}`, 'invalid_state');
    }

    const refundCents = input.refundCents ?? Number(order.amount_cents);
    if (refundCents < 0 || refundCents > Number(order.amount_cents)) {
      throw ApiError.badRequest('A reversal cannot refund more than the order collected', 'bad_refund_amount');
    }

    const reversal = await client.query<{ balance: number }>('SELECT diamond_balance AS balance FROM users WHERE id = $1 FOR UPDATE', [
      order.user_id,
    ]);
    const balance = Number(reversal.rows[0]?.balance ?? 0);
    const clawback = input.clawback ? Math.min(balance, order.diamonds) : 0;

    let clawbackTransactionId: string | null = null;
    if (clawback > 0) {
      const posted = await postLedgerMoves(client, [
        {
          type: 'RECHARGE_REVERSAL',
          direction: 'debit',
          userId: order.user_id,
          diamonds: clawback,
          note: `Clawback of ${order.reference}: ${input.reason}`.slice(0, 200),
          meta: { rechargeOrderId: order.id, reference: order.reference, clawedBack: true },
          insufficientMessage: 'The customer no longer holds these diamonds',
        },
      ]);
      clawbackTransactionId = posted[0]?.transactionId ?? null;
    }

    const { reversed, amountCents } = await reverseOrderCommissions(client, {
      orderId: order.id,
      orderReference: order.reference,
      reason: input.reason,
    });

    const feePortion = Number(order.amount_cents)
      ? Math.floor((Number(order.fee_cents) * refundCents) / Number(order.amount_cents))
      : 0;
    if (refundCents > 0) {
      await postJournal(client, {
        sourceKind: 'REVERSAL',
        sourceId: `order:${order.id}`,
        memo: `Reversed ${order.reference}: ${refundCents} ${order.currency} returned, ${clawback} diamonds clawed back`,
        currency: order.currency,
        createdBy: adminId,
        lines: [
          { accountCode: FIN_ACCOUNTS.coinLiability, direction: 'DEBIT', amountCents: refundCents },
          { accountCode: FIN_ACCOUNTS.providerCollections, direction: 'CREDIT', amountCents: refundCents - feePortion },
          { accountCode: FIN_ACCOUNTS.providerFees, direction: 'CREDIT', amountCents: feePortion },
        ],
      });
    }

    const updated = await client.query<RechargeOrderRow>(
      `UPDATE recharge_orders
          SET status = 'REVERSED', reversed_at = now(), reversal_reason = $2, reverses_amount_cents = $3
        WHERE id = $1 RETURNING *`,
      [order.id, input.reason.slice(0, 200), refundCents],
    );
    const reversedRow = updated.rows[0];

    await recordAudit(
      {
        adminId,
        action: 'RECHARGE_ORDER_REVERSE',
        targetType: 'recharge_order',
        targetId: order.id,
        summary: `Reversed ${order.reference}: ${refundCents} refunded, ${clawback}/${order.diamonds} diamonds clawed back, ${reversed} commission lines`,
        details: {
          reason: input.reason,
          refundCents,
          clawback,
          shortDiamonds: order.diamonds - clawback,
          commissionReversedCents: amountCents,
          clawbackTransactionId,
        },
      },
      client,
    );
    return reversedRow;
  });

  emitToUser(row.user_id, 'wallet:recharge_status', { reference: row.reference, status: 'REVERSED' });
  return toRechargeOrder(await enrichedOrder(row.id));
}

/** Orders that aged out of the verification window. Called by the sweep, not by a client. */
export async function expireStaleOrders(): Promise<{ expired: number; references: string[] }> {
  // The sweep runs unattended, so it signs its own audit lines: an order that changed state
  // while nobody was watching is exactly the kind of change the trail exists for.
  return withTransaction(async (client) => {
    const rows = await client.query<{ id: string; reference: string }>(
      `UPDATE recharge_orders
          SET status = 'EXPIRED'
        WHERE status IN ('AWAITING_PAYMENT','AWAITING_VERIFICATION')
          AND expires_at IS NOT NULL AND expires_at < now()
        RETURNING id, reference`,
    );
    for (const row of rows.rows) {
      await recordAudit(
        {
          adminId: null,
          actorSystem: 'recharge-expiry-sweep',
          action: 'RECHARGE_ORDER_EXPIRE',
          targetType: 'recharge_order',
          targetId: row.id,
          summary: `${row.reference} aged out of the payment window`,
        },
        client,
      );
    }
    return { expired: rows.rowCount ?? 0, references: rows.rows.map((r) => r.reference) };
  });
}

// ---------------------------------------------------------------------------
// Reading: what the seller, the BD and finance are allowed to see
// ---------------------------------------------------------------------------

async function lockOrder(client: PoolClient, orderId: string): Promise<RechargeOrderRow> {
  // Read under the row lock: two approvals of the same order must serialize, and the second
  // one has to see the first one's status, not the snapshot its transaction started with.
  const result = await client.query<RechargeOrderRow>('SELECT * FROM recharge_orders WHERE id = $1 FOR UPDATE', [
    orderId,
  ]);
  const row = result.rows[0];
  if (!row) throw ApiError.notFound('Recharge order not found');
  return row;
}

async function enrichedOrder(orderId: string) {
  const row = await one<RechargeOrderRow & { seller_code?: string; seller_name?: string; bd_code?: string; username?: string }>(
    `${ORDER_SELECT} WHERE o.id = $1`,
    [orderId],
  );
  if (!row) throw ApiError.notFound('Recharge order not found');
  return row;
}

async function sellerVolumeCents(client: PoolClient, sellerId: string, since: Date): Promise<number> {
  const periodFrom = new Date(since);
  periodFrom.setDate(1);
  periodFrom.setHours(0, 0, 0, 0);
  const row = await client.query<{ total: string | number | null }>(
    `SELECT COALESCE(SUM(amount_cents - fee_cents),0) AS total FROM recharge_orders
      WHERE seller_id = $1 AND status = 'CREDITED' AND verified_at >= $2`,
    [sellerId, periodFrom.toISOString()],
  );
  return Number(row.rows[0]?.total ?? 0);
}

export type OrderFilter = {
  /** Look one order up inside whatever else the filter allows; used by the partner routes. */
  orderId?: string;
  sellerId?: string;
  bdId?: string;
  /** A BD's whole territory, not just its own orders. */
  bdTerritoryId?: string;
  userId?: string;
  status?: RechargeOrderStatus;
  search?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
};

export async function listRechargeOrders(filter: OrderFilter): Promise<{ orders: RechargeOrderDto[]; total: number }> {
  const params: unknown[] = [];
  const where: string[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filter.orderId) where.push(`o.id = ${bind(filter.orderId)}`);
  if (filter.sellerId) where.push(`o.seller_id = ${bind(filter.sellerId)}`);
  if (filter.userId) where.push(`o.user_id = ${bind(filter.userId)}`);
  if (filter.bdId) where.push(`o.bd_id = ${bind(filter.bdId)}`);
  if (filter.status) where.push(`o.status = ${bind(filter.status)}`);
  if (filter.from) where.push(`o.created_at >= ${bind(filter.from.toISOString())}`);
  if (filter.to) where.push(`o.created_at <= ${bind(filter.to.toISOString())}`);
  if (filter.search) {
    const term = bind(`%${filter.search}%`);
    where.push(`(o.reference ILIKE ${term} OR o.payment_ref ILIKE ${term} OR u.phone ILIKE ${term})`);
  }
  if (filter.bdTerritoryId) {
    where.push(`o.seller_id IN (
      WITH RECURSIVE territory AS (
        SELECT id FROM business_accounts WHERE id = ${bind(filter.bdTerritoryId)}
        UNION ALL
        SELECT s.id FROM business_accounts s JOIN territory t ON s.parent_id = t.id
      ) SELECT id FROM territory)`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(Number(filter.limit) || 50, 200));
  const offset = Math.max(0, Number(filter.offset) || 0);

  const rows = await many<RechargeOrderRow & { seller_code?: string; seller_name?: string; bd_code?: string; username?: string }>(
    `${ORDER_SELECT} ${clause} ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const count = await one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM recharge_orders o JOIN users u ON u.id = o.user_id ${clause}`,
    params,
  );
  return { orders: rows.map(toRechargeOrder), total: Number(count?.n ?? 0) };
}

export async function getRechargeOrder(orderId: string): Promise<RechargeOrderDto> {
  return toRechargeOrder(await enrichedOrder(orderId));
}

/**
 * §22's "restricted customer recharge lookup": a seller may confirm who they are about to
 * top up and see the orders they themselves opened for that customer. Nothing else about the
 * account — not the balance, not the gift history — is theirs.
 */
export async function lookupCustomer(
  seller: BusinessAccountRow,
  phone: string,
): Promise<{ id: string; username: string; status: string; created: string; orders: RechargeOrderDto[] }> {
  const normalized = normalizePhone(phone);
  const user = await one<UserRow>('SELECT * FROM users WHERE phone = $1', [normalized]);
  if (!user) throw ApiError.notFound('No account with that phone number', 'customer_not_found');
  const orders = await many<RechargeOrderRow & { seller_code?: string; seller_name?: string; bd_code?: string; username?: string }>(
    `${ORDER_SELECT} WHERE o.user_id = $1 AND o.seller_id = $2 ORDER BY o.created_at DESC LIMIT 20`,
    [user.id, seller.id],
  );
  return {
    id: user.id,
    username: user.username,
    status: user.status,
    created: new Date(user.created_at).toISOString(),
    orders: orders.map(toRechargeOrder),
  };
}

/** Counts a seller or a BD dashboard is built from; one grouped read instead of five queries. */
export async function rechargeStats(opts: { sellerId?: string; bdTerritoryId?: string }): Promise<{
  orders: number;
  credited: number;
  awaitingVerification: number;
  failed: number;
  reversed: number;
  processedDiamonds: number;
  collectedCents: number;
  netCollectedCents: number;
}> {
  const params: unknown[] = [];
  let clause: string;
  if (opts.bdTerritoryId) {
    params.push(opts.bdTerritoryId);
    clause = `WHERE o.seller_id IN (
      WITH RECURSIVE territory AS (
        SELECT id FROM business_accounts WHERE id = $1
        UNION ALL
        SELECT s.id FROM business_accounts s JOIN territory t ON s.parent_id = t.id) SELECT id FROM territory)`;
  } else {
    params.push(opts.sellerId);
    clause = 'WHERE o.seller_id = $1';
  }

  const row = await one<Record<string, string>>(
    `SELECT
       COUNT(*)::text AS orders,
       COUNT(*) FILTER (WHERE o.status = 'CREDITED')::text AS credited,
       COUNT(*) FILTER (WHERE o.status = 'AWAITING_VERIFICATION')::text AS awaiting_verification,
       COUNT(*) FILTER (WHERE o.status IN ('REJECTED','EXPIRED','CANCELLED'))::text AS failed,
       COUNT(*) FILTER (WHERE o.status = 'REVERSED')::text AS reversed,
       COALESCE(SUM(o.diamonds) FILTER (WHERE o.status = 'CREDITED'),0)::text AS processed_diamonds,
       COALESCE(SUM(o.amount_cents) FILTER (WHERE o.status = 'CREDITED'),0)::text AS collected_cents,
       COALESCE(SUM(o.amount_cents - o.fee_cents) FILTER (WHERE o.status = 'CREDITED'),0)::text AS net_collected_cents
     FROM recharge_orders o ${clause}`,
    params,
  );
  const n = (key: string) => Number(row?.[key] ?? 0);
  return {
    orders: n('orders'),
    credited: n('credited'),
    awaitingVerification: n('awaiting_verification'),
    failed: n('failed'),
    reversed: n('reversed'),
    processedDiamonds: n('processed_diamonds'),
    collectedCents: n('collected_cents'),
    netCollectedCents: n('net_collected_cents'),
  };
}
