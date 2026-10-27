import { Router } from 'express';
import * as auth from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.post('/request-otp', auth.requestOtp);
router.post('/verify-otp', auth.verifyOtp);
router.get('/me', requireAuth, auth.me);
router.patch('/me', requireAuth, auth.updateMe);
router.put('/me/device-token', requireAuth, auth.setDeviceToken);

export default router;
