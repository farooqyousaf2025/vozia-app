import { Router } from 'express';
import { stripeWebhook } from '../controllers/payments.controller';

const router = Router();

// Unauthenticated by design: Stripe cannot hold a user JWT. The Stripe-Signature
// header is the authentication, and it is verified against the raw request bytes.
router.post('/stripe/webhook', stripeWebhook);

export default router;
