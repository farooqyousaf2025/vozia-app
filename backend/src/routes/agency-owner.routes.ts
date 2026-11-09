import { Router } from 'express';
import * as agency from '../controllers/agency-owner.controller';
import { requireAgencyOwner, requireMasterAgency } from '../middleware/auth';

/**
 * The agency desk, from the agency's side. Mounted at `/api/agency`.
 *
 * Read-only on purpose, and the two things it does not offer are decisions rather than omissions.
 *
 * A member cannot set a rate. Neither their own, nor their master's, nor their host's: the accrual is
 * money the platform owes, and `commission:manage` is what agrees a number (migration 0033's rule,
 * carried forward by 0040's override). A screen that let an agency pick its own percentage would be
 * a wallet with no owner.
 *
 * A member cannot raise a settlement batch. Raising one claims accruals and puts a hold on the
 * agency's own payable, and the operator route refuses to let the person who raised a batch approve
 * it. A partner-initiated batch would either need a second approval step it does not have or would
 * break that guard, so the request stays where the money book keeps it — with finance — and this
 * surface shows the agency exactly what it is owed and what has already been claimed against it.
 */

const router = Router();

router.get('/position', requireAgencyOwner, agency.position);
router.get('/hosts', requireAgencyOwner, agency.hosts);
router.get('/settlements', requireAgencyOwner, agency.settlements);
// A sub-agency has no sub-agencies, and is refused here rather than shown an empty list it cannot act on.
router.get('/sub-agencies', requireMasterAgency, agency.subAgencies);

export default router;
