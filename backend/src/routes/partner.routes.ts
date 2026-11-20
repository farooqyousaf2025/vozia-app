import { Router } from 'express';
import * as business from '../controllers/business.controller';
import { requireBusinessOwner } from '../middleware/auth';
import { BusinessAccountKind } from '../types/db';

/**
 * The seller / BD desk from the member's own session — the Android partner surface.
 *
 * `/api/business` signs in with a code and password the operations team issued; the app holds a
 * member token instead. This router is the same desk behind the same controllers, with the
 * credential swapped for ownership: `requireBusinessOwner` resolves the caller's account from
 * `business_accounts.owner_user_id` (migration 0046) on every request, exactly as
 * `requireAgencyOwner` does for an agency. No path carries an account id, so there is nothing to
 * forge, and a suspended or revoked partner is refused immediately rather than at token expiry.
 *
 * The kind lists are the desk's own doors. A seller creates recharges and proves cash handovers;
 * a BD reads its territory and reports on it. Both read their own statement. The permission strings
 * are the same ones `/api/business` uses, so the two surfaces cannot disagree about what a kind may
 * do — and the controllers still derive every scope from the row, never from the request.
 *
 * Deliberately absent: login and password change. The member signs in with their own account, and
 * the partner credential keeps its own lifecycle on `/api/business`.
 */

const router = Router();

const SELLER: BusinessAccountKind[] = ['COIN_SELLER'];
const BD: BusinessAccountKind[] = ['BD_MANAGER', 'BD_AGENT'];
const ALL: BusinessAccountKind[] = ['COIN_SELLER', 'BD_MANAGER', 'BD_AGENT'];

// The desk's probe and identity: which account this member runs, and what it may do. The app gates
// the entry on this answer rather than on `users.user_type`, which is a display marker.
router.get('/me', requireBusinessOwner(ALL), business.whoami);

// Seller only: the account that moves the cash is the one that may create and settle the record of
// it — and `markOrderPaid` still stops at AWAITING_VERIFICATION, never at a balance.
router.get('/packages', requireBusinessOwner(SELLER, 'recharge:create'), business.packages);
router.post('/orders', requireBusinessOwner(SELLER, 'recharge:create'), business.createOrder);
router.post('/orders/:id/mark-paid', requireBusinessOwner(SELLER, 'recharge:create'), business.markPaid);
router.post('/orders/:id/cancel', requireBusinessOwner(SELLER, 'recharge:create'), business.cancel);
router.get('/customers/lookup', requireBusinessOwner(SELLER, 'customer:lookup'), business.customerLookup);

// Both desks read, each within its own scope: a seller its own orders, a BD its whole territory.
router.get('/dashboard', requireBusinessOwner(ALL, 'recharge:read', 'statement:read'), business.dashboard);
router.get('/orders', requireBusinessOwner(ALL, 'recharge:read'), business.orders);
router.get('/orders/:id', requireBusinessOwner(ALL, 'recharge:read'), business.showOrder);
router.get('/statement', requireBusinessOwner(ALL, 'statement:read'), business.statement);

// Receipts and cash payouts belong to the seller holding the cash (migration 0041). Which record an
// upload may attach to is decided in `receipt.service.ts` from the row, never from the body.
router.post('/receipts', requireBusinessOwner(SELLER, 'payout:manage'), business.uploadReceipt);
router.get('/receipts/:id/raw', requireBusinessOwner(SELLER, 'payout:manage'), business.ownReceipt);
router.get('/payouts', requireBusinessOwner(SELLER, 'payout:manage'), business.payouts);
router.get('/payouts/:id', requireBusinessOwner(SELLER, 'payout:manage'), business.payout);

// BD only: the sellers it is responsible for, and one of their books.
router.get('/sellers', requireBusinessOwner(BD, 'seller:read'), business.sellerRoster);
router.get('/sellers/:id/report', requireBusinessOwner(BD, 'report:read'), business.sellerReport);

export default router;