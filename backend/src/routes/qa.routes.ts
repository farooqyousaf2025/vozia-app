import { Router } from 'express';
import * as qa from '../controllers/qa.controller';
import { requirePermission } from '../middleware/auth';

/**
 * `/api/admin/qa` — the QA programme's record (migration 0039).
 *
 * Mounted inside the operator router, so `requireAdminOperator` has already run.
 *
 * Two permissions, split by what each act costs:
 *
 *   * `qa:read` for the roster and the money marking. Finance holds it because the book has to be
 *     explainable: an operator reconciling a journal needs to know which rows are QA activity.
 *   * `qa:manage` for marking, and only SUPER_ADMIN holds it. Marking is not a label — because the
 *     money marking is derived, it reclassifies an account's entire financial history at once. That
 *     is a bigger act than editing a balance, and it belongs to one seat.
 *
 * No route here writes a balance, a journal line or a commission. The service has no such path.
 */

const router = Router();

router.get('/identities', requirePermission('qa:read'), qa.roster);
router.post('/identities/mark', requirePermission('qa:manage'), qa.mark);
router.post('/identities/cohort', requirePermission('qa:manage'), qa.markCohort);

// The derived marking: which financial records are test activity, and whose test it was.
router.get('/money/summary', requirePermission('qa:read'), qa.moneySummary);
router.get('/money', requirePermission('qa:read'), qa.money);

export default router;