import { Request, Response } from 'express';
import {
  equipItem,
  purchaseItem,
  readItemKey,
  readKind,
  storeFor,
  unequipItem,
} from '../services/store.service';
import { asyncHandler } from '../utils/http';

/**
 * The cosmetic store a member sees (migration 0019).
 *
 * Every route here is per-member and authenticated: the catalogue is the same rows for everybody,
 * but each row carries "do you hold this" and "are you wearing this", and neither belongs to an
 * anonymous caller.
 *
 * What a body may contain is a kind and a key — never a price. `store.service` reads the price
 * inside the purchase transaction, so a client that edits its copy of the shop screen changes what
 * it *sees* and nothing about what it pays.
 */

export const catalogue = asyncHandler(async (req: Request, res: Response) => {
  res.json(await storeFor(req.user!.sub));
});

export const buy = asyncHandler(async (req: Request, res: Response) => {
  const result = await purchaseItem({ userId: req.user!.sub, kind: readKind(req.body?.kind), key: readItemKey(req.body?.key) });
  // 201 because diamonds moved: this is a purchase record, not a read.
  res.status(201).json(result);
});

/** Put an owned item on the account. A theme is not equipped here — a room wears a theme. */
export const equip = asyncHandler(async (req: Request, res: Response) => {
  const user = await equipItem({ userId: req.user!.sub, kind: readKind(req.body?.kind), key: readItemKey(req.body?.key) });
  res.json({ user });
});

/** Take it off. Works even for something no longer owned, so a lapsed rental cannot stick. */
export const unequip = asyncHandler(async (req: Request, res: Response) => {
  const user = await unequipItem({ userId: req.user!.sub, kind: readKind(req.body?.kind) });
  res.json({ user });
});
