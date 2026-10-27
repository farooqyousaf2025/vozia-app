import { Router } from 'express';
import * as rooms from '../controllers/room.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', rooms.list);
router.post('/', requireAuth, rooms.create);
// Registered before '/:id', which would otherwise swallow it as a room id.
router.get('/themes', rooms.themes);
// The seat policy the create-room form needs, straight from the administrator's setting.
router.get('/capacity', rooms.capacity);
// Discovery shortcuts, both about the caller rather than a room they named.
router.get('/quick-join', requireAuth, rooms.quickJoin);
router.get('/mine', requireAuth, rooms.mine);
router.get('/:id', rooms.show);

router.post('/:id/join', requireAuth, rooms.join);
router.post('/:id/leave', requireAuth, rooms.leave);
router.post('/:id/livekit-token', requireAuth, rooms.livekitToken);
router.post('/:id/hand-raise', requireAuth, rooms.handRaise);
router.post('/:id/theme', requireAuth, rooms.setTheme);
router.patch('/:id', requireAuth, rooms.update);
router.delete('/:id', requireAuth, rooms.remove);
router.post('/:id/close', requireAuth, rooms.close);

// Seat moderation. `:index/leave` steps the caller down; the host uses lock/mute/kick.
router.post('/:id/seat', requireAuth, rooms.seatTake);
router.post('/:id/seat/:index/leave', requireAuth, rooms.seatLeave);
router.post('/:id/seat/:index/lock', requireAuth, rooms.seatLock);
router.post('/:id/seat/:index/mute', requireAuth, rooms.seatMute);
router.post('/:id/seat/:index/kick', requireAuth, rooms.seatKick);

export default router;
