import { Router } from 'express';
import * as gifts from '../controllers/gift.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', gifts.catalog);
router.post('/send', requireAuth, gifts.send);

export default router;
