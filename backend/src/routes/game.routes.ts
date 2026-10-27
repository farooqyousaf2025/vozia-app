import { Router } from 'express';
import * as games from '../controllers/game.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Public: what can be played, and at what price.
router.get('/', games.catalog);

router.use(requireAuth);

// Registered before '/:id' so the literal path is not read as a session id.
router.get('/me/history', games.history);

router.get('/:id', games.show);
router.post('/', games.create);
router.post('/:id/join', games.join);
router.post('/:id/ready', games.ready);
router.post('/:id/start', games.start);
router.post('/:id/action', games.act);
router.post('/:id/leave', games.leave);
router.post('/:id/cancel', games.cancel);
router.post('/:id/dispute', games.dispute);

export default router;
