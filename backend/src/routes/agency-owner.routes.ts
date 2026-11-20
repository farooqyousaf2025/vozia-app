import { Router } from 'express';
import * as agency from '../controllers/agency-owner.controller';
import * as moderation from '../controllers/agency-room-moderation.controller';
import * as announcements from '../controllers/agency-announcement.controller';
import { requireAgencyOwner, requireMasterAgency, requireAuth } from '../middleware/auth';

/**
 * The agency desk, from the agency's side. Financial actions remain read-only and
 * room moderation is limited to hosts currently assigned to the authenticated agency.
 */

const router = Router();

router.get('/position', requireAgencyOwner, agency.position);
router.get('/announcements', requireAgencyOwner, announcements.ownerList);
router.post('/announcements', requireAgencyOwner, announcements.publish);
// Host inbox uses the member session, then verifies recipient snapshot plus current active assignment.
router.get('/announcements/inbox', requireAuth, announcements.hostInbox);
router.post('/announcements/:id/read', requireAuth, announcements.markRead);
router.get('/hosts', requireAgencyOwner, agency.hosts);
router.get('/activity', requireAgencyOwner, agency.hostActivity);
router.get('/attendance', requireAgencyOwner, agency.hostAttendance);
router.get('/goals', requireAgencyOwner, agency.hostGoals);
router.get('/recognition', requireAgencyOwner, agency.hostRecognition);
router.get('/leaderboard', requireAgencyOwner, agency.hostLeaderboard);
router.put('/goals', requireAgencyOwner, agency.updateHostGoals);
router.get('/rooms', requireAgencyOwner, agency.rooms);
router.get('/settlements', requireAgencyOwner, agency.settlements);
router.get('/sub-agencies', requireMasterAgency, agency.subAgencies);

// Scoped room moderation. No close, delete, transfer, theme, capacity, or financial routes.
router.get('/rooms/:id/moderation-audit', requireAgencyOwner, moderation.moderationAudit);
router.get('/rooms/:id/members', requireAgencyOwner, moderation.roomMembers);
router.post('/rooms/:id/mute', requireAgencyOwner, moderation.muteMember);
router.post('/rooms/:id/kick/:userId', requireAgencyOwner, moderation.kickMember);
router.post('/rooms/:id/ban/:userId', requireAgencyOwner, moderation.banMember);
router.delete('/rooms/:id/ban/:userId', requireAgencyOwner, moderation.unbanMember);

export default router;
