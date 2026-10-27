import { Router } from 'express';
import * as wallet from '../controllers/wallet.controller';
import { checkout } from '../controllers/payments.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.get('/', wallet.wallet);
router.post('/recharge', wallet.rechargeEndpoint);
// Real money: creates a Stripe PaymentIntent and hands back the client secret.
// The balance only moves later, from the webhook.
router.post('/recharge/checkout', checkout);
router.post('/withdraw', wallet.withdraw);
router.get('/withdrawals', wallet.withdrawals);

export default router;
