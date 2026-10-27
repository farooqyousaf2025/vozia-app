import { PoolClient } from 'pg';
import { env } from '../config/env';
import { many, one, withTransaction } from '../config/db';
import { rateLimit, redis } from '../config/redis';
import { GiftRow, TransactionRow, UserRow, WithdrawalRow } from '../types/db';
import { ApiError } from '../utils/http';
import { GiftDto, toGift, toTransaction, toUser, TransactionDto, UserDto } from '../utils/serialize';

const TX_WITH_PARTIES = `
  SELECT t.*, g.name AS gift_name, g.icon_url AS gift_icon_url,
         su.username AS sender_username,   su.avatar_url AS sender_avatar_url,
         ru.username AS receiver_username, ru.avatar_url AS receiver_avatar_url
    FROM transactions t
    LEFT JOIN gifts g ON g.id = t.gift_id
    LEFT JOIN users su ON su.id = t.sender_id
    LEFT JOIN users ru ON ru.id = t.receiver_id`;

/**
 * The wallet ledger. Every mutation of a balance lives here so there is exactly
 * one place that can move diamonds or R-coins, and each write is one SQL
 * transaction with row locks on both parties.
 */

export async function sendGift(input: {
  senderId: string;
  receiverId: string;
  giftId: string;
  quantity: number;
  roomId?: string;
}): Promise<{ transaction: TransactionDto; sender: UserDto; receiver: UserDto; gift: GiftDto }> {
  if (input.senderId === input.receiverId) {
    throw ApiError.badRequest('You cannot send a gift to yourself', 'self_gift');
  }
  if (input.quantity < 1 || input.quantity > 999) {
    throw ApiError.badRequest('Quantity must be between 1 and 999');
  }

  const remaining = await rateLimit(`gift:${input.senderId}`, env.economy.giftRatePerMinute, 60);
  if (remaining === -1) throw ApiError.tooManyRequests('Too many gifts in one minute');

  const result = await withTransaction(async (client) => {
    // Lock both accounts, sender first, in a stable order so two simultaneous
    // gifts between the same pair cannot deadlock each other.
    const [first, second] = [input.senderId, input.receiverId].sort();
    const locked = await client.query<UserRow>(
      'SELECT * FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[first, second]],
    );
    if (locked.rows.length !== 2) throw ApiError.notFound('Account not found');

    const sender = locked.rows.find((u) => u.id === input.senderId)!;
    const receiver = locked.rows.find((u) => u.id === input.receiverId)!;
    if (sender.status === 'BANNED') throw ApiError.forbidden('Account is banned', 'account_banned');
    if (receiver.status === 'BANNED') throw ApiError.forbidden('Receiver is banned', 'receiver_banned');

    const giftRes = await client.query<GiftRow>('SELECT * FROM gifts WHERE id = $1 AND is_active', [input.giftId]);
    const gift = giftRes.rows[0];
    if (!gift) throw ApiError.notFound('Gift is not available', 'gift_not_found');

    const totalDiamonds = gift.diamond_price * input.quantity;
    const totalRCoins = gift.r_coin_value * input.quantity;
    // Spend tier is checked before the balance so a low-VIP whale is told why the
    // gift is locked rather than being pushed into a top-up they cannot spend.
    if (gift.min_vip_level > 0 && sender.vip_level < gift.min_vip_level) {
      throw ApiError.forbidden(`${gift.name} requires VIP level ${gift.min_vip_level}`, 'vip_required', {
        required: gift.min_vip_level,
        current: sender.vip_level,
        giftName: gift.name,
      });
    }
    if (sender.diamond_balance < totalDiamonds) {
      throw ApiError.paymentInsufficient('Not enough diamonds', {
        needed: totalDiamonds,
        available: sender.diamond_balance,
      });
    }

    await client.query(
      `UPDATE users SET diamond_balance = diamond_balance - $2,
                        total_gifts_sent = total_gifts_sent + $3
        WHERE id = $1`,
      [sender.id, totalDiamonds, input.quantity],
    );
    await client.query(
      `UPDATE users SET r_coin_balance = r_coin_balance + $2,
                        total_gifts_received = total_gifts_received + $3
        WHERE id = $1`,
      [receiver.id, totalRCoins, input.quantity],
    );

    const txRes = await client.query<TransactionRow>(
      `INSERT INTO transactions (type, status, sender_id, receiver_id, gift_id, quantity,
                                amount_diamonds, amount_r_coins, room_id, meta,
                                sender_diamonds_after, receiver_r_coins_after)
       VALUES ('GIFT_SENT','COMPLETED',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        sender.id,
        receiver.id,
        gift.id,
        input.quantity,
        totalDiamonds,
        totalRCoins,
        input.roomId ?? null,
        JSON.stringify({ giftName: gift.name, iconUrl: gift.icon_url }),
        sender.diamond_balance - totalDiamonds,
        receiver.r_coin_balance + totalRCoins,
      ],
    );

    // Agency commission: tracked as its own ledger row so back-office reporting
    // can attribute a host's earnings without touching the host's balance.
    let commission: TransactionRow | null = null;
    const membership = await client.query<{ agency_id: string; commission_bps: number }>(
      `SELECT ah.agency_id, ah.commission_bps FROM agency_hosts ah
        WHERE ah.host_user_id = $1 AND ah.status = 'ACTIVE' LIMIT 1`,
      [receiver.id],
    );
    if (membership.rows[0] && totalRCoins > 0) {
      const { agency_id, commission_bps } = membership.rows[0];
      const commissionAmount = Math.floor((totalRCoins * commission_bps) / 10_000);
      if (commissionAmount > 0) {
        const rows = await client.query<TransactionRow>(
          `INSERT INTO transactions (type, status, receiver_id, amount_r_coins, room_id, agency_id, meta)
           VALUES ('AGENCY_COMMISSION','COMPLETED',$1,$2,$3,$4,$5) RETURNING *`,
          [
            receiver.id,
            commissionAmount,
            input.roomId ?? null,
            agency_id,
            JSON.stringify({ sourceGiftId: gift.id, commissionBps: commission_bps }),
          ],
        );
        commission = rows.rows[0];
      }
    }

    if (input.roomId) {
      await client.query('UPDATE rooms SET total_gift_value = total_gift_value + $2 WHERE id = $1', [
        input.roomId,
        totalRCoins,
      ]);
    }

    const freshSender = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [sender.id]);
    const freshReceiver = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [receiver.id]);

    return {
      transaction: txRes.rows[0],
      commission,
      sender: freshSender.rows[0],
      receiver: freshReceiver.rows[0],
      gift,
      totalDiamonds,
      totalRCoins,
    };
  });

  const enriched = await one<TransactionRow>(`${TX_WITH_PARTIES} WHERE t.id = $1`, [result.transaction.id]);
  return {
    transaction: toTransaction(enriched ?? result.transaction),
    sender: toUser(result.sender),
    receiver: toUser(result.receiver),
    gift: toGift(result.gift),
  };
}

/** Simulated top-up: no PSP is wired, so this credits diamonds directly. */
export async function recharge(userId: string, amountDiamonds: number): Promise<{ transaction: TransactionDto; user: UserDto }> {
  if (amountDiamonds < 1) throw ApiError.badRequest('Amount must be positive');
  if (amountDiamonds > 1_000_000) throw ApiError.badRequest('Amount too large; contact support for bulk top-ups');

  const tx = await withTransaction(async (client) => {
    const rows = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = rows.rows[0];
    if (!user) throw ApiError.notFound('Account not found');
    await client.query('UPDATE users SET diamond_balance = diamond_balance + $2 WHERE id = $1', [userId, amountDiamonds]);
    const inserted = await client.query<TransactionRow>(
      `INSERT INTO transactions (type, status, receiver_id, amount_diamonds, receiver_r_coins_after, meta)
       VALUES ('RECHARGE','COMPLETED',$1,$2,$3,$4) RETURNING *`,
      [userId, amountDiamonds, user.r_coin_balance, JSON.stringify({ source: 'simulated' })],
    );
    const fresh = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    return { row: inserted.rows[0], user: fresh.rows[0] };
  });

  const enriched = await one<TransactionRow>(`${TX_WITH_PARTIES} WHERE t.id = $1`, [tx.row.id]);
  return { transaction: toTransaction(enriched ?? tx.row), user: toUser(tx.user) };
}

/**
 * Credits diamonds for a payment the PSP confirmed, idempotently.
 *
 * Stripe (like every other webhook delivery) retries, and a retry that minted a
 * second RECHARGE row would be a money bug, so the external id is inserted into
 * `payment_proofs` inside the same SQL transaction as the credit:
 *  - first delivery -> proof inserts, balance moves
 *  - any redelivery -> UNIQUE conflict, nothing moves, still a success
 * The credit itself runs under `SELECT ... FOR UPDATE` on the user, so it joins
 * the ledger exactly like a gift or a withdrawal does.
 *
 * `settlePaymentOnClient` is the same operation on a transaction the caller already
 * owns — a seller-initiated recharge credits the user, accrues two commissions and
 * books the journal, and all of it has to succeed or none of it may.
 */
export async function settlePayment(input: {
  userId: string;
  diamonds: number;
  provider: string;
  externalId: string;
  amountCents: number;
  currency: string;
}): Promise<{ credited: boolean; transaction?: TransactionDto; user?: UserDto }> {
  const result = await withTransaction(async (client) =>
    settlePaymentOnClient(client, input),
  );
  if (!result) return { credited: false };
  return result;
}

export async function settlePaymentOnClient(
  client: PoolClient,
  input: {
    userId: string;
    diamonds: number;
    provider: string;
    externalId: string;
    amountCents: number;
    currency: string;
    /** Anything that explains the collection: order reference, seller, BD. */
    meta?: Record<string, unknown>;
  },
): Promise<{ credited: boolean; transaction?: TransactionDto; user?: UserDto } | null> {
  if (input.diamonds < 1) throw ApiError.badRequest('Payment credited no diamonds');
  if (input.diamonds > 1_000_000) throw ApiError.badRequest('Amount too large; contact support for bulk top-ups');
  if (!input.externalId) throw ApiError.badRequest('Payment has no reference id');

  const proof = await client.query<{ id: string }>(
    `INSERT INTO payment_proofs (provider, external_id, user_id, diamonds, amount_cents, currency)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (provider, external_id) DO NOTHING
     RETURNING id`,
    [input.provider, input.externalId, input.userId, input.diamonds, input.amountCents, input.currency],
  );
  if (!proof.rows.length) return null; // already settled — a retry, not a payment

  const rows = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
  const user = rows.rows[0];
  if (!user) throw ApiError.notFound('Account not found');

  await client.query('UPDATE users SET diamond_balance = diamond_balance + $2 WHERE id = $1', [
    input.userId,
    input.diamonds,
  ]);
  const inserted = await client.query<TransactionRow>(
    `INSERT INTO transactions (type, status, receiver_id, amount_diamonds, receiver_r_coins_after, meta)
     VALUES ('RECHARGE','COMPLETED',$1,$2,$3,$4) RETURNING *`,
    [
      input.userId,
      input.diamonds,
      user.r_coin_balance,
      JSON.stringify({
        source: input.provider,
        paymentId: input.externalId,
        amountCents: input.amountCents,
        currency: input.currency,
        ...(input.meta ?? {}),
      }),
    ],
  );
  await client.query('UPDATE payment_proofs SET transaction_id = $2 WHERE id = $1', [
    proof.rows[0].id,
    inserted.rows[0].id,
  ]);
  const fresh = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [input.userId]);
  const enriched = await client.query<TransactionRow>(`${TX_WITH_PARTIES} WHERE t.id = $1`, [inserted.rows[0].id]);
  return {
    credited: true,
    transaction: toTransaction(enriched.rows[0] ?? inserted.rows[0]),
    user: toUser(fresh.rows[0]),
  };
}

/** Admin balance correction. Deltas may be negative; balances cannot go below zero. */
export async function adjustBalance(
  userId: string,
  deltas: { diamondDelta: number; rCoinDelta: number; note?: string },
  adminId: string,
): Promise<{ transaction: TransactionDto; user: UserDto }> {
  const { diamondDelta, rCoinDelta, note } = deltas;
  if (diamondDelta === 0 && rCoinDelta === 0) throw ApiError.badRequest('Nothing to adjust');

  const tx = await withTransaction(async (client) => {
    const rows = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = rows.rows[0];
    if (!user) throw ApiError.notFound('Account not found');
    if (user.diamond_balance + diamondDelta < 0 || user.r_coin_balance + rCoinDelta < 0) {
      throw ApiError.badRequest('Adjustment would drive a balance negative', 'negative_balance');
    }

    await client.query(
      'UPDATE users SET diamond_balance = diamond_balance + $2, r_coin_balance = r_coin_balance + $3 WHERE id = $1',
      [userId, diamondDelta, rCoinDelta],
    );
    const inserted = await client.query<TransactionRow>(
      `INSERT INTO transactions (type, status, receiver_id, amount_diamonds, amount_r_coins, note, meta,
                                sender_diamonds_after, receiver_r_coins_after)
       VALUES ('ADMIN_ADJUSTMENT','COMPLETED',$1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        userId,
        Math.abs(diamondDelta),
        Math.abs(rCoinDelta),
        note ?? null,
        JSON.stringify({ adminId, diamondDelta, rCoinDelta }),
        user.diamond_balance + diamondDelta,
        user.r_coin_balance + rCoinDelta,
      ],
    );
    const fresh = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    return { row: inserted.rows[0], user: fresh.rows[0] };
  });

  const enriched = await one<TransactionRow>(`${TX_WITH_PARTIES} WHERE t.id = $1`, [tx.row.id]);
  return { transaction: toTransaction(enriched ?? tx.row), user: toUser(tx.user) };
}

export type GameMoveType = 'GAME_ENTRY' | 'GAME_PRIZE' | 'GAME_REFUND' | 'PLATFORM_COMMISSION';

export type GameMove = {
  type: GameMoveType;
  /**
   * The account whose diamond balance moves. Omitted only for PLATFORM_COMMISSION,
   * which records revenue the platform retained and therefore belongs to nobody's wallet.
   */
  userId?: string;
  diamonds: number;
  sessionId: string;
  roomId?: string | null;
  note?: string | null;
};

export type PostedGameMove = {
  type: GameMoveType;
  userId: string | null;
  diamonds: number;
  transactionId: string;
  /** Diamond balance after this move, for the caller's post-image bookkeeping. */
  diamondsAfter: number | null;
};

const GAME_MOVE_DIRECTION: Record<GameMoveType, 'debit' | 'credit' | 'record'> = {
  GAME_ENTRY: 'debit',
  GAME_REFUND: 'credit',
  GAME_PRIZE: 'credit',
  PLATFORM_COMMISSION: 'record',
};

export type LedgerMove = {
  /** Any `transaction_type` label; the database refuses one it does not know. */
  type: string;
  /** debit takes diamonds, credit gives them, record writes a row and touches no wallet. */
  direction: 'debit' | 'credit' | 'record';
  userId?: string | null;
  diamonds: number;
  sessionId?: string | null;
  roomId?: string | null;
  note?: string | null;
  meta?: Record<string, unknown>;
  /** What the caller wants a short balance to be called; games say "this bet", refunds say "this clawback". */
  insufficientMessage?: string;
};

export type PostedLedgerMove = {
  type: string;
  userId: string | null;
  diamonds: number;
  transactionId: string;
  diamondsAfter: number | null;
};

/**
 * The only primitive that moves a diamond balance inside a caller-owned transaction.
 *
 * Games and seller recharges both need several balances to change as one unit, and a second
 * hand-rolled UPDATE would be a second set of rules about locking and negative balances. So
 * they share this: locks every account involved in ascending id order (the deadlock rule
 * `sendGift` follows), nets each account's moves into one delta, refuses a debit that would go
 * negative before writing any row, then posts one `transactions` row per non-zero move with
 * its post-image.
 */
export async function postLedgerMoves(client: PoolClient, moves: readonly LedgerMove[]): Promise<PostedLedgerMove[]> {
  if (moves.length === 0) return [];

  const normalized = moves.map((move) => {
    if (!Number.isInteger(move.diamonds) || move.diamonds < 0) {
      throw ApiError.badRequest('A ledger move needs a whole non-negative diamond amount', 'bad_ledger_move');
    }
    if (move.direction !== 'record' && !move.userId) {
      throw ApiError.badRequest(`A ${move.type} move needs an account`, 'bad_ledger_move');
    }
    if (move.diamonds === 0 && move.direction !== 'record') {
      throw ApiError.badRequest('A balance move must be more than zero diamonds', 'bad_ledger_move');
    }
    return move;
  });

  const accountIds = [...new Set(normalized.filter((m) => m.userId).map((m) => m.userId as string))].sort();
  const balances = new Map<string, number>();
  if (accountIds.length) {
    const locked = await client.query<UserRow>(
      'SELECT id, diamond_balance, status FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [accountIds],
    );
    if (locked.rows.length !== accountIds.length) throw ApiError.notFound('Account not found');
    for (const row of locked.rows) {
      if (row.status === 'BANNED') throw ApiError.forbidden('Account is banned', 'account_banned');
      balances.set(row.id, row.diamond_balance);
    }
  }

  // Net effect per account first, so two moves for the same player (a refund and a
  // prize, say) is one UPDATE rather than a race between two.
  const deltas = new Map<string, number>();
  for (const move of normalized) {
    if (!move.userId) continue;
    const delta = move.direction === 'debit' ? -move.diamonds : move.direction === 'credit' ? move.diamonds : 0;
    deltas.set(move.userId, (deltas.get(move.userId) ?? 0) + delta);
  }
  for (const [userId, delta] of deltas) {
    const balance = balances.get(userId) ?? 0;
    if (balance + delta < 0) {
      throw ApiError.paymentInsufficient(
        normalized.find((m) => m.userId === userId)?.insufficientMessage ?? 'Not enough diamonds',
        { needed: -delta, available: balance },
      );
    }
  }

  const running = new Map(balances);
  const posted: PostedLedgerMove[] = [];
  for (const move of normalized) {
    if (move.diamonds === 0) continue; // a zero commission is nothing to post
    let diamondsAfter: number | null = null;
    if (move.userId) {
      const next = (running.get(move.userId) ?? 0) + (move.direction === 'debit' ? -move.diamonds : move.diamonds);
      running.set(move.userId, next);
      diamondsAfter = next;
    }

    const senderId = move.direction === 'debit' ? move.userId ?? null : null;
    const receiverId = move.direction === 'credit' ? move.userId ?? null : null;
    const rows = await client.query<TransactionRow>(
      `INSERT INTO transactions (type, status, sender_id, receiver_id, quantity, amount_diamonds,
                                room_id, game_session_id, note, sender_diamonds_after, meta)
       VALUES ($1::transaction_type,'COMPLETED',$2,$3,1,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        move.type,
        senderId,
        receiverId,
        move.diamonds,
        move.roomId ?? null,
        move.sessionId ?? null,
        move.note ?? null,
        diamondsAfter,
        JSON.stringify({ direction: move.direction, diamondsAfter, ...(move.meta ?? {}) }),
      ],
    );
    posted.push({
      type: move.type,
      userId: move.userId ?? null,
      diamonds: move.diamonds,
      transactionId: rows.rows[0].id,
      diamondsAfter,
    });
  }

  for (const [userId, delta] of deltas) {
    if (delta === 0) continue;
    await client.query('UPDATE users SET diamond_balance = diamond_balance + $2 WHERE id = $1', [userId, delta]);
  }
  return posted;
}

/**
 * Game money, moved inside the caller's SQL transaction.
 *
 * This is the typed face of `postLedgerMoves` for the game engine: it is still the only way a
 * game touches a wallet, so "one place can move diamonds" stays true for games as it already is
 * for gifts.
 */
export async function postGameMoves(client: PoolClient, moves: readonly GameMove[]): Promise<PostedGameMove[]> {
  const posted = await postLedgerMoves(
    client,
    moves.map((move) => ({
      type: move.type,
      direction: GAME_MOVE_DIRECTION[move.type],
      userId: move.userId ?? null,
      diamonds: move.diamonds,
      sessionId: move.sessionId,
      roomId: move.roomId ?? null,
      note: move.note ?? null,
      meta: { gameId: move.sessionId },
      insufficientMessage: 'Not enough diamonds for this game',
    })),
  );
  return posted as PostedGameMove[];
}

export async function requestWithdrawal(
  userId: string,
  amountRCoins: number,
  payoutMethod: string,
  payoutDetails: Record<string, unknown>,
): Promise<{ withdrawal: WithdrawalRow; user: UserDto }> {
  if (amountRCoins < env.economy.minWithdrawRCoins) {
    throw ApiError.badRequest(`Minimum withdrawal is ${env.economy.minWithdrawRCoins} R-coins`, 'below_minimum');
  }

  const withdrawal = await withTransaction(async (client) => {
    const rows = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = rows.rows[0];
    if (!user) throw ApiError.notFound('Account not found');
    if (user.r_coin_balance < amountRCoins) {
      throw ApiError.badRequest('Not enough R-coins to withdraw', 'insufficient_earnings');
    }
    await client.query('UPDATE users SET r_coin_balance = r_coin_balance - $2 WHERE id = $1', [userId, amountRCoins]);

    const inserted = await client.query<WithdrawalRow>(
      `INSERT INTO withdrawal_requests (user_id, amount_r_coins, payout_method, payout_details)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [userId, amountRCoins, payoutMethod, JSON.stringify(payoutDetails)],
    );
    await client.query<TransactionRow>(
      `INSERT INTO transactions (type, status, sender_id, amount_r_coins, meta)
       VALUES ('WITHDRAWAL','PENDING',$1,$2,$3)`,
      [userId, amountRCoins, JSON.stringify({ withdrawalId: inserted.rows[0].id })],
    );
    return inserted.rows[0];
  });

  const user = await one<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  return { withdrawal, user: toUser(user!) };
}

export async function reviewWithdrawal(
  withdrawalId: string,
  approve: boolean,
  adminId: string,
  note?: string,
): Promise<WithdrawalRow> {
  return withTransaction(async (client) => {
    const rows = await client.query<WithdrawalRow>('SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE', [
      withdrawalId,
    ]);
    const withdrawal = rows.rows[0];
    if (!withdrawal) throw ApiError.notFound('Withdrawal not found');
    if (withdrawal.status !== 'PENDING') throw ApiError.conflict('Already reviewed');

    const status = approve ? 'APPROVED' : 'REJECTED';
    if (!approve) {
      // Rejection returns the escrowed R-coins to the host.
      await client.query('UPDATE users SET r_coin_balance = r_coin_balance + $2 WHERE id = $1', [
        withdrawal.user_id,
        withdrawal.amount_r_coins,
      ]);
    }
    await client.query(
      `UPDATE withdrawal_requests SET status = $2::withdrawal_status, reviewed_by = $3, reviewed_at = now()
        WHERE id = $1`,
      [withdrawalId, status, adminId],
    );
    await client.query(
      `UPDATE transactions SET status = $2
        WHERE type = 'WITHDRAWAL' AND meta->>'withdrawalId' = $1`,
      [withdrawalId, approve ? 'COMPLETED' : 'REVERSED'],
    );
    if (note) {
      await client.query('UPDATE withdrawal_requests SET payout_details = payout_details || $2::jsonb WHERE id = $1', [
        withdrawalId,
        JSON.stringify({ reviewNote: note }),
      ]);
    }
    const updated = await client.query<WithdrawalRow>('SELECT * FROM withdrawal_requests WHERE id = $1', [withdrawalId]);
    return updated.rows[0];
  });
}

export async function getWallet(userId: string, limit = 30): Promise<{
  user: UserDto;
  transactions: TransactionDto[];
  stats: { diamondsSpent: number; rCoinsEarned: number; giftsSent: number };
}> {
  const userRow = await one<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  if (!userRow) throw ApiError.notFound('Account not found');

  const [transactions, aggregates] = await Promise.all([
    many<TransactionRow>(`${TX_WITH_PARTIES} WHERE t.sender_id = $1 OR t.receiver_id = $1 ORDER BY t.created_at DESC LIMIT $2`, [
      userId,
      limit,
    ]),
    one<{ spent: string; earned: string; sent: string }>(
      `SELECT COALESCE(SUM(amount_diamonds) FILTER (WHERE type = 'GIFT_SENT' AND sender_id = $1), 0) AS spent,
              COALESCE(SUM(amount_r_coins)  FILTER (WHERE type = 'GIFT_SENT' AND receiver_id = $1), 0) AS earned,
              COALESCE(SUM(quantity)        FILTER (WHERE type = 'GIFT_SENT' AND sender_id = $1), 0) AS sent
         FROM transactions WHERE sender_id = $1 OR receiver_id = $1`,
      [userId],
    ),
  ]);

  return {
    user: toUser(userRow),
    transactions: transactions.map(toTransaction),
    stats: {
      diamondsSpent: Number(aggregates?.spent ?? 0),
      rCoinsEarned: Number(aggregates?.earned ?? 0),
      giftsSent: Number(aggregates?.sent ?? 0),
    },
  };
}

/** Hourly gift-spend throttle, surfaced to the client so it can warn the user. */
export async function giftSpendWindow(userId: string): Promise<number> {
  const raw = await redis.get(`rl:gift:${userId}`);
  return Number(raw ?? 0);
}
