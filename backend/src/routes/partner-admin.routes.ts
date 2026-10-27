import { Router } from 'express';
import * as partner from '../controllers/partner-admin.controller';
import { requirePermission } from '../middleware/auth';

/**
 * The operator half of the BD / coin-seller domain, mounted under `/api/admin/business`.
 *
 * Split by capability rather than by table, because that is how the responsibility actually
 * divides: running the partner network is operations (`business:manage`), deciding that money
 * arrived is finance (`recharge:review`), setting a rate is a paid-decision (`commission:manage`),
 * and the switches that change what money means belong to one role (`config:manage`).
 */

const router = Router();

// --- Partner accounts and their limits ---
router.get('/accounts', requirePermission('business:manage'), partner.accounts);
router.post('/accounts', requirePermission('business:manage'), partner.createAccount);
router.patch('/accounts/:id', requirePermission('business:manage'), partner.updateAccount);
router.post('/accounts/:id/status', requirePermission('business:manage'), partner.accountStatus);
router.post('/accounts/:id/password', requirePermission('business:manage'), partner.accountPassword);
router.get('/accounts/:id/sellers', requirePermission('business:manage'), partner.accountTerritory);
router.get('/accounts/:id/packages', requirePermission('business:manage'), partner.readPackages);
router.put('/accounts/:id/packages', requirePermission('business:manage'), partner.assignPackages);

// --- The package catalog: what coins cost, and which sellers may sell it ---
router.get('/packages', requirePermission('finance:read'), partner.packages);
router.put('/packages', requirePermission('config:manage'), partner.savePackageEndpoint);
router.post('/packages/:key/active', requirePermission('config:manage'), partner.packageActive);

// --- Recharge orders ---
router.get('/recharges', requirePermission('finance:read'), partner.rechargeOrders);
router.get('/recharges/statuses', requirePermission('finance:read'), partner.rechargeStatuses);
router.get('/recharges/:id', requirePermission('finance:read'), partner.rechargeOrder);
router.post('/recharges/:id/approve', requirePermission('recharge:review'), partner.approveRecharge);
router.post('/recharges/:id/reject', requirePermission('recharge:review'), partner.rejectRecharge);
router.post('/recharges/:id/reverse', requirePermission('recharge:review'), partner.reverseRecharge);
router.post('/recharges/sweep-expiry', requirePermission('recharge:review'), partner.sweepRechargeExpiry);

// --- Commission: rates, accruals, settlement batches ---
router.get('/commissions/rules', requirePermission('finance:read'), partner.commissionRules);
router.get('/partners', requirePermission('finance:read'), partner.partnerRoster);
router.put('/commissions/rules', requirePermission('commission:manage'), partner.putCommissionRuleEndpoint);
router.post('/commissions/rules/:id/retire', requirePermission('commission:manage'), partner.retireCommissionRuleEndpoint);
router.get('/commissions/entries', requirePermission('finance:read'), partner.commissionEntries);
router.get('/commissions/summary/:id', requirePermission('finance:read'), partner.commissionTotals);
router.get('/commissions/settlements', requirePermission('finance:read'), partner.settlements);
router.post('/commissions/settlements', requirePermission('commission:manage'), partner.createSettlement);
router.post('/commissions/settlements/:id/approve', requirePermission('commission:manage'), partner.approveSettlement);
router.post('/commissions/settlements/:id/pay', requirePermission('commission:manage'), partner.paySettlement);

// --- The book: chart of accounts, journal, balances ---
router.get('/finance/accounts', requirePermission('finance:read'), partner.chart);
router.get('/finance/journal', requirePermission('finance:read'), partner.journal);
router.get('/finance/trial-balance', requirePermission('finance:read'), partner.balances);
router.get('/finance/reconciliation', requirePermission('finance:read'), partner.reconciliation);
router.get('/finance/balance/:code', requirePermission('finance:read'), partner.balances);

// --- The switches (§22: administrator-owned, never hardcoded) ---
router.get('/config/:key', requirePermission('finance:read'), partner.readConfigEndpoint);
router.put('/config/:key', requirePermission('config:manage'), partner.writeConfigEndpoint);

export default router;
