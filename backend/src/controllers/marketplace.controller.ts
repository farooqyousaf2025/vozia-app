import { Request, Response } from 'express';
import {
  ApiError,
  asyncHandler,
  optionalEnum,
  optionalString,
  optionalUuid,
  requireInt,
  requireString,
  requireUuid,
} from '../utils/http';
import { decodeUploadPayload } from '../services/media.service';
import {
  MARKETPLACE_ORDER_STATUSES,
  createMarketplaceOrder,
  getMarketplaceOrder,
  listMarketplaceOrders,
  listMarketplaceSellers,
  saveMarketplaceReceipt,
} from '../services/marketplace.service';
import { RechargeOrderStatus } from '../types/db';

/**
 * The member side of the coin-seller market.
 *
 * `requireAuth` has already put the member in `req.user`; every function below derives its scope
 * from that subject. No path or body field can name a buyer, and no response uses the partner DTOs
 * that carry evidence, rule snapshots or seller contact details.
 */

function buyer(req: Request): string {
  if (!req.user) throw ApiError.unauthorized();
  return req.user.sub;
}

function pageAndLimit(req: Request): { page: number; limit: number; offset: number } {
  const page = requireInt(req.query?.page ?? 1, 'page', { min: 1, max: 100_000 });
  const limit = requireInt(req.query?.limit ?? 25, 'limit', { min: 1, max: 200 });
  return { page, limit, offset: (page - 1) * limit };
}

export const sellers = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ sellers: await listMarketplaceSellers() });
});

export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  const sellerId = optionalUuid(req.body?.sellerId, 'sellerId');
  const sellerCode = optionalString(req.body?.sellerCode, 'sellerCode', 24);
  const packageKey = optionalString(req.body?.packageKey, 'packageKey', 48);
  const packageCode = optionalString(req.body?.packageCode, 'packageCode', 48);

  const order = await createMarketplaceOrder(buyer(req), {
    sellerId,
    sellerCode,
    packageKey,
    packageCode,
    paymentMethod: requireString(req.body?.paymentMethod, 'paymentMethod', { max: 24 }),
    note: optionalString(req.body?.note, 'note', 200),
  });
  res.status(201).json({ order });
});

export const orders = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, offset } = pageAndLimit(req);
  const result = await listMarketplaceOrders(buyer(req), {
    status: optionalEnum<RechargeOrderStatus>(req.query?.status, 'status', MARKETPLACE_ORDER_STATUSES),
    limit,
    offset,
  });
  res.json({ ...result, page, limit });
});

export const showOrder = asyncHandler(async (req: Request, res: Response) => {
  res.json({ order: await getMarketplaceOrder(buyer(req), requireUuid(req.params.id, 'id')) });
});

export const uploadReceipt = asyncHandler(async (req: Request, res: Response) => {
  const result = await saveMarketplaceReceipt(
    buyer(req),
    requireUuid(req.params.id, 'id'),
    requireString(req.body?.fileName, 'fileName', { max: 120 }),
    decodeUploadPayload(req.body?.data),
  );
  // 200 for a byte-identical replay: the first document is still the answer.
  res.status(result.duplicate ? 200 : 201).json(result);
});
