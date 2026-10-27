import { Router } from 'express';
import * as business from '../controllers/business.controller';
import { requireBusiness } from '../middleware/auth';

/**
 * The BD / coin-seller panel (§21, §22).
 *
 * Mounted at `/api/business`, which is outside `/api/admin/*` on purpose: a partner credential
 * physically cannot reach an operator route. Inside it, every path names the permission the
 * caller's account kind must hold, and `requireBusiness` re-reads that row on every request so a
 * suspended seller is locked out immediately rather than at token expiry.
 */

const router = Router();

// Public: partner sign-in with the business ID and password the operations team issued.
router.post('/login', business.login);

router.get('/me', requireBusiness(), business.whoami);
router.post('/me/password', requireBusiness(), business.changePassword);

router.get('/packages', requireBusiness('recharge:create'), business.packages);
router.post('/orders', requireBusiness('recharge:create'), business.createOrder);
router.post('/orders/:id/mark-paid', requireBusiness('recharge:create'), business.markPaid);
router.post('/orders/:id/cancel', requireBusiness('recharge:create'), business.cancel);
router.get('/customers/lookup', requireBusiness('customer:lookup'), business.customerLookup);

router.get('/dashboard', requireBusiness('recharge:read', 'statement:read'), business.dashboard);
router.get('/orders', requireBusiness('recharge:read'), business.orders);
router.get('/orders/:id', requireBusiness('recharge:read'), business.showOrder);
router.get('/statement', requireBusiness('statement:read'), business.statement);

// BD-only: the sellers it is responsible for, and one of their books.
router.get('/sellers', requireBusiness('seller:read'), business.sellerRoster);
router.get('/sellers/:id/report', requireBusiness('report:read'), business.sellerReport);

export default router;
