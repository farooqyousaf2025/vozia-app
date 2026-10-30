import { Router } from 'express';
import * as quest from '../controllers/quest.controller';
import { requireAuth } from '../middleware/auth';

/**
 * `/api/quests` — today's quests and the daily check-in.
 *
 * Its own prefix rather than a branch of `/users`: the screen is loaded on open, before a member
 * has picked a room, and the check-in is a server-side XP write like `/store/purchase`, not a
 * profile field.
 */

const router = Router();

router.get('/', requireAuth, quest.today);
router.post('/checkin', requireAuth, quest.checkInEndpoint);

export default router;
