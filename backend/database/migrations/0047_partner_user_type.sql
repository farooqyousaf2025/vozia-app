-- Show approved partners as what they were approved to be.
--
-- 0046 added the three partner markers to `user_type` but could not write them: this runner applies
-- each file in one transaction, and PostgreSQL forbids using a new enum value in the transaction
-- that added it. This file is the other half — it reads the live grants and corrects the marker.
--
-- Two histories are being reconciled
-- ----------------------------------
-- An approved COIN_SELLER or BD_MANAGER used to be marked HOST, because the approval path raised
-- every non-agency role to the same marker. And `room.service.ts` raises USER to HOST for anybody
-- who opens a room. Both mean the same thing for this backfill: HOST is not evidence of a host
-- grant, so a live partner grant outranks it. AGENCY_ADMIN is never overwritten — an agency admin
-- who also hosts keeps the marker of the role that runs a roster.
--
-- The latest live grant decides (DISTINCT ON ... created_at DESC): a member approved as a host and
-- later as a seller reads as a seller. Only APPROVED, never-revoked grants count, matching the
-- ownership backfill in 0046. Revocation suspends the account itself, which is what the desk and
-- the gates read; the marker is display, and this file does not try to make it authority.
--
-- Idempotent: the `<>` guard means a re-run writes nothing, and no balance, status or grant moves.
-- ---------------------------------------------------------------------------

UPDATE users u
   SET user_type = g.marker::user_type, updated_at = now()
  FROM (
    SELECT DISTINCT ON (user_id) user_id,
           CASE role
             WHEN 'AGENCY'      THEN 'AGENCY_ADMIN'
             WHEN 'HOST'        THEN 'HOST'
             WHEN 'COIN_SELLER' THEN 'COIN_SELLER'
             WHEN 'BD_MANAGER'  THEN 'BD_MANAGER'
           END AS marker
      FROM role_applications
     WHERE status = 'APPROVED'
       AND revoked_at IS NULL
     ORDER BY user_id, created_at DESC
  ) g
 WHERE g.user_id = u.id
   AND u.user_type IN ('USER', 'HOST')
   AND u.user_type <> g.marker::user_type;