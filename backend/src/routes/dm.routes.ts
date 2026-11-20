import { Router } from 'express';
import * as dm from '../controllers/dm.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

router.get('/conversations', dm.conversations);
router.get('/conversations/:userId/messages', dm.messages);
router.post('/conversations/:userId/messages', dm.send);
router.post('/conversations/:userId/read', dm.read);

export default router;