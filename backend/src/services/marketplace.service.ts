import { many, one } from '../config/db';
import { BusinessAccountRow, RechargeOrderStatus, RechargePackageRow } from '../types/db';
import { ApiError } from '../utils/http';
import { toRechargePackage } from '../utils/serialize';
import { saveReceipt } from './receipt.service';
import { createRechargeOrder, listPackagesForSeller, MANUAL_RAILS } from './seller-recharge.service';

/**
 * The member-facing side of the coin-seller market (feature 4).
 *
 * Everything a member sees here is an allowlisted projection. A `BusinessAccountRow` carries a
 * contact number, an owner, approval metadata and limits; none of that belongs on a catalogue a
 * member browses. Likewise a `RechargeOrderDto` carries the seller's evidence blob and the rule
 * snapshot used for commission — both internal, neither returned here. The order DTO below is
 * built from named columns only, so adding a sensitive column to a table cannot leak it by
 * accident through `SELECT *`.
 *
 * Nothing in this file can credit diamonds. Order creation delegates to `createRechargeOrder`,
 * which still stops at `AWAITING_PAYMENT`, and receipt upload delegates to `saveReceipt`, whose
 * documents remain evidence for a human finance decision.
 */

// The full row is needed inside `createRechargeOrder` (limits, parent, contact phone). Only the
// DTOs built from it are ever sent to a member.
const APPROVED_SELLER_SELECT = `
  SELECT *
    FROM business_accounts
   WHERE kind = 'COIN_SELLER'
     AND status = 'ACTIVE'
     AND approved_by IS NOT NULL
     AND approved_at IS NOT NULL`;

const MARKETPLACE_ORDER_SELECT = `
  SELECT o.id, o.reference, o.status, o.seller_id,
         s.code AS seller_code, s.display_name AS seller_name,
         o.package_key, o.diamonds, o.amount_cents, o.fee_cents, o.currency,
         o.payment_method, o.payment_ref,
         o.expires_at, o.verified_at, o.created_at, o.updated_at
    FROM recharge_orders o
    JOIN business_accounts s ON s.id = o.seller_id`;

export type MarketplacePackageDto = {
  key: string;
  label: string;
  diamonds: number;
  amountCents: number;
  currency: string;
  /** Minor units per diamond, so a member can compare tiers without doing the math. */
  unitPriceCents: number;
};

export type MarketplaceSellerDto = {
  id: string;
  code: string;
  displayName: string;
  marketCountry: string | null;
  paymentRails: readonly string[];
  packages: MarketplacePackageDto[];
};

export type MarketplaceOrderDto = {
  id: string;
  reference: string;
  status: RechargeOrderStatus;
  sellerId: string;
  sellerCode: string;
  sellerName: string;
  packageKey: string | null;
  diamonds: number;
  amountCents: number;
  feeCents: number;
  currency: string;
  paymentMethod: string;
  /** Only a seller-entered wallet or bank reference; never the order's evidence blob. */
  paymentReference: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceReceiptDto = {
  receiptId: string;
  duplicate: boolean;
  createdAt: string;
};

type MarketplaceOrderRow = {
  id: string;
  reference: string;
  status: RechargeOrderStatus;
  seller_id: string;
  seller_code: string;
  seller_name: string;
  package_key: string | null;
  diamonds: number;
  amount_cents: string | number;
  fee_cents: string | number;
  currency: string;
  payment_method: string;
  payment_ref: string | null;
  expires_at: Date | null;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export const MARKETPLACE_ORDER_STATUSES: readonly RechargeOrderStatus[] = [
  'AWAITING_PAYMENT',
  'AWAITING_VERIFICATION',
  'CREDITED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'REVERSED',
];

const iso = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);

function toPackageDto(row: RechargePackageRow): MarketplacePackageDto {
  const full = toRechargePackage(row);
  // `feeBps` and `isActive` are operator-facing. A member needs the price, not the rate card behind
  // it, and the catalog query has already removed anything inactive or unpermitted.
  return {
    key: full.key,
    label: full.label,
    diamonds: full.diamonds,
    amountCents: full.amountCents,
    currency: full.currency,
    unitPriceCents: full.unitPriceCents,
  };
}

function toOrderDto(row: MarketplaceOrderRow): MarketplaceOrderDto {
  const paymentRef = row.payment_ref?.trim();
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    sellerId: row.seller_id,
    sellerCode: row.seller_code,
    sellerName: row.seller_name,
    packageKey: row.package_key,
    diamonds: row.diamonds,
    amountCents: Number(row.amount_cents),
    feeCents: Number(row.fee_cents),
    currency: row.currency,
    paymentMethod: row.payment_method,
    paymentReference: paymentRef ? paymentRef : null,
    expiresAt: iso(row.expires_at),
    verifiedAt: iso(row.verified_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

/** Approved, active sellers and the packages each one may actually sell. */
export async function listMarketplaceSellers(): Promise<MarketplaceSellerDto[]> {
  const sellers = await many<BusinessAccountRow>(`${APPROVED_SELLER_SELECT} ORDER BY display_name, code`);
  return Promise.all(
    sellers.map(async (seller) => ({
      id: seller.id,
      code: seller.code,
      displayName: seller.display_name,
      marketCountry: seller.market_country,
      paymentRails: MANUAL_RAILS,
      packages: (await listPackagesForSeller(seller.id)).map(toPackageDto),
    })),
  );
}

export type SellerRef = { sellerId?: string; sellerCode?: string };
export type PackageRef = { packageKey?: string; packageCode?: string };

async function resolveSeller(ref: SellerRef): Promise<BusinessAccountRow> {
  if (Boolean(ref.sellerId) === Boolean(ref.sellerCode)) {
    throw ApiError.badRequest('Name one seller by sellerId or sellerCode', 'seller_required');
  }
  const seller = ref.sellerId
    ? await one<BusinessAccountRow>(`${APPROVED_SELLER_SELECT} AND id = $1`, [ref.sellerId])
    : await one<BusinessAccountRow>(`${APPROVED_SELLER_SELECT} AND UPPER(code) = UPPER($1)`, [ref.sellerCode!.trim()]);
  if (!seller) throw ApiError.notFound('That coin seller is not available', 'seller_not_available');
  return seller;
}

function manualRail(value: string): string {
  const rail = value.trim().toUpperCase();
  if (!MANUAL_RAILS.includes(rail as (typeof MANUAL_RAILS)[number])) {
    throw ApiError.badRequest(
      `Marketplace orders use one of ${MANUAL_RAILS.join(', ')}; ${rail} is not a manual rail`,
      'unknown_payment_method',
    );
  }
  return rail;
}

async function resolvePackage(seller: BusinessAccountRow, ref: PackageRef): Promise<RechargePackageRow> {
  if (Boolean(ref.packageKey) === Boolean(ref.packageCode)) {
    throw ApiError.badRequest('Name one package by packageKey or packageCode', 'package_required');
  }
  const wanted = (ref.packageKey ?? ref.packageCode)!.trim();
  const offered = await listPackagesForSeller(seller.id);
  const found = offered.find((row) => row.key === wanted);
  if (!found) throw ApiError.notFound('That package is not offered by this seller', 'unknown_package');
  return found;
}

/**
 * Create on behalf of the signed-in member only. The body picks a seller and a package; it never
 * picks a buyer, a price, a diamond count or a rail. Those all come from the token, the database
 * rows and the manual-rail allowlist respectively.
 */
export async function createMarketplaceOrder(
  buyerUserId: string,
  input: SellerRef & PackageRef & { paymentMethod: string; note?: string },
): Promise<MarketplaceOrderDto> {
  const seller = await resolveSeller(input);
  const paymentMethod = manualRail(input.paymentMethod);
  const pkg = await resolvePackage(seller, input);

  const created = await createRechargeOrder(seller, {
    userId: buyerUserId,
    packageKey: pkg.key,
    paymentMethod,
    note: input.note,
  });
  return getMarketplaceOrder(buyerUserId, created.id);
}

/** A member's own orders only — an id from another buyer is indistinguishable from no row. */
export async function listMarketplaceOrders(
  buyerUserId: string,
  filter: { status?: RechargeOrderStatus; limit: number; offset: number },
): Promise<{ orders: MarketplaceOrderDto[]; total: number }> {
  const params: unknown[] = [buyerUserId];
  const where = ['o.user_id = $1'];
  if (filter.status) {
    params.push(filter.status);
    where.push(`o.status = $${params.length}`);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const limit = Math.max(1, Math.min(Number(filter.limit) || 50, 200));
  const offset = Math.max(0, Number(filter.offset) || 0);

  const rows = await many<MarketplaceOrderRow>(
    `${MARKETPLACE_ORDER_SELECT} ${clause} ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const count = await one<{ n: string }>(`SELECT COUNT(*)::text n FROM recharge_orders o ${clause}`, params);
  return { orders: rows.map(toOrderDto), total: Number(count?.n ?? 0) };
}

export async function getMarketplaceOrder(buyerUserId: string, orderId: string): Promise<MarketplaceOrderDto> {
  const row = await one<MarketplaceOrderRow>(
    `${MARKETPLACE_ORDER_SELECT} WHERE o.user_id = $1 AND o.id = $2`,
    [buyerUserId, orderId],
  );
  if (!row) throw ApiError.notFound('Recharge order not found');
  return toOrderDto(row);
}

/** The buyer's own proof of payment. `saveReceipt` owns the bytes, state and duplicate rules. */
export async function saveMarketplaceReceipt(
  buyerUserId: string,
  orderId: string,
  fileName: string,
  buffer: Buffer,
): Promise<MarketplaceReceiptDto> {
  const { receipt, duplicate } = await saveReceipt({
    memberUserId: buyerUserId,
    orderId,
    fileName,
    buffer,
  });
  return { receiptId: receipt.id, duplicate, createdAt: receipt.createdAt };
}
