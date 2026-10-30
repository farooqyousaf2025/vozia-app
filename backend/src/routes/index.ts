import { Router } from 'express';
import adminRoutes from './admin.routes';
import authRoutes from './auth.routes';
import businessRoutes from './business.routes';
import emojiRoutes from './emoji.routes';
import gameRoutes from './game.routes';
import giftRoutes from './gift.routes';
import livekitRoutes from './livekit.routes';
import paymentsRoutes from './payments.routes';
import pkRoutes from './pk.routes';
import questRoutes from './quest.routes';
import rankRoutes from './rank.routes';
import roomRoutes from './room.routes';
import storeRoutes from './store.routes';
import userRoutes from './user.routes';
import walletRoutes from './wallet.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/rooms', roomRoutes);
router.use('/gifts', giftRoutes);
// The chat emoji catalogue. Its own prefix because a picker is not part of a room resource:
// a client loads it once per session, before it knows which room it will open.
router.use('/emoji', emojiRoutes);
// The earned-level ladder. Public for the same reason the picker is: a client reads it before it
// knows whose badge it is about to draw.
router.use('/ranks', rankRoutes);
// Today's quests and the check-in. Separate from /users for the same reason /store is: it is an
// XP-writing path, not a profile field, and the screen loads before a room is chosen.
router.use('/quests', questRoutes);
// PK battles. A battle spans two rooms, so it cannot hang off either one; the panel reads it by
// room and the invited host answers by battle id from anywhere in the app.
router.use('/pk', pkRoutes);
router.use('/games', gameRoutes);
router.use('/wallet', walletRoutes);
router.use('/users', userRoutes);
// The cosmetic store. Its own prefix rather than a branch of /users, because buying is a money
// path like /gifts and /wallet — the catalogue and the ownership rows live behind it.
router.use('/store', storeRoutes);
router.use('/admin', adminRoutes);
// Partner panel: BD representatives and coin sellers. Its own prefix, because a partner
// credential must never be able to reach an operator route.
router.use('/business', businessRoutes);
router.use('/livekit', livekitRoutes);
router.use('/payments', paymentsRoutes);

export default router;
