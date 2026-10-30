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
// Experience is the same "levels and VIP" concern as the spend tier, under the same permission,
// and it exists only to correct what the ladder scored — a client can never reach it.
router.post('/users/:id/xp', requirePermission('user:vip'), admin.adjustUserXpEndpoint);

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

// Operator-uploaded gift art, effect scenes and badges. `media:manage` rather than
// `gift:manage`: the same store backs effects and ranks, and maintaining those must not
// quietly grant the right to price a gift.
router.get('/uploads', requirePermission('media:manage'), admin.uploads);
router.post('/uploads', requirePermission('media:manage'), admin.createUploadEndpoint);
router.delete('/uploads/:id', requirePermission('media:manage'), admin.removeUploadEndpoint);

// Room themes and ambient loops (migration 0015). Reading is a room concern — a moderator who can
// restyle one room has to know which looks exist — while changing what every room on the platform
// can wear is `config:manage`, the same permission that holds the seat policy.
router.get('/decor', requirePermission('room:read'), admin.decorCatalogue);
router.post('/themes', requirePermission('config:manage'), admin.createThemeEndpoint);
router.put('/themes/:slug', requirePermission('config:manage'), admin.updateThemeEndpoint);
router.delete('/themes/:slug', requirePermission('config:manage'), admin.deleteThemeEndpoint);
router.post('/effects', requirePermission('config:manage'), admin.createEffectEndpoint);
router.put('/effects/:key', requirePermission('config:manage'), admin.updateEffectEndpoint);
router.delete('/effects/:key', requirePermission('config:manage'), admin.deleteEffectEndpoint);
router.put('/room-categories/:category/effect', requirePermission('config:manage'), admin.mapCategoryEffect);

// Avatar frames (migration 0019). Same split as themes: they ride in `GET /admin/decor` for
// reading, while pricing a ring or retiring it changes what every phone draws and is
// `config:manage`. Granting one hands over value with no money moving — the same consequence as
// adjusting a balance — so that route asks for `user:wallet`.
router.post('/frames', requirePermission('config:manage'), admin.createFrameEndpoint);
router.put('/frames/:key', requirePermission('config:manage'), admin.updateFrameEndpoint);
router.delete('/frames/:key', requirePermission('config:manage'), admin.deleteFrameEndpoint);
router.get('/frames/:key/holders', requirePermission('user:read'), admin.frameHoldersEndpoint);
router.post('/users/:id/grant', requirePermission('user:wallet'), admin.grantItemEndpoint);

// Chat emoji. Reading the catalogue is public (`GET /api/emoji`); this is the operator's view of
// the same rows, and the only way to change what codes members may type.
router.get('/emoji', requirePermission('room:read'), admin.emojiCatalogueEndpoint);
router.post('/emoji', requirePermission('config:manage'), admin.createEmojiEndpoint);
router.put('/emoji/:key', requirePermission('config:manage'), admin.updateEmojiEndpoint);
router.delete('/emoji/:key', requirePermission('config:manage'), admin.deleteEmojiEndpoint);

// The earned-level ladder (migration 0017). Reading it is a `user:read` concern — an operator who
// can see accounts has to know what a badge on one means — while moving a threshold or retiring a
// rung changes what every device shows, which is `config:manage`.
router.get('/ranks', requirePermission('user:read'), admin.rankLadderEndpoint);
router.post('/ranks', requirePermission('config:manage'), admin.createRankEndpoint);
router.put('/ranks/:level', requirePermission('config:manage'), admin.updateRankEndpoint);
router.delete('/ranks/:level', requirePermission('config:manage'), admin.deleteRankEndpoint);

// Daily quests (migration 0020). Reading the catalogue is a `user:read` concern — an operator
// looking at a member's experience should see what pays it — while changing a target or a reward
// sets the pace of the whole platform, so it is `config:manage`. The settings route is registered
// before `/:key` so "settings" is never read as a quest key.
router.get('/quests', requirePermission('user:read'), admin.questsEndpoint);
router.put('/quests/settings', requirePermission('config:manage'), admin.questSettingsEndpoint);
router.post('/quests', requirePermission('config:manage'), admin.createQuestEndpoint);
router.put('/quests/:key', requirePermission('config:manage'), admin.updateQuestEndpoint);
router.delete('/quests/:key', requirePermission('config:manage'), admin.deleteQuestEndpoint);

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
