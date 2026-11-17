import { many, one } from '../config/db';
import { BusinessAccountRow, WithdrawalRow } from '../types/db';
import { ApiError } from '../utils/http';

/**
 * The payouts a coin seller is expected to hand over in cash (migration 0041).
 *
 * A member who sells R-coins to a seller is still taking money out of the platform, so the record
 * stays a `withdrawal_requests` row and keeps everything that hangs off it: the fee decided when
 * they asked rather than when the cash moved, the minimum, the `payout_reference` finance has to
 * type before the row can be paid, and the `withdrawal:review` permission that releases it. What
 * changes is only who presses the send button — the platform's bank screen or a partner's own
 * wallet — which is exactly the thing a receipt can prove and a webhook never will.
 *
 * Nothing here moves a coin. This file answers "what is waiting on me" and "is this partner allowed
 * to be named at all"; the money itself stays on the rails that already exist.
 */

/**
 * The reference a seller reads on a payout. Derived from the row id rather than stored, so the
 * queue, the single-payout read and the cash book on the statement cannot drift apart.
 */
export const PAYOUT_REFERENCE_SQL = "'WP-' || upper(left(w.id::text, 8)) AS reference";

export type SellerPayoutDto = {
  id: string;
  reference: string;
  username: string;
  amountRCoins: number;
  feeRCoins: number;
  /** What the seller hands over: the gross the member was escrowed for, less the platform's cut. */
  netRCoins: number;
  status: WithdrawalRow['status'];
  payoutDetails: Record<string, unknown>;
  receiptCount: number;
  createdAt: string;
};

/**
 * A seller a member may name on a payout request.
 *
 * Read from `business_accounts` rather than trusted from the request body, so a suspended or closed
 * partner stops being choosable the moment the operator flips the switch, and so a BD manager cannot
 * be named as a cash payer it has no part in.
 */
export async function resolvePayoutSeller(sellerId: string): Promise<BusinessAccountRow> {
  const row = await one<BusinessAccountRow>(
    `SELECT * FROM business_accounts
      WHERE id = $1 AND kind = 'COIN_SELLER' AND status = 'ACTIVE'`,
    [sellerId],
  );
  if (!row) {
    throw ApiError.badRequest('Choose an active coin seller to pay you', 'payout_seller_unavailable');
  }
  return row;
}

function toDto(row: PayoutRow): SellerPayoutDto {
  return {
    id: row.id,
    reference: row.reference,
    username: row.username,
    amountRCoins: row.amount_r_coins,
    feeRCoins: row.fee_r_coins,
    // What the seller hands over: the gross the member was escrowed for, less the platform's cut.
    netRCoins: row.amount_r_coins - row.fee_r_coins,
    status: row.status,
    // A partner does not need the member's full account number to find them, and putting it in this
    // queue would show one host's bank details to every seller who reads it.
    payoutDetails: { ...(row.payout_details ?? {}), account: tail(row.payout_details?.account) },
    receiptCount: Number(row.receipt_count ?? 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
  };
}

type PayoutRow = WithdrawalRow & { username: string; reference: string; receipt_count: string };

/** Last four characters, or the whole thing when it is too short to redact usefully. */
function tail(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
}

/**
 * One seller's own cash-out book, oldest first.
 *
 * The `seller_id` on the row is the whole scope: it is set by the platform when the member chooses
 * the partner, never taken from a request, so a seller asking for another partner's payouts gets an
 * empty queue rather than an error that would confirm those rows exist.
 */
export async function listPayoutsForSeller(
  sellerId: string,
  opts: { status?: string; limit: number; offset: number },
): Promise<{ payouts: SellerPayoutDto[]; total: number }> {
  const where = ['w.seller_id = $1'];
  const params: unknown[] = [sellerId];
  if (opts.status) {
    params.push(opts.status);
    where.push(`w.status = $${params.length}::withdrawal_status`);
  }
  const filter = `WHERE ${where.join(' AND ')}`;

  const rows = await many<PayoutRow>(
    `SELECT w.*, u.username,
            ${PAYOUT_REFERENCE_SQL},
            (SELECT count(*) FROM payment_receipts r WHERE r.withdrawal_id = w.id)::text AS receipt_count
       FROM withdrawal_requests w
       JOIN users u ON u.id = w.user_id
       ${filter}
      ORDER BY w.created_at
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.limit, opts.offset],
  );
  const count = await one<{ n: string }>(
    `SELECT count(*)::text n FROM withdrawal_requests w ${filter}`,
    params,
  );
  return { payouts: rows.map(toDto), total: Number(count?.n ?? 0) };
}

/** One payout, scoped to the asking seller, with what it owes and what has been proved. */
export async function getPayoutForSeller(sellerId: string, withdrawalId: string): Promise<SellerPayoutDto> {
  const rows = await many<PayoutRow>(
    `SELECT w.*, u.username,
            ${PAYOUT_REFERENCE_SQL},
            (SELECT count(*) FROM payment_receipts r WHERE r.withdrawal_id = w.id)::text AS receipt_count
       FROM withdrawal_requests w
       JOIN users u ON u.id = w.user_id
      WHERE w.id = $1 AND w.seller_id = $2
      LIMIT 1`,
    [withdrawalId, sellerId],
  );
  if (!rows.length) throw ApiError.notFound('Payout not found');
  return toDto(rows[0]);
}

/** The member's own payout history needs the seller's name, which is not on the request row. */
export async function payoutSellerNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await many<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM business_accounts WHERE id = ANY($1)`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row.display_name]));
}
