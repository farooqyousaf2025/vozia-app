import { Router } from 'express';
import * as pk from '../controllers/pk.controller';
import { requireAuth } from '../middleware/auth';

/**
 * `/api/pk` — the PK battle panel.
 *
 * Its own prefix for the same reason `/quests` has one: the panel is opened from a room but reads
 * a resource that is not the room (a battle has two rooms, and the invited host answers from
 * wherever they are). Every route needs a session; the four writes additionally require the caller
 * to host the room they are acting for, which the service checks against `rooms.host_id`.
 */

const router = Router();

router.get('/settings', requireAuth, pk.settings);
router.get('/rooms/:roomId', requireAuth, pk.roomBattle);
router.get('/rooms/:roomId/history', requireAuth, pk.history);
router.get('/battles/:id', requireAuth, pk.battle);

router.post('/invites', requireAuth, pk.invite);
router.post('/battles/:id/accept', requireAuth, pk.accept);
router.post('/battles/:id/decline', requireAuth, pk.decline);
router.post('/battles/:id/cancel', requireAuth, pk.cancel);

export default router;
