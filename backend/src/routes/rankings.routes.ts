import { Router } from 'express';
import * as rankings from '../controllers/rankings.controller';
import { optionalUser, requireAuth } from '../middleware/auth';

const router = Router();

router.get('/', optionalUser, rankings.board);
router.post('/claim', requireAuth, rankings.claim);

export default router;