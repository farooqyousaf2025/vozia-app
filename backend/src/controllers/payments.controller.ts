import { Request, Response } from 'express';
import { env } from '../config/env';
import { asyncHandler, ApiError, requireInt } from '../utils/http';
import { emitToUser } from '../services/socket.service';
import { settlePayment } from '../services/ledger.service';
import {
  createPaymentIntent,
  parseEvent,
  rechargeWebhookEnabled,
  verifyWebhookSignature,
} from '../services/stripe.service';

/**
 * Paid top-ups. Two endpoints, and the split between them is the whole point:
 * the client asks for money (`/checkout`), Stripe tells us that money arrived
 * (`/webhook`). Nothing credits a balance on the strength of a client request.
 */

export const checkout = asyncHandler(async (req: Request, res: Response) => {
  if (env.payments.provider !== 'stripe') {
    throw ApiError.forbidden(
      'This stack runs in demo payment mode; use POST /api/wallet/recharge',
      'payments_provider_not_stripe',
    );
  }

  const diamonds = requireInt(req.body?.amountDiamonds, 'amountDiamonds', { min: 1, max: 1_000_000 });
  const amountCents = diamonds * env.payments.centsPerDiamond;
  // Stripe refuses an amount below its minimum; say so before the API round trip.
  if (amountCents < 50) {
    throw ApiError.badRequest(
      `Minimum top-up is ${Math.ceil(50 / env.payments.centsPerDiamond)} diamonds`,
      'payment_amount_too_small',
    );
  }

  const intent = await createPaymentIntent(amountCents, {
    voizaUserId: req.user!.sub,
    diamonds: String(diamonds),
    currency: env.payments.stripeCurrency,
  });

  res.status(201).json({
    paymentIntentId: intent.id,
    clientSecret: intent.clientSecret,
    amountCents: intent.amountCents,
    currency: intent.currency,
    amountDiamonds: diamonds,
    publishableKeyHint: 'pk_test_',
  });
});

type WebhookAck = { received: true };

/**
 * Stripe posts here. The signature is checked against the raw bytes, an unknown
 * event type is acknowledged rather than failed (Stripe would otherwise retry
 * forever), and a redelivery is a 200 with no second credit.
 */
export const stripeWebhook = asyncHandler(async (req: Request, res: Response) => {
  if (!rechargeWebhookEnabled()) {
    throw ApiError.forbidden('Payments are disabled on this stack', 'payments_disabled');
  }

  const raw = (req.body instanceof Buffer ? req.body : (req.rawBody ?? Buffer.alloc(0))) as Buffer | string;
  verifyWebhookSignature(raw, req.headers['stripe-signature'] as string | undefined);

  const event = parseEvent(JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')));

  switch (event.type) {
    case 'payment_intent.succeeded': {
      if (!event.intentId || !event.userId || !event.diamonds) {
        // An intent we did not create (or an old one without metadata) is not
        // ours to credit — answer 200 so Stripe stops retrying it.
        console.warn('[payments] succeeded event without a voiza reference, ignoring', event.id);
        res.json({ ...ack(), ignored: 'unreferenced_payment' } as WebhookAck & { ignored: string });
        return;
      }
      const outcome = await settlePayment({
        userId: event.userId,
        diamonds: event.diamonds,
        provider: 'stripe',
        externalId: event.intentId,
        amountCents: event.diamonds * env.payments.centsPerDiamond,
        currency: env.payments.stripeCurrency,
      });
      if (outcome.credited && outcome.user) {
        emitToUser(event.userId, 'wallet:update', { diamondBalance: outcome.user.diamondBalance });
        console.info(`[payments] credited ${event.diamonds} diamonds for ${event.intentId}`);
      } else {
        console.info(`[payments] duplicate delivery for ${event.intentId}, nothing moved`);
      }
      res.json(ack());
      return;
    }

    case 'payment_intent.payment_failed':
      // No balance moved, so there is nothing to reverse; the client sees the
      // failure in PaymentSheet. Logged because support gets asked "why was I
      // charged" and this is the record that says the attempt never settled.
      console.info(`[payments] failed intent ${event.intentId ?? '?'}`);
      res.json(ack());
      return;

    default:
      res.json(ack());
      return;
  }
});

function ack(): WebhookAck {
  return { received: true };
}
