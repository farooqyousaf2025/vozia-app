// ---------------------------------------------------------------------------
// Lucky gift boxes: the arithmetic the operator's form shares with the server.
//
// This file mirrors `backend/src/services/lucky-box.service.ts` rather than inventing a friendlier
// version of it, and that is the whole reason it exists separately: a box's economics are decided by
// two dials the operator owns — the prize weights and the receiver's share — whose product is what
// the platform pays out, and the write is refused when that product exceeds the pool the price
// bought. If the panel computed the average a different way (rounding where the server floors, or
// weighting the share before the roll), it would warn on a box the server accepts and stay silent on
// the one it refuses, which is exactly the failure the guard was written to prevent. So: the same
// `floor`, in the same order, on the same ten-thousandths.
//
// Formatting lives here too, because "×2.5" and "1 in 4" are how a human states a `multiplierBps`
// and a `chanceBps`, and the form has to read what it types back.
// ---------------------------------------------------------------------------
import type { BoxOutcomeDto, BoxOutcomeInput } from '../types';

/** Ten-thousandths, the unit every ratio in here is counted in — the server's `ONE`. */
export const BPS_FULL = 10_000;

/** `MAX_BOX_OUTCOMES`: a longer table cannot disclose its own odds on a phone, let alone audit them. */
export const MAX_BOX_PRIZES = 20;
/** `requireString(..., { max: 40 })` on a prize label. */
export const MAX_PRIZE_LABEL_CHARS = 40;
/** 0.01× .. 100× — the CHECK constraints on `gift_box_outcomes.multiplier_bps`. */
export const MIN_PRIZE_MULTIPLIER_BPS = 100;
export const MAX_PRIZE_MULTIPLIER_BPS = 1_000_000;
/** The CHECK constraints on `gift_box_outcomes.weight`. Weights are relative, so they need not sum. */
export const MIN_PRIZE_WEIGHT = 1;
export const MAX_PRIZE_WEIGHT = 10_000;

/** One prize as the editor holds it: the operator types decimals, the wire carries ten-thousandths. */
export interface BoxPrizeDraft {
  /** Stable id for the row's own React key — a prize has no identity the server patches by. */
  rowId: string;
  label: string;
  multiplier: string;
  weight: string;
}

/** A prize list the draft could still be edited into; null when a row is not yet a number. */
export function toDraftNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `1 in n` and the odds both read from the same total weight the draw walks. */
export function totalWeight(prizes: readonly { weight: number }[]): number {
  return prizes.reduce((sum, prize) => sum + prize.weight, 0);
}

/**
 * This row's share of the box, in ten-thousandths — the server's `toBoxOutcomeDtos` arithmetic
 * (`floor(weight * 10000 / total)`), so the number beside the input is the number a phone publishes.
 */
export function chanceBpsOf(weight: number, prizes: readonly { weight: number }[]): number {
  const total = totalWeight(prizes) || 1;
  return Math.floor((weight * BPS_FULL) / total);
}

/** `expectedMultiplierBps`: the multiplier a box pays on average, before the receiver's share. */
export function expectedMultiplierBps(prizes: readonly { multiplierBps: number; weight: number }[]): number {
  const total = totalWeight(prizes);
  if (!total) return 0;
  const weighted = prizes.reduce((sum, prize) => sum + prize.multiplierBps * prize.weight, 0);
  return Math.floor(weighted / total);
}

/**
 * What the receiver banks on average, as ten-thousandths of the pool the price bought. Over
 * `BPS_FULL` is the machine that pays out more than it takes in, and the write that asks for it is
 * refused — the same product the server checks, in the same order.
 */
export function payoutRatioBps(expected: number, receiverShareBps: number): number {
  return Math.floor((expected * receiverShareBps) / BPS_FULL);
}

/** What is wrong with one draft row, per input; an empty object is a row the draw would accept. */
export type DraftPrizeError = Partial<{ label: string; multiplier: string; weight: string }>;

/** One row against the bounds `readBoxOutcomes` enforces, in the units the operator types in. */
export function validateDraftPrize(prize: BoxPrizeDraft): DraftPrizeError {
  const errors: DraftPrizeError = {};
  const label = prize.label.trim();
  if (label.length === 0) errors.label = 'A prize needs a name the winner is told.';
  else if (label.length > MAX_PRIZE_LABEL_CHARS) {
    errors.label = `At most ${MAX_PRIZE_LABEL_CHARS} characters — this is the word a room sees.`;
  }

  const multiplier = toDraftNumber(prize.multiplier);
  if (multiplier === null) errors.multiplier = 'Type the multiple as a number, e.g. 2.5 for ×2.5.';
  else if (multiplier < MIN_PRIZE_MULTIPLIER_BPS / BPS_FULL || multiplier > MAX_PRIZE_MULTIPLIER_BPS / BPS_FULL) {
    errors.multiplier = `Between ${MIN_PRIZE_MULTIPLIER_BPS / BPS_FULL}× and ${MAX_PRIZE_MULTIPLIER_BPS / BPS_FULL}×.`;
  } else if (Math.abs(multiplier * BPS_FULL - Math.round(multiplier * BPS_FULL)) > 1e-9) {
    // `draftToOutcomes` rounds, so a finer figure than the ten-thousandths the column holds has to be
    // named rather than silently rewritten into the multiplier the operator did not type.
    errors.multiplier = 'Two decimals at most — the pool is split in ten-thousandths.';
  }

  const weight = toDraftNumber(prize.weight);
  if (weight === null) errors.weight = 'A weight is a whole number of chances.';
  else if (!Number.isInteger(weight)) errors.weight = 'Weights are whole numbers.';
  else if (weight < MIN_PRIZE_WEIGHT || weight > MAX_PRIZE_WEIGHT) {
    errors.weight = `Between ${MIN_PRIZE_WEIGHT} and ${MAX_PRIZE_WEIGHT}.`;
  }
  return errors;
}

/** A whole table, checked against the same shape the draw accepts; empty is a problem the caller names. */
export function validateDraftPrizes(prizes: readonly BoxPrizeDraft[]): {
  rows: DraftPrizeError[];
  /** The first problem in the table, for the summary line under it. */
  firstError: string | null;
} {
  const rows = prizes.map(validateDraftPrize);
  if (prizes.length > MAX_BOX_PRIZES) {
    return {
      rows,
      firstError: `A box draws from at most ${MAX_BOX_PRIZES} prizes — merge some of these ${prizes.length}.`,
    };
  }
  for (const row of rows) {
    const message = row.label ?? row.multiplier ?? row.weight;
    if (message !== undefined) return { rows, firstError: message };
  }
  return { rows, firstError: null };
}

/** Draft rows into the wire list, or null when any row is unparseable — never send half a table. */
export function draftToOutcomes(prizes: readonly BoxPrizeDraft[]): BoxOutcomeInput[] | null {
  const outcomes: BoxOutcomeInput[] = [];
  for (const prize of prizes) {
    const label = prize.label.trim();
    const multiplier = toDraftNumber(prize.multiplier);
    const weight = toDraftNumber(prize.weight);
    if (label.length === 0 || multiplier === null || weight === null) return null;
    outcomes.push({
      label,
      multiplierBps: Math.round(multiplier * BPS_FULL),
      weight: Math.round(weight),
    });
  }
  return outcomes;
}

/** One prize row as the form reads it right now — `null` where the operator is mid-keystroke. */
export interface BoxRowReading {
  rowId: string;
  label: string;
  multiplierBps: number | null;
  weight: number | null;
  /** This row's share of the box, ten-thousandths, exactly as the server publishes `chanceBps`. */
  chanceBps: number | null;
  /** The same fact an operator reasons in: "1 in 25". */
  odds: string;
}

/**
 * The odds beside every row, computed over the weights that are numbers so far.
 *
 * A row's chance is only meaningful against the rest of the table, so an incomplete table shows the
 * odds for the rows it can — a prize list being typed out should not read as a wall of dashes.
 */
export function readPrizeRows(prizes: readonly BoxPrizeDraft[]): BoxRowReading[] {
  const parsed = prizes.map((prize) => ({
    rowId: prize.rowId,
    label: prize.label.trim(),
    multiplierBps: draftMultiplierBps(prize.multiplier),
    weight: draftWeight(prize.weight),
  }));
  const total = parsed.reduce((sum, row) => sum + (row.weight ?? 0), 0);
  return parsed.map((row) => ({
    ...row,
    chanceBps: row.weight === null || total === 0 ? null : Math.floor((row.weight * BPS_FULL) / total),
    odds:
      row.weight === null || total === 0
        ? '—'
        : row.weight >= total
          ? 'every send'
          : formatOdds(row.weight, total),
  }));
}

/** The running economics line: what the table pays on average, and what the receiver banks of it. */
export interface BoxEconomics {
  /** False while a row is still a typo, so the caller says "finish the table" instead of a number. */
  complete: boolean;
  expectedMultiplierBps: number;
  receiverShareBps: number;
  /** Expected payout as ten-thousandths of the pool the price bought; over 10,000 is the refusal. */
  payoutRatioBps: number;
}

export function boxEconomics(prizes: readonly BoxPrizeDraft[], receiverShareBps: number): BoxEconomics {
  const outcomes = draftToOutcomes(prizes);
  const expected = outcomes === null ? 0 : expectedMultiplierBps(outcomes);
  return {
    complete: outcomes !== null && prizes.length > 0,
    expectedMultiplierBps: expected,
    receiverShareBps,
    payoutRatioBps: outcomes === null ? 0 : payoutRatioBps(expected, receiverShareBps),
  };
}

function draftMultiplierBps(raw: string): number | null {
  const value = toDraftNumber(raw);
  if (value === null) return null;
  const bps = Math.round(value * BPS_FULL);
  return bps >= MIN_PRIZE_MULTIPLIER_BPS && bps <= MAX_PRIZE_MULTIPLIER_BPS ? bps : null;
}

function draftWeight(raw: string): number | null {
  const value = toDraftNumber(raw);
  if (value === null || !Number.isInteger(value)) return null;
  return value >= MIN_PRIZE_WEIGHT && value <= MAX_PRIZE_WEIGHT ? value : null;
}

/** The server's `weight`-less DTOs back into editable drafts, so an edit never starts from an empty table. */
export function outcomesToDrafts(outcomes: readonly BoxOutcomeDto[]): BoxPrizeDraft[] {
  return outcomes.map((outcome, index) => ({
    rowId: `prize-${index}`,
    label: outcome.label,
    multiplier: multiplierToInput(outcome.multiplierBps),
    // A DTO read without weights (the member-facing route) still has its odds, and the odds are the
    // weight scaled — so the editor falls back to that rather than inventing a number.
    weight: String(prizeWeightOf(outcome)),
  }));
}

/**
 * The weight behind a published prize.
 *
 * The admin route sends `weight` and the member route sends only `chanceBps`; both describe the same
 * row, so a reader that wants the arithmetic falls back to the odds scaled back onto the box's total.
 */
export function prizeWeightOf(outcome: BoxOutcomeDto): number {
  return outcome.weight ?? outcome.chanceBps;
}

/** A published table as the arithmetic wants it, for a line computed without the editor open. */
export function outcomesToWeights(outcomes: readonly BoxOutcomeDto[]): { multiplierBps: number; weight: number }[] {
  return outcomes.map((outcome) => ({ multiplierBps: outcome.multiplierBps, weight: prizeWeightOf(outcome) }));
}

/**
 * Whether a box's stored table is the one in the editor.
 *
 * PUT leaves `boxOutcomes` alone when the key is absent, and sends a whole replacement when it is
 * present, so the panel sends it only when the operator actually changed the draw. Without this
 * compare, an edit that only moved the share dial would re-send a table read before somebody else's
 * save landed and quietly overwrite theirs.
 */
export function draftsDifferFromOutcomes(prizes: readonly BoxPrizeDraft[], stored: readonly BoxOutcomeDto[]): boolean {
  if (prizes.length !== stored.length) return true;
  return prizes.some((prize, index) => {
    const outcome = stored[index];
    const label = prize.label.trim();
    const multiplier = toDraftNumber(prize.multiplier);
    const weight = toDraftNumber(prize.weight);
    if (outcome === undefined || label.length === 0 || multiplier === null || weight === null) return true;
    // The same fallback the editor seeded the row from, so "unchanged" means the row still says what
    // this read said it said — the weight when the route sent one, the odds scaled back when it did not.
    return (
      outcome.label !== label ||
      outcome.multiplierBps !== Math.round(multiplier * BPS_FULL) ||
      prizeWeightOf(outcome) !== Math.round(weight)
    );
  });
}

// ---- the two dials, in human units -----------------------------------------

/** "60" / "60.5" / "×60%" → 6000 bps; null when it is not a share the server would take. */
export function parseSharePercent(raw: string): number | null {
  const cleaned = raw.trim().replace(/[%×x]/gi, '');
  if (cleaned === '') return null;
  const percent = Number(cleaned);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const bps = percent * 100;
  return Number.isInteger(bps) ? bps : null;
}

/** 6000 → "60", 6050 → "60.5": the dial as the operator set it, without trailing zeros. */
export function sharePercentToInput(receiverShareBps: number): string {
  return trimZeros((receiverShareBps / 100).toFixed(2));
}

/** 25000 → "2.5", the multiplier box a human typed. */
export function multiplierToInput(multiplierBps: number): string {
  return trimZeros((multiplierBps / BPS_FULL).toFixed(2));
}

/** A multiplier as a headline: 25000 → "×2.5". */
export function formatMultiplier(multiplierBps: number): string {
  return `×${multiplierToInput(multiplierBps)}`;
}

/** A ratio in ten-thousandths as a sentence-ready percent: 11800 → "118%", 11850 → "118.5%". */
export function formatRatioPercent(bps: number): string {
  return `${trimZeros((bps / 100).toFixed(2))}%`;
}

/**
 * The odds an operator reasons in. `1 in 4` for a quarter of the weight, `1 in 2.5` for 4000 bps,
 * and a fraction of one chance out of the box's whole weight still reads as a real number rather than
 * "0.00005".
 */
export function formatOdds(weight: number, totalWeight: number): string {
  if (!Number.isFinite(weight) || !Number.isFinite(totalWeight) || weight <= 0 || totalWeight <= 0) {
    return 'never';
  }
  if (weight >= totalWeight) return 'every send';
  const oneIn = totalWeight / weight;
  const text = oneIn >= 100 ? String(Math.round(oneIn)) : trimZeros(oneIn.toFixed(2));
  return `1 in ${text}`;
}

/** `formatOdds` from the odds the server published, for rows the editor has not parsed yet. */
export function formatOddsFromChanceBps(chanceBps: number): string {
  if (chanceBps <= 0) return '1 in more than 10,000';
  if (chanceBps >= BPS_FULL) return 'every send';
  return formatOdds(chanceBps, BPS_FULL);
}

function trimZeros(value: string): string {
  return value.replace(/\.?0+$/, '');
}

// ---- what a refusal means ---------------------------------------------------

/**
 * The stable `error.code` values a gift write answers with for a box, rendered as the sentence an
 * operator acts on. The server's own message is nearly this already; mapping the code keeps the
 * panel's copy in one place, carries the `lucky_box_payout_unbounded` details through, and stops a
 * refusal from ever degrading into "Request failed".
 */
export function describeBoxErrorCode(code: string | undefined, details: unknown): string | null {
  switch (code) {
    case 'lucky_box_needs_outcomes':
      return 'A lucky box has to have at least one prize it can roll — add the prize rows, or turn the box off. An empty table is refused rather than saved, because a box nobody can roll is a payout that quietly stopped.';
    case 'lucky_box_too_many_outcomes':
      return `A box draws from at most ${MAX_BOX_PRIZES} prizes. Merge some rows — a longer table cannot show its own odds on a phone, let alone audit them.`;
    case 'lucky_box_needs_reward_pool':
      return 'A box multiplies this gift’s R-coin value, so an R-coin value of 0 rolls nothing but zero. Give the gift a R-coin value, or turn the box off.';
    case 'lucky_box_outcomes_without_box':
      return 'Prizes were sent without the box switch on. Tick “lucky box” to roll them, or clear the prize rows — the panel does not store an odds table nothing reads.';
    case 'lucky_box_outcomes_invalid':
      return `A prize row needs a name of at most ${MAX_PRIZE_LABEL_CHARS} characters, a multiplier between ${MIN_PRIZE_MULTIPLIER_BPS / BPS_FULL}× and ${MAX_PRIZE_MULTIPLIER_BPS / BPS_FULL}×, and a weight between ${MIN_PRIZE_WEIGHT} and ${MAX_PRIZE_WEIGHT}.`;
    case 'lucky_box_payout_unbounded': {
      const detail = (details ?? {}) as {
        expectedMultiplierBps?: number;
        receiverShareBps?: number;
        payoutRatioBps?: number;
      };
      if (typeof detail.payoutRatioBps !== 'number') {
        return 'On average this box pays more than it sells for. Lower the receiver’s share, or move weight onto the smaller multipliers — the running line under the prize table says how far over it is.';
      }
      const arithmetic =
        typeof detail.expectedMultiplierBps === 'number' && typeof detail.receiverShareBps === 'number'
          ? ` An expected ${formatMultiplier(detail.expectedMultiplierBps)} roll times a ${formatRatioPercent(
              detail.receiverShareBps,
            )} share is already more than the pool.`
          : '';
      return `On average this box pays ${formatRatioPercent(
        detail.payoutRatioBps,
      )} of what it sells for.${arithmetic} Lower the share, or move weight onto the smaller multipliers until the running line reads 100% or less.`;
    }
    default:
      return null;
  }
}
