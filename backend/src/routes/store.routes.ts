import { Router } from 'express';
import * as store from '../controllers/store.controller';
import { requireAuth } from '../middleware/auth';

/**
 * `/api/store` — the member's shop.
 *
 * Reading it needs a member too: the response marks what the caller owns and wears. Purchase,
 * equip and unequip are the only three ways an account's decoration columns change, which is why
 * no route here accepts a key from a query string or an id some other client supplied.
 */

const router = Router();

router.get('/', requireAuth, store.catalogue);
router.post('/purchase', requireAuth, store.buy);
router.post('/equip', requireAuth, store.equip);
router.post('/unequip', requireAuth, store.unequip);

export default router;
