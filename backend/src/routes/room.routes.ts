import { Router } from 'express';
import * as rooms from '../controllers/room.controller';
import * as gifts from '../controllers/gift.controller';
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
// Saved rooms. Registered before '/:id', which would otherwise read "favorites" as a room id.
router.get('/favorites', requireAuth, rooms.favorites);
router.get('/:id', rooms.show);
// The gift tail a reconnecting device replays. Same ids as `room:gift_animated` carried, which is
// what lets a gift that arrived both live and from here animate exactly once.
router.get('/:id/gifts', requireAuth, gifts.roomGifts);

router.post('/:id/join', requireAuth, rooms.join);
router.post('/:id/leave', requireAuth, rooms.leave);
router.post('/:id/livekit-token', requireAuth, rooms.livekitToken);
router.post('/:id/hand-raise', requireAuth, rooms.handRaise);
router.post('/:id/theme', requireAuth, rooms.setTheme);
router.patch('/:id', requireAuth, rooms.update);
router.delete('/:id', requireAuth, rooms.remove);
router.post('/:id/close', requireAuth, rooms.close);

// The pinned notice and the per-member bookmark.
router.post('/:id/announcement', requireAuth, rooms.announcement);
router.get('/:id/favorite', requireAuth, rooms.favoriteShow);
router.post('/:id/favorite', requireAuth, rooms.favoriteAdd);
router.delete('/:id/favorite', requireAuth, rooms.favoriteRemove);

// Seat moderation. `:index/leave` steps the caller down; the host uses lock/mute/kick.
router.post('/:id/seat', requireAuth, rooms.seatTake);
router.post('/:id/seat/:index/leave', requireAuth, rooms.seatLeave);
router.post('/:id/seat/:index/lock', requireAuth, rooms.seatLock);
router.post('/:id/seat/:index/mute', requireAuth, rooms.seatMute);
router.post('/:id/seat/:index/kick', requireAuth, rooms.seatKick);
// Host-driven invitation to a specific seat; the member is already in the audience.
router.post('/:id/seat/:index/invite', requireAuth, rooms.seatInvite);

// The speaker-approval queue. `/cancel` is registered before the request-id routes so it can
// never be mistaken for one.
router.get('/:id/speaker-requests', requireAuth, rooms.speakerRequests);
router.post('/:id/speaker-requests/cancel', requireAuth, rooms.speakerRequestCancel);
router.post('/:id/speaker-requests/:requestId/approve', requireAuth, rooms.speakerRequestApprove);
router.post('/:id/speaker-requests/:requestId/reject', requireAuth, rooms.speakerRequestReject);

// Hand the room to another member present inside it.
router.post('/:id/transfer', requireAuth, rooms.transfer);

export default router;
