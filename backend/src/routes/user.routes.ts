import { Router } from 'express';
import * as users from '../controllers/user.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/top', users.leaderboard);

// The caller's own block list. Registered before '/:id', which would read "blocked" as an id.
router.get('/blocked', requireAuth, users.blockedList);

// A profile is public; the graph around it needs a signed-in caller. Splitting the reads means
// the follower lists never leak to an anonymous scrape while the counts stay visible on profile.
router.get('/:id/followers', requireAuth, users.followers);
router.get('/:id/following', requireAuth, users.following);
router.get('/:id/relationship', requireAuth, users.relationshipStatus);

router.post('/:id/follow', requireAuth, users.follow);
router.delete('/:id/follow', requireAuth, users.unfollow);
router.post('/:id/block', requireAuth, users.block);
router.delete('/:id/block', requireAuth, users.unblock);
router.post('/:id/report', requireAuth, users.report);

router.get('/:id', users.profile);

export default router;
