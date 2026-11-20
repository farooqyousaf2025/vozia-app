import { many, one, query, withTransaction } from '../config/db';
import { ApiError } from '../utils/http';

export type AgencyAnnouncement = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  recipientCount: number;
  readCount: number;
};

function asAnnouncement(row: {
  id: string; title: string; body: string; created_at: Date;
  recipient_count?: string | number; read_count?: string | number;
}): AgencyAnnouncement {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
    recipientCount: Number(row.recipient_count ?? 0),
    readCount: Number(row.read_count ?? 0),
  };
}

/** Publish once to the active roster snapshot; the agency id is resolved by the owner guard. */
export async function publishAgencyAnnouncement(
  agencyId: string,
  authorUserId: string,
  title: string,
  body: string,
): Promise<AgencyAnnouncement> {
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  if (!cleanTitle || cleanTitle.length > 100) {
    throw ApiError.badRequest('Title must contain 1 to 100 characters', 'invalid_announcement_title');
  }
  if (!cleanBody || cleanBody.length > 3000) {
    throw ApiError.badRequest('Message must contain 1 to 3000 characters', 'invalid_announcement_body');
  }

  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string; title: string; body: string; created_at: Date }>(
      `INSERT INTO agency_announcements (agency_id, author_user_id, title, body)
       VALUES ($1, $2, $3, $4) RETURNING id, title, body, created_at`,
      [agencyId, authorUserId, cleanTitle, cleanBody],
    );
    const announcement = inserted.rows[0];
    const recipients = await client.query(
      `INSERT INTO agency_announcement_recipients (announcement_id, host_user_id)
       SELECT $1, ah.host_user_id
         FROM agency_hosts ah
         JOIN users u ON u.id = ah.host_user_id
        WHERE ah.agency_id = $2 AND ah.status = 'ACTIVE' AND u.status = 'ACTIVE'
       ON CONFLICT DO NOTHING`,
      [announcement.id, agencyId],
    );
    return {
      ...asAnnouncement(announcement),
      recipientCount: recipients.rowCount ?? 0,
      readCount: 0,
    };
  });
}

/** Owner history and counts are restricted to the agency resolved from the owner's session. */
export async function listAgencyAnnouncements(agencyId: string, limit = 50): Promise<AgencyAnnouncement[]> {
  const rows = await many<{
    id: string; title: string; body: string; created_at: Date;
    recipient_count: string; read_count: string;
  }>(
    `SELECT a.id, a.title, a.body, a.created_at,
            COUNT(r.host_user_id)::text AS recipient_count,
            COUNT(r.read_at)::text AS read_count
       FROM agency_announcements a
       LEFT JOIN agency_announcement_recipients r ON r.announcement_id = a.id
      WHERE a.agency_id = $1
      GROUP BY a.id
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [agencyId, Math.max(1, Math.min(limit, 100))],
  );
  return rows.map(asAnnouncement);
}

/** Hosts can read only messages explicitly addressed to them and while still active in that agency. */
export async function listHostAgencyAnnouncements(hostUserId: string, limit = 50) {
  const rows = await many<{
    id: string; title: string; body: string; created_at: Date; read_at: Date | null; agency_name: string;
  }>(
    `SELECT a.id, a.title, a.body, a.created_at, r.read_at, ag.name AS agency_name
       FROM agency_announcement_recipients r
       JOIN agency_announcements a ON a.id = r.announcement_id
       JOIN agencies ag ON ag.id = a.agency_id AND ag.status = 'ACTIVE'
       JOIN agency_hosts ah ON ah.agency_id = a.agency_id
                           AND ah.host_user_id = r.host_user_id
                           AND ah.status = 'ACTIVE'
      WHERE r.host_user_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [hostUserId, Math.max(1, Math.min(limit, 100))],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    agencyName: row.agency_name,
    createdAt: new Date(row.created_at).toISOString(),
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    isRead: row.read_at !== null,
  }));
}

export async function markHostAgencyAnnouncementRead(hostUserId: string, announcementId: string) {
  const row = await one<{ read_at: Date }>(
    `UPDATE agency_announcement_recipients r
        SET read_at = COALESCE(r.read_at, now())
       FROM agency_announcements a, agency_hosts ah, agencies ag
      WHERE r.announcement_id = a.id AND r.host_user_id = $1 AND a.id = $2
        AND ah.agency_id = a.agency_id AND ah.host_user_id = r.host_user_id AND ah.status = 'ACTIVE'
        AND ag.id = a.agency_id AND ag.status = 'ACTIVE'
      RETURNING r.read_at`,
    [hostUserId, announcementId],
  );
  if (!row) throw ApiError.notFound('Announcement is unavailable to this host', 'agency_announcement_not_found');
  return { announcementId, readAt: new Date(row.read_at).toISOString() };
}
