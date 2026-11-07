import { Router } from 'express';
import * as agency from '../controllers/agency-admin.controller';
import { requirePermission } from '../middleware/auth';

/**
 * The agency desk, mounted under `/api/admin/agencies`.
 *
 * Its own prefix rather than a branch of `/admin/business`, because an agency is not a partner in the
 * coin-selling sense: it is a roster of hosts, and its money is a share of what those hosts earned.
 * The two domains meet only in the journal.
 *
 * Reading a position is `finance:read`; setting a rate and moving a batch are `commission:manage` —
 * the same permission that approves a BD or seller payout, since a rate is that decision taken in
 * advance for every gift the roster has not sold yet. Nothing here can change a balance: the accrual
 * is written by the gift path, and the only route that touches the journal is the one recording a
 * transfer that already happened.
 */

const router = Router();

// Registered before `/:id` so "settlements" is never read as an agency uuid.
router.get('/settlements', requirePermission('finance:read'), agency.settlements);
router.get('/settlements/:id', requirePermission('finance:read'), agency.settlement);
router.post('/settlements/:id/approve', requirePermission('commission:manage'), agency.approveSettlement);
router.post('/settlements/:id/pay', requirePermission('commission:manage'), agency.paySettlement);
router.post('/settlements/:id/void', requirePermission('commission:manage'), agency.voidSettlement);

router.get('/', requirePermission('finance:read'), agency.agencies);
router.get('/:id', requirePermission('finance:read'), agency.agency);
router.put('/:id/rate', requirePermission('commission:manage'), agency.putAgencyRate);
// A host's rate is only editable through the agency they belong to, which is the same relationship
// the accrual reads: there is no route that moves a host between rosters.
router.put('/:id/hosts/:userId/rate', requirePermission('commission:manage'), agency.putHostRate);
router.post('/:id/settlements', requirePermission('commission:manage'), agency.raiseSettlement);

export default router;
