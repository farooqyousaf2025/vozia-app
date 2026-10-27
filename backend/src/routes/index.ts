import { Router } from 'express';
import adminRoutes from './admin.routes';
import authRoutes from './auth.routes';
import businessRoutes from './business.routes';
import gameRoutes from './game.routes';
import giftRoutes from './gift.routes';
import livekitRoutes from './livekit.routes';
import paymentsRoutes from './payments.routes';
import roomRoutes from './room.routes';
import userRoutes from './user.routes';
import walletRoutes from './wallet.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/rooms', roomRoutes);
router.use('/gifts', giftRoutes);
router.use('/games', gameRoutes);
router.use('/wallet', walletRoutes);
router.use('/users', userRoutes);
router.use('/admin', adminRoutes);
// Partner panel: BD representatives and coin sellers. Its own prefix, because a partner
// credential must never be able to reach an operator route.
router.use('/business', businessRoutes);
router.use('/livekit', livekitRoutes);
router.use('/payments', paymentsRoutes);

export default router;
