import { Router } from 'express';
import * as emoji from '../controllers/emoji.controller';

const router = Router();

router.get('/', emoji.catalog);

export default router;
