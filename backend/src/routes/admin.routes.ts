import { Router } from 'express';
import * as admin from '../controllers/admin.controller';
import * as auth from '../controllers/auth.controller';
import partnerRoutes from './partner-admin.routes';
import { requireAdminOperator, requirePermission } from '../middleware/auth';

/**
 * The back office (§10, §23).
 *
 * Two guards, and the order matters. `requireAdminOperator` proves the credential is an
 * operator's — a user token or a BD/seller token cannot reach this router at all — and reads
 * the operator's row, because the role inside a twelve-hour token is who they were when they
 * signed in. `requirePermission` then decides, per route, whether that role may do the thing.
 *
 * Nothing here trusts a role name it was handed; and nothing here is reachable without an
 * authenticated, authorized server-side operation, which is what the audit writes in
 * `admin.controller` exist to make attributable.
 */

const router = Router();

// Public: operator sign-in (username + password, distinct from the user OTP path).
router.post('/login', auth.login);

router.use(requireAdminOperator);

router.get('/me', admin.whoami);
router.post('/change-password', admin.changePassword);
router.get('/stats', requirePermission('dashboard:read'), admin.stats);

router.get('/users', requirePermission('user:read'), admin.users);
router.post('/users/:id/balance', requirePermission('user:wallet'), admin.adjustUserBalance);
router.post('/users/:id/ban', requirePermission('user:moderate'), admin.ban);
router.post('/users/:id/vip', requirePermission('user:vip'), admin.setVipLevel);

router.get('/rooms', requirePermission('room:read'), admin.rooms);
// Before '/rooms/:id', which would otherwise read 'seat-policy' as a room id.
router.get('/rooms/seat-policy', requirePermission('room:read'), admin.seatPolicy);
router.put('/rooms/seat-policy', requirePermission('config:manage'), admin.setSeatPolicy);
router.get('/rooms/:id', requirePermission('room:read'), admin.roomDetail);
router.post('/rooms/:id/close', requirePermission('room:moderate'), admin.closeMonitoredRoom);
router.post('/rooms/:id/disconnect-user', requirePermission('room:moderate'), admin.disconnectUser);
router.post('/rooms/:id/chat', requirePermission('room:moderate'), admin.sendRoomChat);
router.post('/rooms/:id/warn', requirePermission('room:moderate'), admin.warnHost);
router.post('/rooms/:id/mute-all', requirePermission('room:moderate'), admin.muteAll);
router.post('/rooms/:id/seat/:index/mute', requirePermission('room:moderate'), admin.muteSeat);
router.post('/rooms/:id/seat/:index/lock', requirePermission('room:moderate'), admin.lockSeat);
router.post('/rooms/:id/theme', requirePermission('room:moderate'), admin.setRoomTheme);
router.post('/rooms/:id/ban', requirePermission('room:moderate'), admin.banUser);
router.delete('/rooms/:id/ban/:userId', requirePermission('room:moderate'), admin.liftBan);

router.get('/gifts', requirePermission('dashboard:read'), admin.gifts);
router.post('/gifts', requirePermission('gift:manage'), admin.createGiftEndpoint);
router.put('/gifts/:id', requirePermission('gift:manage'), admin.updateGiftEndpoint);
router.delete('/gifts/:id', requirePermission('gift:manage'), admin.removeGiftEndpoint);

router.get('/withdrawals', requirePermission('withdrawal:review'), admin.withdrawals);
router.post('/withdrawals/:id/review', requirePermission('withdrawal:review'), admin.reviewWithdrawalEndpoint);

router.get('/games', requirePermission('game:read'), admin.games);
router.put('/games/:key/rules', requirePermission('game:manage'), admin.setGameRules);
router.get('/games/:id/events', requirePermission('game:read'), admin.gameEventLog);
router.get('/disputes', requirePermission('game:dispute'), admin.disputes);
router.post('/disputes/:id/review', requirePermission('game:dispute'), admin.reviewGameDispute);

// §21-§23: BD accounts, coin sellers, recharge orders, commission and the book.
router.use('/business', partnerRoutes);

// Audit needs its own permission: the log names every other role's work, so reading it is not
// a courtesy attached to `dashboard:read`.
router.get('/audit', requirePermission('audit:read'), admin.audit);

export default router;
