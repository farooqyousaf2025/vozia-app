import { Router } from 'express';
import * as friends from '../controllers/friends.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

router.get('/', friends.list);
router.get('/locations', friends.locations);
router.get('/location-sharing', friends.locationSharingStatus);
router.post('/location-sharing', friends.locationSharing);
router.post('/location', friends.updateLocation);
router.get('/requests', friends.requests);
router.post('/requests/:id/accept', friends.accept);
router.post('/requests/:id/decline', friends.decline);
router.delete('/:userId', friends.remove);
router.post('/:userId/do-not-contact', friends.doNotContact);
router.delete('/:userId/do-not-contact', friends.doNotContact);

export default router;