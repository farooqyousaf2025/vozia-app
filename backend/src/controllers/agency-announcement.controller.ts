import { Request, Response } from 'express';
import { ApiError, asyncHandler, optionalInt } from '../utils/http';
import {
  listAgencyAnnouncements,
  listHostAgencyAnnouncements,
  markHostAgencyAnnouncementRead,
  publishAgencyAnnouncement,
} from '../services/agency-announcement.service';

export const ownerList = asyncHandler(async (req: Request, res: Response) => {
  const limit = optionalInt(req.query?.limit, 'limit', { min: 1, max: 100 }) ?? 50;
  res.json({ announcements: await listAgencyAnnouncements(req.agencyRow!.id, limit) });
});

export const publish = asyncHandler(async (req: Request, res: Response) => {
  if (typeof req.body?.title !== 'string' || typeof req.body?.body !== 'string') {
    throw ApiError.badRequest('title and body are required', 'invalid_announcement');
  }
  const announcement = await publishAgencyAnnouncement(
    req.agencyRow!.id,
    req.user!.sub,
    req.body.title,
    req.body.body,
  );
  res.status(201).json({ announcement });
});

export const hostInbox = asyncHandler(async (req: Request, res: Response) => {
  const limit = optionalInt(req.query?.limit, 'limit', { min: 1, max: 100 }) ?? 50;
  res.json({ announcements: await listHostAgencyAnnouncements(req.user!.sub, limit) });
});

export const markRead = asyncHandler(async (req: Request, res: Response) => {
  res.json(await markHostAgencyAnnouncementRead(req.user!.sub, req.params.id));
});
