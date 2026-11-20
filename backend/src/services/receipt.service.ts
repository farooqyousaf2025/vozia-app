import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PoolClient } from 'pg';
import { many, one, query } from '../config/db';
import { BusinessAccountRow, PaymentReceiptRow, RechargeOrderRow, WithdrawalRow } from '../types/db';
import { ApiError } from '../utils/http';
import { recordAudit } from './audit.service';
import { Format, formatMeta, sniff } from './media.service';

/**
 * The bank slip a manual settlement is judged on.
 *
 * Money between a member and a coin seller does not pass through this platform's rails: the coins
 * move here and the cash moves outside, out of the seller's own pocket. So the one thing the
 * backend cannot know — did the money actually change hands — arrives as a document and is read by
 * a person. That is the whole job of this file, and the limit of it: a receipt is evidence for the
 * finance decision, never a substitute for one. Nothing here credits a coin, and `markOrderPaid`
 * still stops at `AWAITING_VERIFICATION`.
 *
 * Three rules, inherited from the upload code this borrows its byte checks from.
 *
 * First, a file does not describe itself. The format comes from the magic bytes, the extension and
 * content type from this server's table, the name on disk from a uuid, and the size budget from the
 * format that was found — not from the caller.
 *
 * Second, nothing here is addressable. `media_assets` rows are referenced by a URL that
 * `express.static` serves to anyone, which is right for gift art and wrong for a photograph of a
 * bank account; these bytes live in a directory no static mount points at, and there is no `url`
 * field in the DTO because there is no URL to return. Reading one goes through a route that has
 * already checked a permission.
 *
 * Third, a receipt belongs to exactly one money record and to one named uploader: the seller who
 * moved the cash, or — from the member marketplace (0050) — the buyer who paid it. Uploading proof
 * of somebody else's settlement is refused rather than filed.
 */

export const RECEIPTS_DIR = path.resolve(__dirname, '..', '..', 'receipts');

/** What a bank statement looks like when a person sends it: a printout or three photographs. */
const ACCEPTED: Partial<Record<Format, number>> = {
  png: 5 * 1024 * 1024,
  jpeg: 5 * 1024 * 1024,
  webp: 5 * 1024 * 1024,
  pdf: 8 * 1024 * 1024,
};

/** Enough to prove a transfer, few enough that a seller cannot park a photo album on an order. */
const MAX_RECEIPTS_PER_TARGET = 8;

/** The order states a document may still be added to: claimed but not yet decided. */
const OPEN_ORDER_STATES = ['AWAITING_PAYMENT', 'AWAITING_VERIFICATION'];
const OPEN_PAYOUT_STATES = ['PENDING', 'APPROVED'];

export type PaymentReceiptDto = {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  /** Set on seller uploads (the original 0041 writer). */
  uploadedBy: string | null;
  /** Set on member uploads from the seller marketplace (0050). */
  uploadedByUserId: string | null;
  createdAt: string;
};

function toDto(row: PaymentReceiptRow): PaymentReceiptDto {
  return {
    id: row.id,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    uploadedBy: row.uploaded_by ?? null,
    uploadedByUserId: row.uploaded_by_user_id ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
  };
}

/**
 * Which money record an upload is aimed at, and whether this caller may write to it.
 *
 * The order path re-reads the order by id and compares it to the caller: a seller must own the
 * order's `seller_id`, a member must own its `user_id`. A guessed id belonging to somebody else
 * therefore answers 404 rather than confirming it exists. A payout is the seller's mirror image:
 * the member named the seller on the request, and that row — not anything in the upload — decides
 * whose receipt is expected. Members have no payout door on the marketplace router.
 */
type ReceiptActor =
  | { kind: 'seller'; seller: BusinessAccountRow }
  | { kind: 'member'; memberUserId: string };

async function assertTarget(actor: ReceiptActor, target: { orderId?: string; withdrawalId?: string }) {
  if (target.orderId) {
    const order = await one<RechargeOrderRow>('SELECT * FROM recharge_orders WHERE id = $1', [target.orderId]);
    if (!order) throw ApiError.notFound('Recharge order not found');
    if (actor.kind === 'seller') {
      if (order.seller_id !== actor.seller.id) throw ApiError.notFound('Recharge order not found');
    } else if (order.user_id !== actor.memberUserId) {
      throw ApiError.notFound('Recharge order not found');
    }
    if (!OPEN_ORDER_STATES.includes(order.status)) {
      throw ApiError.conflict(`Order ${order.reference} is already ${order.status.toLowerCase()}`, 'receipt_target_closed');
    }
    return { kind: 'order' as const, id: order.id, reference: order.reference };
  }
  if (target.withdrawalId) {
    if (actor.kind !== 'seller') throw ApiError.notFound('Payout not found');
    const withdrawal = await one<WithdrawalRow>('SELECT * FROM withdrawal_requests WHERE id = $1', [target.withdrawalId]);
    if (!withdrawal) throw ApiError.notFound('Payout not found');
    // The seller on the row is the only one who can attach anything to it, and on every other rail
    // that column is NULL — so an ordinary bank withdrawal is unreachable from a partner credential.
    if (withdrawal.seller_id !== actor.seller.id) throw ApiError.notFound('Payout not assigned to this account');
    if (!OPEN_PAYOUT_STATES.includes(withdrawal.status)) {
      throw ApiError.conflict(`This payout is already ${withdrawal.status.toLowerCase()}`, 'receipt_target_closed');
    }
    return { kind: 'withdrawal' as const, id: withdrawal.id, reference: `payout ${withdrawal.id.slice(0, 8)}` };
  }
  throw ApiError.badRequest('A receipt belongs to a recharge order or to a payout assigned to you', 'receipt_target_required');
}

export async function saveReceipt(input: {
  /** Original 0041 writer: a partner proving a handover it made. */
  seller?: BusinessAccountRow;
  /** 0050 writer: a member proving the payment it made to a seller on its own order. */
  memberUserId?: string;
  orderId?: string;
  withdrawalId?: string;
  fileName: string;
  buffer: Buffer;
}): Promise<{ receipt: PaymentReceiptDto; duplicate: boolean }> {
  if (Boolean(input.seller) === Boolean(input.memberUserId)) {
    throw ApiError.badRequest('A receipt has exactly one uploader — a seller or a member', 'receipt_uploader_required');
  }
  const actor: ReceiptActor = input.seller
    ? { kind: 'seller', seller: input.seller }
    : { kind: 'member', memberUserId: input.memberUserId! };
  const target = await assertTarget(actor, { orderId: input.orderId, withdrawalId: input.withdrawalId });

  const fileName = input.fileName.trim();
  if (!fileName) throw ApiError.badRequest('fileName is required');
  if (fileName.length > 120) throw ApiError.badRequest('fileName must be 120 characters or fewer');
  if (input.buffer.length === 0) throw ApiError.badRequest('The uploaded file is empty');

  const format = sniff(input.buffer);
  const maxBytes = format ? ACCEPTED[format] : undefined;
  if (!format || maxBytes === undefined) {
    throw ApiError.badRequest(
      format
        ? `A ${format.toUpperCase()} file is not a payment receipt; a receipt is a photograph or a PDF of the transfer`
        : 'Unrecognised file format — the bytes do not match a PNG, JPEG, WebP image or a PDF',
      'receipt_format_unsupported',
    );
  }
  if (input.buffer.length > maxBytes) {
    throw ApiError.badRequest(
      `That ${format.toUpperCase()} file is ${(input.buffer.length / 1024 / 1024).toFixed(1)} MB; a receipt is up to ${(maxBytes / 1024 / 1024).toFixed(0)} MB`,
      'receipt_too_large',
    );
  }

  const sha256 = crypto.createHash('sha256').update(input.buffer).digest('hex');
  const column = target.kind === 'order' ? 'order_id' : 'withdrawal_id';
  const held = await one<{ n: string }>(`SELECT count(*)::text n FROM payment_receipts WHERE ${column} = $1`, [target.id]);
  if (Number(held?.n ?? 0) >= MAX_RECEIPTS_PER_TARGET) {
    throw ApiError.conflict(`This ${target.kind} already has ${MAX_RECEIPTS_PER_TARGET} receipts`, 'receipt_limit');
  }

  const { contentType, ext } = formatMeta(format);
  const storedName = `${randomUUID()}.${ext}`;

  await fs.mkdir(RECEIPTS_DIR, { recursive: true });
  // 0600, not the 0644 the media library uses: nothing but this process ever reads these bytes.
  await fs.writeFile(path.join(RECEIPTS_DIR, storedName), input.buffer, { mode: 0o600 });

  const sellerId = input.seller?.id ?? null;
  const memberId = input.memberUserId ?? null;
  const params = [target.kind === 'order' ? target.id : null, target.kind === 'withdrawal' ? target.id : null];
  try {
    const row = await one<PaymentReceiptRow>(
      `INSERT INTO payment_receipts (order_id, withdrawal_id, uploaded_by, uploaded_by_user_id,
                                     file_name, stored_name, content_type, byte_size, sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [...params, sellerId, memberId, fileName, storedName, contentType, input.buffer.length, sha256],
    );
    if (!row) {
      // The same document on the same record twice: the partial unique index says so, and the
      // first one is still the answer.
      await fs.unlink(path.join(RECEIPTS_DIR, storedName)).catch(() => undefined);
      const existing = await one<PaymentReceiptRow>(
        `SELECT * FROM payment_receipts WHERE ${column} = $1 AND sha256 = $2`,
        [target.id, sha256],
      );
      if (!existing) throw new Error('Receipt insert conflicted with no existing row');
      return { receipt: toDto(existing), duplicate: true };
    }
    await recordAudit({
      adminId: null,
      businessId: sellerId,
      actorSystem: memberId ? 'member' : null,
      action: 'RECEIPT_UPLOADED',
      targetType: target.kind === 'order' ? 'recharge_order' : 'withdrawal',
      targetId: target.id,
      summary: input.seller
        ? `${input.seller.code} uploaded ${fileName} for ${target.reference}`
        : `Member ${memberId} uploaded ${fileName} for ${target.reference}`,
      details: { receiptId: row.id, contentType, byteSize: row.byte_size, memberUserId: memberId },
    });
    return { receipt: toDto(row), duplicate: false };
  } catch (err) {
    await fs.unlink(path.join(RECEIPTS_DIR, storedName)).catch(() => undefined);
    throw err;
  }
}

/**
 * A file name a client typed, made safe to put in a `Content-Disposition` header.
 *
 * The name is stored for the queue's benefit, not used for anything else, and a quote or a newline
 * in it would otherwise let an uploader write a second header on a response the server is about to
 * send them.
 */
export function safeDownloadName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120).trim() || 'receipt';
}

export async function listReceiptsForOrder(orderId: string): Promise<PaymentReceiptDto[]> {
  const rows = await many<PaymentReceiptRow>(
    'SELECT * FROM payment_receipts WHERE order_id = $1 ORDER BY created_at',
    [orderId],
  );
  return rows.map(toDto);
}

export async function listReceiptsForWithdrawal(withdrawalId: string): Promise<PaymentReceiptDto[]> {
  const rows = await many<PaymentReceiptRow>(
    'SELECT * FROM payment_receipts WHERE withdrawal_id = $1 ORDER BY created_at',
    [withdrawalId],
  );
  return rows.map(toDto);
}

/** Orders the finance queue may show a slip for, and payouts it may not — the two permissions are separate. */
export async function readReceiptForAdmin(
  receiptId: string,
  scope: 'order' | 'withdrawal',
): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  const row = await one<PaymentReceiptRow>('SELECT * FROM payment_receipts WHERE id = $1', [receiptId]);
  if (!row) throw ApiError.notFound('Receipt not found');
  const holds = scope === 'order' ? row.order_id : row.withdrawal_id;
  if (!holds) {
    // Not a lack of permission — this document belongs to the other queue, which reads under the
    // other capability, and crossing them would let a recharge reviewer open a payout slip.
    throw ApiError.badRequest(`This receipt is attached to a ${row.order_id ? 'recharge order' : 'payout'}, not to a ${scope}`, 'receipt_wrong_queue');
  }
  return {
    bytes: await fs.readFile(path.join(RECEIPTS_DIR, row.stored_name)),
    contentType: row.content_type,
    fileName: row.file_name,
  };
}

/** The uploader reads back what they sent, which is the only way they can check it before finance does. */
export async function readReceiptForSeller(
  receiptId: string,
  seller: BusinessAccountRow,
): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
  const row = await one<PaymentReceiptRow>('SELECT * FROM payment_receipts WHERE id = $1', [receiptId]);
  if (!row || row.uploaded_by !== seller.id) throw ApiError.notFound('Receipt not found');
  return {
    bytes: await fs.readFile(path.join(RECEIPTS_DIR, row.stored_name)),
    contentType: row.content_type,
    fileName: row.file_name,
  };
}

/**
 * How many documents an order already carries, on the caller's transaction.
 *
 * `markOrderPaid` asks this to decide whether the seller has attached anything: a receipt counts as
 * evidence, and the point of the check is that the manual gate can be satisfied by a document rather
 * than by a sentence typed into a box.
 */
export async function countReceiptsForOrder(orderId: string, client?: PoolClient): Promise<number> {
  const result = client
    ? await client.query<{ n: string }>('SELECT count(*)::text n FROM payment_receipts WHERE order_id = $1', [orderId])
    : await query<{ n: string }>('SELECT count(*)::text n FROM payment_receipts WHERE order_id = $1', [orderId]);
  return Number(result.rows[0]?.n ?? 0);
}
