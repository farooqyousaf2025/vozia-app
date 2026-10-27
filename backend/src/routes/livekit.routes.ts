import { Router } from 'express';
import * as livekit from '../controllers/livekit.controller';

const router = Router();

// The signature is checked against req.rawBody, captured by the JSON parser in app.ts.
router.post('/webhook', livekit.webhook);

export default router;
