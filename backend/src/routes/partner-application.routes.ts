import { Router } from 'express';
import * as partner from '../controllers/partner-application.controller';
import { requireAuth } from '../middleware/auth';

/**
 * `/api/role-applications` — Become a Partner, from the side that asks.
 *
 * Its own prefix rather than a branch of `/users`, because the four forms, the queue and the
 * decisions are a workflow rather than profile fields, and because every route here derives the
 * applicant from the token. `POST /` takes a role and an answer object but never a user id: an
 * account can apply for itself and read only its own history, which is what "users must not assign
 * these roles to themselves" reduces to at the HTTP boundary — the assign step is on
 * `/api/admin/partner-applications`, and nothing on this router can reach it.
 */

const router = Router();

router.use(requireAuth);

// The picker's payload: the four forms and where this account stands in each.
router.get('/roles', partner.roles);
router.get('/mine', partner.mine);

// Ordered before `/mine` would matter only if a role could be named "mine"; the segment is a role,
// and the two static routes above are registered first regardless.
router.get('/form/:role', partner.form);

router.post('/', partner.apply);
// `/mine` above is why there is no bare `GET /:id`: the applicant's whole history is one request,
// and an operator reads a single row from the admin router.
router.post('/:id/supplement', partner.supplement);
router.post('/:id/cancel', partner.cancel);

export default router;
