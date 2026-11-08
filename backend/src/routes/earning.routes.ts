import { Router } from 'express';
import * as earning from '../controllers/earning.controller';
import { requireAuth } from '../middleware/auth';

/**
 * `/api/earnings` — the member's own reward board (migration 0038).
 *
 * Its own prefix for the same reason `/quests` has one: the screen loads before a room is chosen, and
 * a payout is a money path rather than a profile field. All three routes are per-member and
 * authenticated; the board is read from the live rules, so a campaign an operator closed disappears
 * from it on the next request without the app asking anything.
 *
 * There is no route here that states a price, a target or a progress value. `POST /claim` names a rule
 * and attaches evidence; everything else about the reward is read off the rule version inside the
 * transaction that pays it.
 */

const router = Router();

router.get('/', requireAuth, earning.board);
router.post('/claim', requireAuth, earning.claim);
router.get('/payouts', requireAuth, earning.myPayouts);

export default router;
