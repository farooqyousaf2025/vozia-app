import { Request, Response } from 'express';
import { withTransaction } from '../config/db';
import { ApiError, asyncHandler, optionalEnum, optionalInt, requireString } from '../utils/http';
import {
  EARNING_METRICS,
  EARNING_PURPOSES,
  EARNING_RESETS,
  ELIGIBLE_USER_TYPES,
  REWARD_CURRENCIES,
  EARNING_METRIC_CATALOGUE,
  EarningMetric,
  createCampaign,
  deleteCampaign,
  deleteEarningRule,
  getCampaign,
  getRule,
  listCampaigns,
  listRules,
  putEarningRule,
  setRuleActive,
  updateCampaign,
} from '../services/earning-rule.service';
import {
  adminPayouts,
  claimEarning,
  decideClaim,
  expireStaleActivities,
  listPendingClaims,
  listPayouts,
  memberEarnings,
} from '../services/earning.service';

/**
 * The earning surface (migration 0038, README "Earning rules").
 *
 * Two audiences, and the shape of each follows from what the engine will accept:
 *
 *   * A member may ask what is live for them and file the one kind of claim the platform cannot
 *     observe for itself. Nothing on this side carries a reward, a target or a price — `claimEarning`
 *     reads all three off the rule version inside the transaction that pays, so a body that tried to
 *     name them would only be ignored. An ineligible rule is still returned, with the reason, so the
 *     app can explain a greyed card instead of inventing an explanation.
 *   * An operator publishes rules and campaigns, works the review queue, and reads the payout trail.
 *     The bodies here are passed to the services almost unchanged: validation of a key, a window, a
 *     condition a metric cannot answer, or a budget below what was already minted belongs to the
 *     module that owns the rows, and each refusal carries its own error code.
 *
 * Writing a rule and approving a claim are the two routes that hand out value, so they hold
 * `config:manage` and `user:wallet` — the same permissions as the seat policy and the manual balance
 * adjustment. Reads stay on `user:read`.
 */

// ---------------------------------------------------------------------------
// the member's side
// ---------------------------------------------------------------------------

export const board = asyncHandler(async (req: Request, res: Response) => {
  res.json(await memberEarnings(req.user!.sub));
});

/**
 * File a claim against a `SUBMISSION` rule.
 *
 * 201 when an attempt was filed. A replay of the same `idempotencyKey` answers 200 with the first
 * result, which is how a phone that lost the response retries without filing a second claim.
 */
export const claim = asyncHandler(async (req: Request, res: Response) => {
  const rule = requireString(req.body?.rule, 'rule', { max: 60 });
  const claimKey = optionalEarningKey(req.body?.idempotencyKey);
  const outcome = await claimEarning(req.user!.sub, { rule, evidence: req.body?.evidence, claimKey });
  res.status(outcome.replay ? 200 : 201).json(outcome);
});

/** The payout trail for this account — what the engine actually paid, not what it was offered. */
export const myPayouts = asyncHandler(async (req: Request, res: Response) => {
  const limit = optionalInt(req.query.limit, 'limit', { min: 1, max: 200 }) ?? 50;
  const payouts = await withTransaction((client) => listPayouts(client, { userId: req.user!.sub, limit }));
  res.json({ payouts });
});

/**
 * The idempotency key is optional, but if it is sent it must be usable: the service enforces the same
 * 8-80 character shape as the finance paths, and a shorter empty string is "not sent" rather than a
 * key that will be refused after the money has moved.
 */
function optionalEarningKey(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw ApiError.badRequest('idempotencyKey must be a string', 'bad_request');
  return value;
}

// ---------------------------------------------------------------------------
// the operator's side
// ---------------------------------------------------------------------------

/**
 * The catalogue the panel builds its forms from, so the dropdowns are the server's own enums and the
 * condition fields are the ones the chosen metric can actually answer. A form that guessed would
 * publish rules that refuse themselves at save time.
 */
export const catalogue = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    metrics: EARNING_METRICS.map((metric) => ({
      metric,
      countedBy: EARNING_METRIC_CATALOGUE[metric].countedBy,
      progress: EARNING_METRIC_CATALOGUE[metric].progress,
      restrictions: EARNING_METRIC_CATALOGUE[metric].restrictions,
    })),
    purposes: EARNING_PURPOSES,
    resets: EARNING_RESETS,
    currencies: REWARD_CURRENCIES,
    eligibleUserTypes: ELIGIBLE_USER_TYPES,
  });
});

export const campaigns = asyncHandler(async (req: Request, res: Response) => {
  res.json({ campaigns: await listCampaigns(req.query.includeClosed === 'true') });
});

export const campaignDetail = asyncHandler(async (req: Request, res: Response) => {
  res.json({ campaign: await getCampaign(req.params.idOrKey) });
});

export const createCampaignEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const campaign = await createCampaign(req.admin!.sub, req.body ?? {});
  res.status(201).json({ campaign });
});

export const updateCampaignEndpoint = asyncHandler(async (req: Request, res: Response) => {
  res.json({ campaign: await updateCampaign(req.admin!.sub, req.params.idOrKey, req.body ?? {}) });
});

export const deleteCampaignEndpoint = asyncHandler(async (req: Request, res: Response) => {
  res.json(await deleteCampaign(req.admin!.sub, req.params.idOrKey));
});

export const rules = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    rules: await listRules({
      metric: optionalEnum(req.query.metric, 'metric', EARNING_METRICS),
      campaign: typeof req.query.campaign === 'string' ? req.query.campaign : undefined,
      activeOnly: req.query.activeOnly === 'true',
    }),
  });
});

/** One rule, with every version it has had: the price a member was shown lives in the history. */
export const ruleDetail = asyncHandler(async (req: Request, res: Response) => {
  res.json({ rule: await getRule(req.params.idOrKey) });
});

/**
 * Publish a rule.
 *
 * A POST rather than a PUT because each call can create a row: the first publish for a key is version
 * 1, and a changed body for a live key is version 2 with version 1 switched off. Attempts already
 * running keep the price they started at, which is why this is not an update.
 */
export const publishRule = asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json({ rule: await putEarningRule(req.admin!.sub, req.body ?? {}) });
});

export const setRuleActiveEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const isActive = req.body?.isActive === true;
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  res.json({ rule: await setRuleActive(req.admin!.sub, req.params.idOrKey, isActive, note) });
});

export const deleteRuleEndpoint = asyncHandler(async (req: Request, res: Response) => {
  res.json(await deleteEarningRule(req.admin!.sub, req.params.idOrKey));
});

export const claimQueue = asyncHandler(async (req: Request, res: Response) => {
  const limit = optionalInt(req.query.limit, 'limit', { min: 1, max: 200 }) ?? 50;
  res.json({ claims: await listPendingClaims(limit) });
});

export const approveClaim = asyncHandler(async (req: Request, res: Response) => {
  const note = typeof req.body?.note === 'string' ? req.body.note : '';
  res.json(await decideClaim(req.admin!.sub, req.params.id, true, note));
});

/**
 * The note is not validated here. `decideClaim` owns the rule that a refusal needs one, so the refusal
 * keeps its own error code however the request arrived — a route that checked first would answer a
 * generic `bad_request` and the panel could not tell "you forgot the note" from "that is not a number".
 */
export const refuseClaim = asyncHandler(async (req: Request, res: Response) => {
  const note = typeof req.body?.note === 'string' ? req.body.note : '';
  res.json(await decideClaim(req.admin!.sub, req.params.id, false, note));
});

export const payouts = asyncHandler(async (req: Request, res: Response) => {
  const rows = await adminPayouts({
    campaignKey: typeof req.query.campaign === 'string' ? req.query.campaign : undefined,
    metric: optionalEnum(req.query.metric, 'metric', EARNING_METRICS) as EarningMetric | undefined,
    limit: optionalInt(req.query.limit, 'limit', { min: 1, max: 200 }) ?? 50,
  });
  res.json({ payouts: rows });
});

/**
 * Age out the attempts that can no longer be paid, on demand.
 *
 * The clock runs this every minute, so this route exists for the operator who closed a campaign and
 * does not want a queue of claims still showing tomorrow, not because the sweep is optional.
 */
export const sweepEndpoint = asyncHandler(async (req: Request, res: Response) => {
  res.json(await expireStaleActivities(optionalInt(req.body?.limit, 'limit', { min: 1, max: 5000 }) ?? 500));
});
