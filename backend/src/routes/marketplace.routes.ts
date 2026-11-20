import { Router } from 'express';
import * as marketplace from '../controllers/marketplace.controller';
import { requireAuth } from '../middleware/auth';

/**
 * The member marketplace: browse approved coin sellers, open manual recharge orders, follow only
 * one's own orders and attach one's own proof of payment.
 *
 * This is deliberately not `/partner`: that desk swaps a member session for a business account
 * the member runs. Here the caller stays a buyer, and `req.user.sub` is the only buyer identity any
 * handler accepts. Seller and finance workflows stay on `/business`, `/partner` and `/admin`.
 */

const router = Router();

router.use(requireAuth);

router.get('/sellers', marketplace.sellers);
router.post('/orders', marketplace.createOrder);
router.get('/orders', marketplace.orders);
router.get('/orders/:id', marketplace.showOrder);
router.post('/orders/:id/receipt', marketplace.uploadReceipt);

export default router;
