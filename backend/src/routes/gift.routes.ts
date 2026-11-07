import { Router } from 'express';
import * as gifts from '../controllers/gift.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', gifts.catalog);
// The caller's own gift receipts, page by page.
router.get('/history', requireAuth, gifts.history);
router.post('/send', requireAuth, gifts.send);

export default router;
