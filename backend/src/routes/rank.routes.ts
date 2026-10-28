import { Router } from 'express';
import * as ranks from '../controllers/rank.controller';

const router = Router();

router.get('/', ranks.ladder);

export default router;
