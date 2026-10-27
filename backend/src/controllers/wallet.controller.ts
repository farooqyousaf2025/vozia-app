import { Request, Response } from 'express';
import { many } from '../config/db';
import { WithdrawalRow } from '../types/db';
import { ApiError, asyncHandler, optionalString, requireEnum, requireInt } from '../utils/http';
import { toWithdrawal } from '../utils/serialize';
import { getWallet, recharge, requestWithdrawal } from '../services/ledger.service';
import { simulatedRechargeAllowed } from '../services/stripe.service';

export const wallet = asyncHandler(async (req: Request, res: Response) => {
  res.json(await getWallet(req.user!.sub));
});

/**
 * Demo top-up: credits diamonds with no money behind it. Allowed only while
 * PAYMENTS_PROVIDER=simulated — once Stripe is wired this returns 403, because a
 * endpoint that prints the paid currency is not a demo feature, it is a leak.
 */
export const rechargeEndpoint = asyncHandler(async (req: Request, res: Response) => {
  if (!simulatedRechargeAllowed()) {
    throw ApiError.forbidden(
      'This stack charges for diamonds; use POST /api/wallet/recharge/checkout',
      'payments_provider_is_stripe',
    );
  }
  const amount = requireInt(req.body?.amountDiamonds, 'amountDiamonds', { min: 1, max: 1_000_000 });
  res.json(await recharge(req.user!.sub, amount));
});

export const withdraw = asyncHandler(async (req: Request, res: Response) => {
  const amount = requireInt(req.body?.amountRCoins, 'amountRCoins', { min: 1 });
  const method = req.body?.payoutMethod
    ? requireEnum(req.body.payoutMethod, 'payoutMethod', ['BANK', 'WALLET', 'USDT'] as const)
    : 'BANK';

  const details = (req.body?.payoutDetails ?? {}) as Record<string, unknown>;
  const account = optionalString(details.account, 'payoutDetails.account', 120);
  const holder = optionalString(details.holder, 'payoutDetails.holder', 80);
  if (!account) throw ApiError.badRequest('Withdrawals need a payout account', 'payout_details_required');

  const { withdrawal, user } = await requestWithdrawal(req.user!.sub, amount, method, {
    account,
    holder,
    currency: optionalString(details.currency, 'payoutDetails.currency', 3) ?? 'USD',
  });
  res.status(201).json({ withdrawal: toWithdrawal(withdrawal), user });
});

export const withdrawals = asyncHandler(async (req: Request, res: Response) => {
  const rows = await many<WithdrawalRow>(
    `SELECT w.*, u.username, u.avatar_url FROM withdrawal_requests w
     JOIN users u ON u.id = w.user_id WHERE w.user_id = $1 ORDER BY w.created_at DESC LIMIT 50`,
    [req.user!.sub],
  );
  res.json({ withdrawals: rows.map(toWithdrawal) });
});
