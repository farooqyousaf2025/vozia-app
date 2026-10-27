import { Router } from 'express';
import * as users from '../controllers/user.controller';

const router = Router();

router.get('/top', users.leaderboard);
router.get('/:id', users.profile);

export default router;
