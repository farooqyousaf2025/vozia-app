import { Router } from 'express';
import * as banner from '../controllers/banner.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Reading what is on the wall is public; telling the operator it worked takes a session.
router.get('/', banner.list);
router.post('/track', requireAuth, banner.track);

export default router;
