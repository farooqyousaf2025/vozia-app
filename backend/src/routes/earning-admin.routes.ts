import { Router } from 'express';
import * as earning from '../controllers/earning.controller';
import { requirePermission } from '../middleware/auth';

/**
 * `/api/admin/earning` — the reward engine's controls (migration 0038).
 *
 * Mounted inside the operator router, so `requireAdminOperator` has already run; what is decided here
 * is which of the operator's roles may do which act.
 *
 * Three permissions, chosen for what each route can cost the platform:
 *
 *   * `config:manage` publishes a rule and opens or closes a campaign. It moves no money by itself,
 *     but it decides what will be paid next, which is exactly the seat-policy trade-off — the same
 *     permission that already lets an operator change what a room costs.
 *   * `user:wallet` approves a claim. That is a mint: a bonus diamond with nothing bought behind it,
 *     so it holds the same bar as the manual balance adjustment and the promotional grant.
 *   * `user:read` for the queue, the payout trail and the rule history, because those are reads about
 *     members rather than actions on them.
 *
 * There is no route that edits an activity row, a payout or a grant. Refusing a claim and retiring a
 * rule are the only verdicts an operator gets; the amounts stay where the engine wrote them, so the
 * trail a reconciliation report reads is the trail that was actually paid.
 */

const router = Router();

// The catalogue the panel builds its forms from: which metric the server counts, whether it sums or
// records a level, and which conditions that metric can answer.
router.get('/catalogue', requirePermission('user:read'), earning.catalogue);

// Campaigns. A budget is a ceiling on what this campaign may mint, and closing one is the only verb
// that stops an in-flight attempt from ever being paid again.
router.get('/campaigns', requirePermission('user:read'), earning.campaigns);
router.post('/campaigns', requirePermission('config:manage'), earning.createCampaignEndpoint);
router.get('/campaigns/:idOrKey', requirePermission('user:read'), earning.campaignDetail);
router.put('/campaigns/:idOrKey', requirePermission('config:manage'), earning.updateCampaignEndpoint);
router.delete('/campaigns/:idOrKey', requirePermission('config:manage'), earning.deleteCampaignEndpoint);

// Rules. `POST /rules` is the publish verb for both the first version and a reprice, because each call
// may create a row and attempts already running keep the price they were shown.
router.get('/rules', requirePermission('user:read'), earning.rules);
router.post('/rules', requirePermission('config:manage'), earning.publishRule);
router.get('/rules/:idOrKey', requirePermission('user:read'), earning.ruleDetail);
router.post('/rules/:idOrKey/active', requirePermission('config:manage'), earning.setRuleActiveEndpoint);
router.delete('/rules/:idOrKey', requirePermission('config:manage'), earning.deleteRuleEndpoint);

// The review queue for `SUBMISSION` rules: the one metric a phone can assert, which is why a human
// signs every payment from it.
router.get('/claims', requirePermission('user:read'), earning.claimQueue);
router.post('/claims/:id/approve', requirePermission('user:wallet'), earning.approveClaim);
router.post('/claims/:id/refuse', requirePermission('user:wallet'), earning.refuseClaim);

router.get('/payouts', requirePermission('user:read'), earning.payouts);

// The same sweep the clock runs every minute, for the moment an operator closed a campaign and wants
// the queue to reflect it now.
router.post('/sweep', requirePermission('config:manage'), earning.sweepEndpoint);

export default router;
