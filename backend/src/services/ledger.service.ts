import { PoolClient } from 'pg';
import crypto from 'node:crypto';
import { env } from '../config/env';
import { many, one, query, withTransaction } from '../config/db';
import { rateLimit, redis } from '../config/redis';
import { GiftBoxOutcomeRow, GiftRow, TransactionRow, UserRow, WithdrawalRow } from '../types/db';
import { ApiError } from '../utils/http';
import { postCoinSpread } from './finance-journal.service';
import { LuckyRollDto, rollLuckyBox, toBoxOutcomes } from './lucky-box.service';
import { awardXp, ensureRankRegistry, xpForEarning, xpForSpend } from './rank.service';
import { recordQuestProgress } from './quest.service';
import { assertInteractionAllowed } from './social.service';
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

/**
 * One posted row, with the names and art a wallet screen prints beside it.
 *
 * Exposed because a caller that moves money through `postLedgerMoves` gets a transaction id back and
 * still has to show the row it just wrote; re-implementing this join somewhere else would be a
 * second opinion on which columns a receipt is made of.
 */
export async function postedTransaction(id: string): Promise<TransactionRow | null> {
  return one<TransactionRow>(`${TX_WITH_PARTIES} WHERE t.id = $1`, [id]);
}

/**
 * A sender's own retry key, replayed to the transaction it already bought.
 *
 * The client generates it (a uuid per tap-and-hold of Send) and the server treats it as an
 * opaque string: what matters is that the *same* key with the *same* body answers with the
 * *same* gift, so a phone that missed the first response can retry without paying twice.
 * A different body under one key is a bug or an attack, and is refused rather than answered.
 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 80;
const IDEMPOTENCY_KEY_SHAPE = /^[\w.-]{8,80}$/;

/** sha256 over the three fields a retry must repeat; see `gift_requests.request_hash`. */
function giftRequestHash(giftId: string, receiverId: string, quantity: number): string {
  return crypto.createHash('sha256').update(`${giftId}|${receiverId}|${quantity}`).digest('hex');
}

/**
 * Re-reads a completed gift from its ledger row, so a replay returns the same body the original
 * POST returned. Nothing here moves money: the transaction being described already exists.
 */
async function replayedGift(transactionId: string): Promise<SendGiftResult | null> {
  const row = await one<TransactionRow & { receiver_id: string; sender_id: string }>(
    `${TX_WITH_PARTIES} WHERE t.id = $1 AND t.type = 'GIFT_SENT'`,
    [transactionId],
  );
  if (!row) return null;
  const [sender, receiver] = await Promise.all([
    one<UserRow>('SELECT * FROM users WHERE id = $1', [row.sender_id]),
    one<UserRow>('SELECT * FROM users WHERE id = $1', [row.receiver_id]),
  ]);
  const gift = row.gift_id ? await one<GiftRow>('SELECT * FROM gifts WHERE id = $1', [row.gift_id]) : null;
  if (!sender || !receiver) return null;
  return {
    transaction: toTransaction(row),
    sender: toUser(sender),
    receiver: toUser(receiver),
    // A gift row can be deleted by an operator (`transactions.gift_id` then falls to a nameless
    // historical row); the replay still has to answer, so the receipt carries what was paid.
    gift: gift
      ? toGift(gift)
      : { ...toGift(EMPTY_GIFT_ROW), id: row.gift_id ?? '', name: row.gift_name ?? 'Gift', diamondPrice: row.amount_diamonds },
    replayed: true,
    // The roll is read back from the row rather than drawn again: a replay answers with the prize
    // the first request won, and re-rolling would be a second draw for money already paid.
    lucky: (row.meta as { lucky?: LuckyRollDto }).lucky ?? null,
  };
}

/** A row-shaped stand-in for a gift that is no longer in the catalogue. Only the DTO is read. */
const EMPTY_GIFT_ROW: GiftRow = {
  id: '',
  name: '',
  icon_url: '',
  animation_url: null,
  sound_url: null,
  diamond_price: 0,
  r_coin_value: 0,
  category: 'SPECIAL',
  effect_kind: 'TICKER',
  animation_format: 'LOTTIE',
  duration_ms: 0,
  display_priority: 0,
  combo_enabled: false,
  combo_window_ms: 5000,
  min_vip_level: 0,
  sort_order: 0,
  is_active: true,
  is_lucky_box: false,
  receiver_share_bps: 10_000,
};

export type SendGiftResult = {
  transaction: TransactionDto;
  sender: UserDto;
  receiver: UserDto;
  gift: GiftDto;
  /** TRUE when this call answered an existing transaction instead of buying a new one. */
  replayed: boolean;
  /**
   * What a lucky box rolled, or NULL for a flat gift and for a send of a box the catalogue has since
   * changed. The money is already in `transaction` and in both users' balances; this is the part of
   * the receipt that cannot be re-derived — the prize list itself — and it is what the room's
   * animation and the wallet row both print.
   */
  lucky: LuckyRollDto | null;
};

/** Everything the ledger transaction produces when it actually pays. */
type GiftPayment = {
  transaction: TransactionRow;
  commission: TransactionRow | null;
  sender: UserRow;
  receiver: UserRow;
  gift: GiftRow;
  totalDiamonds: number;
  totalRCoins: number;
  lucky: LuckyRollDto | null;
};

/**
 * Either this request paid, or it found a concurrent twin that already did and has to be answered
 * from that twin's ledger row instead. The caller discriminates on `replayTransactionId`.
 */
type GiftOutcome = { replayTransactionId: string } | { paid: GiftPayment };

/**
 * Draws one lucky box send's prizes from the rows the operator wrote.
 *
 * The read happens here, inside the transaction that posts the credit, rather than from the
 * catalogue service: `amount_r_coins`, the receiver's XP, the agency's commission and the room's PK
 * total are all derived from this answer, so a prize table edited between the draw and the debit
 * would otherwise be paid for one box and credited as another. A write that lands mid-send can
 * still change *which* prizes exist — it cannot change what this send is credited, because every
 * downstream number reads the same roll object.
 */
async function drawLuckyBox(client: PoolClient, gift: GiftRow, quantity: number): Promise<LuckyRollDto> {
  const rows = await client.query<GiftBoxOutcomeRow>(
    'SELECT * FROM gift_box_outcomes WHERE gift_id = $1 ORDER BY sort_order ASC, label ASC',
    [gift.id],
  );
  if (!rows.rowCount) {
    throw ApiError.conflict(`${gift.name} is a lucky box with no prizes to roll`, 'lucky_box_not_configured');
  }
  return rollLuckyBox(toBoxOutcomes(rows.rows), gift.r_coin_value, quantity, gift.receiver_share_bps);
}

export async function sendGift(input: {
  senderId: string;
  receiverId: string;
  giftId: string;
  quantity: number;
  roomId?: string;
  idempotencyKey?: string;
}): Promise<SendGiftResult> {
  await ensureRankRegistry();
  if (input.senderId === input.receiverId) {
    throw ApiError.badRequest('You cannot send a gift to yourself', 'self_gift');
  }
  if (input.quantity < 1 || input.quantity > 999) {
    throw ApiError.badRequest('Quantity must be between 1 and 999');
  }
  if (input.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_SHAPE.test(input.idempotencyKey)) {
    throw ApiError.badRequest(
      `idempotencyKey must be 8-${MAX_IDEMPOTENCY_KEY_LENGTH} characters of letters, digits, dot, dash or underscore`,
      'idempotency_key_invalid',
    );
  }

  // A retry whose original already committed is answered from the ledger before anything is
  // locked: replaying a gift must not take the account locks a live send is waiting on, and it
  // certainly must not spend diamonds a second time.
  if (input.idempotencyKey) {
    const known = await one<{ transaction_id: string; request_hash: string }>(
      `SELECT transaction_id, request_hash FROM gift_requests
        WHERE sender_id = $1 AND idempotency_key = $2 AND transaction_id IS NOT NULL`,
      [input.senderId, input.idempotencyKey],
    );
    if (known) {
      // Checked here as well as in the transaction below, so the fast path cannot answer a
      // mismatched body: reusing one key for another gift is refused, never replayed.
      if (known.request_hash !== giftRequestHash(input.giftId, input.receiverId, input.quantity)) {
        throw ApiError.conflict('That idempotencyKey was already used for a different gift', 'idempotency_key_reused');
      }
      const replay = await replayedGift(known.transaction_id);
      if (replay) return replay;
    }
  }

  const remaining = await rateLimit(`gift:${input.senderId}`, env.economy.giftRatePerMinute, 60);
  if (remaining === -1) throw ApiError.tooManyRequests('Too many gifts in one minute');

  const outcome = await withTransaction<GiftOutcome>(async (client) => {
    const requestHash = input.idempotencyKey
      ? giftRequestHash(input.giftId, input.receiverId, input.quantity)
      : null;

    // The key is claimed before the account locks, and in this order on purpose: a concurrent
    // retry blocks here on the winner's row while holding nothing the winner needs. Claimed the
    // other way round, the two would each wait on the other and PostgreSQL would kill one of them
    // with a deadlock error. An insert, not a lock, because it is the same statement that must
    // roll back with the gift.
    if (input.idempotencyKey && requestHash) {
      const claimed = await client.query<{ id: string }>(
        `INSERT INTO gift_requests (sender_id, idempotency_key, request_hash)
         VALUES ($1,$2,$3) ON CONFLICT (sender_id, idempotency_key) DO NOTHING RETURNING id`,
        [input.senderId, input.idempotencyKey, requestHash],
      );
      if (!claimed.rowCount) {
        // Reaching here means the winner has finished: its row is either a committed gift or
        // nothing at all, since a rolled back insert leaves no row behind.
        const prior = await client.query<{ request_hash: string; transaction_id: string | null }>(
          `SELECT request_hash, transaction_id FROM gift_requests
            WHERE sender_id = $1 AND idempotency_key = $2`,
          [input.senderId, input.idempotencyKey],
        );
        const winner = prior.rows[0];
        if (!winner) throw ApiError.conflict('Gift request already in flight; retry it', 'gift_request_in_flight');
        if (winner.request_hash !== requestHash) {
          throw ApiError.conflict('That idempotencyKey was already used for a different gift', 'idempotency_key_reused');
        }
        // A row whose transaction is still NULL belongs to a transaction that has not committed,
        // and the conflict above only resolves once it has — so this is the race where the winner
        // rolled back and a third request re-claimed the key between the two statements.
        if (!winner.transaction_id) throw ApiError.conflict('Gift request already in flight; retry it', 'gift_request_in_flight');
        // Answer with the winner's gift instead of paying again. This transaction has written
        // nothing — the conflicting insert was a no-op — so there is nothing to unwind, and the
        // caller reads the committed row from the ledger the same way a sequential retry does.
        return { replayTransactionId: winner.transaction_id };
      }
    }

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
    // A block is read symmetrically, so a gift is refused whichever side pressed block. The check
    // runs inside the transaction with the two account locks: a block written concurrently either
    // commits before this gift or waits for it, never lands halfway.
    await assertInteractionAllowed(sender.id, receiver.id, client);

    // An in-room gift is broadcast to that room, so both halves of the pair have to be in it.
    // Without this, a client could name any room id and have its animation shown to strangers —
    // and `rooms.total_gift_value`, which the PK scoreboard and the room's own totals read, would
    // gain credits for a room neither party was ever in.
    if (input.roomId) {
      const present = await client.query<{ user_id: string }>(
        `SELECT user_id FROM room_participants
          WHERE room_id = $1 AND user_id = ANY($2::uuid[]) AND left_at IS NULL`,
        [input.roomId, [sender.id, receiver.id]],
      );
      if (!present.rows.some((r) => r.user_id === sender.id)) {
        throw ApiError.forbidden('You are not in this room', 'not_in_room');
      }
      if (!present.rows.some((r) => r.user_id === receiver.id)) {
        throw ApiError.forbidden('The receiver is not in this room', 'receiver_not_in_room');
      }
    }

    const giftRes = await client.query<GiftRow>('SELECT * FROM gifts WHERE id = $1 AND is_active', [input.giftId]);
    const gift = giftRes.rows[0];
    if (!gift) throw ApiError.notFound('Gift is not available', 'gift_not_found');

    const totalDiamonds = gift.diamond_price * input.quantity;
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

    // What the receiver banks. A flat gift pays `r_coin_value` per unit; a lucky box pays the same
    // pool multiplied by a prize drawn just now — after both gates, so a send that could not have
    // been afforded never consumes a draw, and inside this transaction, so the number posted below
    // is the number that was rolled. Everything after this point reads `totalRCoins` and does not
    // care which of the two it is: XP, quests, the agency's commission and the room's PK total all
    // follow the prize, which is what makes a 0.5x roll earn 0.5x on the scoreboard too.
    const lucky = gift.is_lucky_box ? await drawLuckyBox(client, gift, input.quantity) : null;
    const totalRCoins = lucky ? lucky.receiverRCoins : gift.r_coin_value * input.quantity;

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

    // Experience is part of the same transaction as the money: a gift that rolls back cannot leave
    // a rank behind, and a sender cannot farm XP by failing a send. `rank.service` owns the rate.
    await awardXp(client, sender.id, xpForSpend(totalDiamonds));
    await awardXp(client, receiver.id, xpForEarning(totalRCoins));

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
        // A box's prize lives in the receipt, not only in the animation: the ledger row is what a
        // wallet screen and an audit both read, and the odds the box published at the time of the
        // draw are part of what was paid for. Nothing here is recomputed from the catalogue — which
        // is also how a box keeps telling the same story after an operator reweights it.
        JSON.stringify({ giftName: gift.name, iconUrl: gift.icon_url, ...(lucky ? { lucky } : {}) }),
        sender.diamond_balance - totalDiamonds,
        receiver.r_coin_balance + totalRCoins,
      ],
    );

    // The book's half of the row just posted. The diamonds the sender burnt were a liability the
    // platform owed its holder; the R-coins the receiver banks are a new one; and the gap between
    // them — the catalogue spread on a flat gift, the drawn tax on a lucky box, and a loss when a box
    // rolls past its pool — is the take this service has always had and never stated. Keyed on the
    // ledger row, so a retried send describes the gift once.
    await postCoinSpread(client, {
      sourceKind: 'GIFT_TAX',
      sourceId: txRes.rows[0].id,
      memo: `${gift.name} x${input.quantity}: ${totalDiamonds} diamonds spent, ${totalRCoins} R-coins banked`,
      coinsReleased: totalDiamonds,
      coinsMinted: totalRCoins,
    });

    // Daily quests are counted from the same transaction that moved the diamonds. `quantity` is
    // gifts sent; `totalDiamonds` is what the spend quest measures. Both are recorded server-side,
    // so a gift that rolls back advances neither quest nor the XP a finished quest pays.
    await recordQuestProgress(client, sender.id, [
      { metric: 'GIFT_SENT', amount: input.quantity },
      { metric: 'DIAMONDS_SPENT', amount: totalDiamonds },
    ]);

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

    // The key now points at the money it bought. Same transaction, so a reader either sees the
    // gift and its key together or sees neither — never a key that promises a transaction that
    // was rolled back.
    if (input.idempotencyKey) {
      await client.query(
        'UPDATE gift_requests SET transaction_id = $3 WHERE sender_id = $1 AND idempotency_key = $2',
        [sender.id, input.idempotencyKey, txRes.rows[0].id],
      );
    }

    const freshSender = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [sender.id]);
    const freshReceiver = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [receiver.id]);

    return {
      paid: {
        transaction: txRes.rows[0],
        commission,
        sender: freshSender.rows[0],
        receiver: freshReceiver.rows[0],
        gift,
        totalDiamonds,
        totalRCoins,
        lucky,
      },
    } as const;
  });

  if ('replayTransactionId' in outcome) {
    const replay = await replayedGift(outcome.replayTransactionId);
    if (!replay) throw ApiError.conflict('Gift request already in flight; retry it', 'gift_request_in_flight');
    return replay;
  }
  const result = outcome.paid;

  const enriched = await one<TransactionRow>(`${TX_WITH_PARTIES} WHERE t.id = $1`, [result.transaction.id]);
  return {
    transaction: toTransaction(enriched ?? result.transaction),
    sender: toUser(result.sender),
    receiver: toUser(result.receiver),
    gift: toGift(result.gift),
    replayed: false,
    lucky: result.lucky,
  };
}

/**
 * Forget idempotency keys nobody could retry with any more.
 *
 * A key is useful for as long as a client might still be holding the request it was generated for
 * — seconds, or a few minutes on a lift. Thirty-five days is far beyond any of that, and the row's
 * job by then is done: the transaction it names stays in the ledger forever, which is the audit
 * trail. Called from the boot sweep alongside recharge-order expiry so the table cannot grow with
 * every tap of Send.
 */
export async function pruneGiftRequests(): Promise<number> {
  const res = await query("DELETE FROM gift_requests WHERE created_at < now() - interval '35 days'");
  return res.rowCount ?? 0;
}

/** Simulated top-up: no PSP is wired, so this credits diamonds directly. */
export async function recharge(userId: string, amountDiamonds: number): Promise<{ transaction: TransactionDto; user: UserDto }> {
  await ensureRankRegistry();
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
  await ensureRankRegistry();
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
  await ensureRankRegistry();
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
  await ensureRankRegistry();
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
  await ensureRankRegistry();
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
