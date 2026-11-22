import { Router } from 'express';
import * as auth from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.post('/request-otp', auth.requestOtp);
router.post('/verify-otp', auth.verifyOtp);
router.get('/me', requireAuth, auth.me);
router.patch('/me', requireAuth, auth.updateMe);
// Singular paths are retained for older app versions with a single token slot.
router.put('/me/device-token', requireAuth, auth.setLegacyDeviceToken);
router.delete('/me/device-token', requireAuth, auth.clearLegacyMyDeviceToken);

// The current app registers and unregisters the exact FCM installation token.
router.put('/me/device-tokens', requireAuth, auth.setDeviceToken);
router.delete('/me/device-tokens', requireAuth, auth.clearMyDeviceToken);

export default router;
