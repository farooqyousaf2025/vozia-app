import crypto from 'node:crypto';
import { GiftBoxOutcomeRow } from '../types/db';
import { ApiError, requireInt, requireString } from '../utils/http';

/**
 * The bounds the draw accepts, stated once because they are the table's own CHECK constraints: a
 * body that asks for a 50,000x prize is refused here with the sentence that says which prize is
 * wrong, rather than by a constraint name out of a 500.
 */
export const MIN_MULTIPLIER_BPS = 100;
export const MAX_MULTIPLIER_BPS = 1_000_000;
export const MIN_WEIGHT = 1;
export const MAX_WEIGHT = 10_000;

/**
 * Lucky gift boxes (migration 0027) — the one gift whose credit the server draws.
 *
 * Everything about a box is the same as a flat gift except the number the receiver banks, and this
 * file is deliberately pure: it reads nothing and writes nothing. `ledger.sendGift` owns the money
 * and the locks, calls in here for a roll after the price has been debited from nothing yet — the
 * same point in the transaction where the flat path multiplies `r_coin_value` by the quantity — and
 * then posts one ledger row either way. A roll that could consult a request body would be a slot
 * machine with the payout lever on the outside, so the only inputs are catalogue columns the
 * operator wrote and a quantity the ledger already validated.
 */

/** Ten-thousandths, the unit every ratio in this file is expressed in. */
const ONE = 10_000;

/** A box with more prizes than this cannot show its own odds on a phone, let alone audit them. */
export const MAX_BOX_OUTCOMES = 20;

/** One prize as the draw sees it. `weight` is relative, so the rows never have to sum to anything. */
export type BoxOutcome = { label: string; multiplierBps: number; weight: number };

/** One prize as an API publishes it: the odds, in the same unit the admin's weights are counted in. */
export type BoxOutcomeDto = {
  label: string;
  multiplierBps: number;
  /** This row's share of the box's total weight — what "1 in 100" becomes once it is a number. */
  chanceBps: number;
  /** Only in the operator's catalogue; a device shows `chanceBps`, which is the same fact scaled. */
  weight?: number;
};

/** A gift event's prize, so every device tells the same story about what was won. */
export type LuckyRollDto = {
  /** Prizes that came up in this send, best first, with how many of the units each won. */
  outcomes: { label: string; multiplierBps: number; chanceBps: number; count: number }[];
  /** The single prize worth taking the screen for: the best one the send rolled. */
  headline: { label: string; multiplierBps: number };
  /** The rolled pool, before the receiver's share. */
  grossRCoins: number;
  /** What was actually credited — this is `amount_r_coins` on the ledger row. */
  receiverRCoins: number;
  /** `grossRCoins - receiverRCoins`, reported so a payout rate is never re-derived by hand. */
  platformTaxRCoins: number;
  receiverShareBps: number;
};

/**
 * Draws `quantity` prizes and turns them into money.
 *
 * One draw per unit rather than one per send: nine hundred and ninety-nine boxes are nine hundred
 * and ninety-nine boxes, and a single roll over the whole quantity would make a bulk send a coin
 * flip on the room's scoreboard. Per-unit draws keep the variance where the weights put it, and the
 * arithmetic is floored per unit before anything is summed, so a box that pays 0.5x of an odd pool
 * rounds the same way whatever the quantity.
 */
export function rollLuckyBox(
  outcomes: readonly BoxOutcome[],
  rCoinValue: number,
  quantity: number,
  receiverShareBps: number,
): LuckyRollDto {
  const weights = outcomes.map((o) => o.weight);
  const total = weights.reduce((sum, w) => sum + w, 0);
  const counts = new Map<number, number>();
  for (let draw = 0; draw < quantity; draw += 1) {
    let pick = crypto.randomInt(total);
    let winner = outcomes.length - 1;
    for (let i = 0; i < outcomes.length; i += 1) {
      if (pick < weights[i]) {
        winner = i;
        break;
      }
      pick -= weights[i];
    }
    counts.set(winner, (counts.get(winner) ?? 0) + 1);
  }

  let gross = 0;
  const rolled = outcomes
    .map((outcome, index) => {
      const count = counts.get(index) ?? 0;
      if (!count) return null;
      gross += Math.floor((rCoinValue * outcome.multiplierBps) / ONE) * count;
      return {
        label: outcome.label,
        multiplierBps: outcome.multiplierBps,
        chanceBps: Math.floor((outcome.weight * ONE) / total),
        count,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.multiplierBps - a.multiplierBps);

  const receiverRCoins = Math.floor((gross * receiverShareBps) / ONE);
  return {
    outcomes: rolled,
    headline: rolled[0],
    grossRCoins: gross,
    receiverRCoins,
    platformTaxRCoins: gross - receiverRCoins,
    receiverShareBps,
  };
}

/** The multiplier a box pays on average, in ten-thousandths of the pool per unit. */
export function expectedMultiplierBps(outcomes: readonly BoxOutcome[]): number {
  const total = outcomes.reduce((sum, o) => sum + o.weight, 0);
  if (!total) return 0;
  const weighted = outcomes.reduce((sum, o) => sum + o.multiplierBps * o.weight, 0);
  return Math.floor(weighted / total);
}

/**
 * Refuses a box that could not be drawn from, or that pays more than it sells.
 *
 * The first half is arithmetic the draw itself would fail on — an empty table has no cumulative
 * weight to walk, and a prize list longer than a screen cannot disclose its own odds. The second
 * half is the one that protects the platform: `receiver_share_bps` and the weights are two dials
 * whose product is the expected payout, and a box whose expected credit exceeds the pool its price
 * bought is a machine that pays out more than it takes in. It is refused here, on the write, rather
 * than discovered in a month of ledger rows — the same reasoning that prices a cosmetic in the
 * catalogue instead of letting the client quote it.
 */
export function validateLuckyBox(input: {
  isLuckyBox: boolean;
  receiverShareBps: number;
  rCoinValue: number;
  outcomes: readonly BoxOutcome[];
}): void {
  if (!input.isLuckyBox) return;
  if (!input.outcomes.length) {
    throw ApiError.badRequest(
      'A lucky box needs at least one prize to roll — add the outcomes, or turn the box off',
      'lucky_box_needs_outcomes',
    );
  }
  if (input.outcomes.length > MAX_BOX_OUTCOMES) {
    throw ApiError.badRequest(
      `A box draws from at most ${MAX_BOX_OUTCOMES} prizes — merge some of these ${input.outcomes.length}`,
      'lucky_box_too_many_outcomes',
    );
  }
  if (input.rCoinValue < 1) {
    throw ApiError.badRequest(
      'A lucky box multiplies its R-coin value, so a box priced at 0 R-coins rolls nothing but zero',
      'lucky_box_needs_reward_pool',
    );
  }
  const expected = expectedMultiplierBps(input.outcomes);
  const payout = Math.floor((expected * input.receiverShareBps) / ONE);
  if (payout > ONE) {
    throw ApiError.badRequest(
      `These odds pay ${payout / 100}% of the pool on average — the share and the weights have to add up to no more than 100%`,
      'lucky_box_payout_unbounded',
      { expectedMultiplierBps: expected, receiverShareBps: input.receiverShareBps, payoutRatioBps: payout },
    );
  }
}

/** Database rows into the shape the draw walks. */
export function toBoxOutcomes(rows: readonly GiftBoxOutcomeRow[]): BoxOutcome[] {
  return rows.map((row) => ({ label: row.label, multiplierBps: row.multiplier_bps, weight: row.weight }));
}

/**
 * The same prizes as an API body, with the odds already divided: `chanceBps` is this row's weight
 * against the box's total, so a phone that wants to print "1 in 100" never has to know the weights
 * exist — and cannot print an odds figure that disagrees with the draw.
 */
export function toBoxOutcomeDtos(outcomes: readonly BoxOutcome[], includeWeights: boolean): BoxOutcomeDto[] {
  const total = outcomes.reduce((sum, o) => sum + o.weight, 0) || 1;
  return outcomes.map((o) => ({
    label: o.label,
    multiplierBps: o.multiplierBps,
    chanceBps: Math.floor((o.weight * ONE) / total),
    ...(includeWeights ? { weight: o.weight } : {}),
  }));
}

/**
 * A prize list read from a request body.
 *
 * Bounds are the table's own CHECK constraints, stated here so the answer to a typo is a sentence
 * about `boxOutcomes[3].weight` rather than a constraint name out of a 500. The whole list is
 * replaced on every write that carries it, which is why nothing here needs to know what was there
 * before.
 */
export function readBoxOutcomes(raw: unknown): BoxOutcome[] {
  if (!Array.isArray(raw)) {
    throw ApiError.badRequest('boxOutcomes must be the list of prizes this box rolls', 'lucky_box_outcomes_invalid');
  }
  if (raw.length > MAX_BOX_OUTCOMES) {
    throw ApiError.badRequest(`A box draws from at most ${MAX_BOX_OUTCOMES} prizes`, 'lucky_box_too_many_outcomes');
  }
  return raw.map((entry, index) => {
    const at = `boxOutcomes[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw ApiError.badRequest(`${at} must be an object with label, multiplierBps and weight`, 'lucky_box_outcomes_invalid');
    }
    const row = entry as Record<string, unknown>;
    return {
      label: requireString(row.label, `${at}.label`, { max: 40 }),
      multiplierBps: requireInt(row.multiplierBps, `${at}.multiplierBps`, { min: MIN_MULTIPLIER_BPS, max: MAX_MULTIPLIER_BPS }),
      weight: requireInt(row.weight, `${at}.weight`, { min: MIN_WEIGHT, max: MAX_WEIGHT }),
    };
  });
}

/** The receiver's share of the rolled pool, in ten-thousandths. */
export function readReceiverShareBps(raw: unknown): number {
  return requireInt(raw, 'receiverShareBps', { min: 0, max: ONE });
}
