import { many } from '../config/db';

type DateValue = Date | string | null;

export type AgencyOperationsHost = {
  userId: string;
  username: string;
  avatarUrl: string | null;
  agencyId: string;
  agencyName: string;
  agencyStatus: string;
  agencyKind: 'MASTER' | 'SUB';
  parentAgencyId: string | null;
  parentAgencyName: string | null;
  joinedAt: string;
  lastVerifiedCheckInAt: string | null;
  lastRoomCreatedAt: string | null;
  lastVisitorAt: string | null;
  lastActivityAt: string | null;
  daysSinceVerifiedCheckIn: number | null;
  attendanceDays7d: number;
  attendanceDays30d: number;
  earnings7dCoins: number;
  earnings30dCoins: number;
  inactive: boolean;
};

export type AgencyOperationsAgency = {
  id: string;
  name: string;
  status: string;
  kind: 'MASTER' | 'SUB';
  parentAgencyId: string | null;
  parentAgencyName: string | null;
  activeHosts: number;
  inactiveHosts: number;
  hostsWithRecentAttendance: number;
  lastVerifiedCheckInAt: string | null;
  earnings7dCoins: number;
  earnings30dCoins: number;
  override7dCoins: number;
  override30dCoins: number;
  retained7dCoins: number;
  retained30dCoins: number;
};

export type AgencyOperationsReport = {
  generatedAt: string;
  timezone: 'UTC';
  windowDays: 7 | 30;
  inactiveDays: 7 | 14 | 30;
  summary: {
    agencies: number;
    activeAgencies: number;
    masterAgencies: number;
    subAgencies: number;
    activeHosts: number;
    inactiveHosts: number;
    hostsWithRecentAttendance: number;
    earnings7dCoins: number;
    earnings30dCoins: number;
  };
  agencies: AgencyOperationsAgency[];
  hosts: AgencyOperationsHost[];
  truncated: { agencies: boolean; hosts: boolean };
};

const ROSTER_CTE = `
  WITH roster AS (
    SELECT ah.host_user_id, ah.agency_id, ah.joined_at,
           u.username, u.avatar_url,
           a.name AS agency_name, a.status AS agency_status,
           a.parent_agency_id, parent.name AS parent_agency_name,
           (a.parent_agency_id IS NOT NULL) AS is_sub,
           checkins.last_checkin_at,
           rooms.last_room_created_at,
           visitors.last_visitor_at,
           COALESCE(attendance.days_7d, 0)::int AS attendance_days_7d,
           COALESCE(attendance.days_30d, 0)::int AS attendance_days_30d,
           COALESCE(earnings.coins_7d, 0)::bigint AS earnings_7d_coins,
           COALESCE(earnings.coins_30d, 0)::bigint AS earnings_30d_coins,
           COALESCE(earnings.override_7d, 0)::bigint AS override_7d_coins,
           COALESCE(earnings.override_30d, 0)::bigint AS override_30d_coins
      FROM agency_hosts ah
      JOIN agencies a ON a.id = ah.agency_id
      JOIN users u ON u.id = ah.host_user_id
      LEFT JOIN agencies parent ON parent.id = a.parent_agency_id
      LEFT JOIN LATERAL (
        SELECT MAX(c.checked_in_at) AS last_checkin_at
          FROM room_host_checkins c
         WHERE c.host_user_id = ah.host_user_id
      ) checkins ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(r.created_at) AS last_room_created_at
          FROM rooms r
         WHERE r.host_id = ah.host_user_id
      ) rooms ON TRUE
      LEFT JOIN LATERAL (
        SELECT MAX(p.joined_at) AS last_visitor_at
          FROM room_participants p
          JOIN rooms r ON r.id = p.room_id
         WHERE r.host_id = ah.host_user_id AND p.user_id <> ah.host_user_id
      ) visitors ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT (c.checked_in_at AT TIME ZONE 'UTC')::date)
                 FILTER (WHERE c.checked_in_at >= now() - INTERVAL '7 days')::int AS days_7d,
               COUNT(DISTINCT (c.checked_in_at AT TIME ZONE 'UTC')::date)
                 FILTER (WHERE c.checked_in_at >= now() - INTERVAL '30 days')::int AS days_30d
          FROM room_host_checkins c
         WHERE c.host_user_id = ah.host_user_id
      ) attendance ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(t.amount_r_coins) FILTER (WHERE t.created_at >= now() - INTERVAL '7 days') AS coins_7d,
               SUM(t.amount_r_coins) FILTER (WHERE t.created_at >= now() - INTERVAL '30 days') AS coins_30d,
               SUM(COALESCE((t.meta->>'overrideCoins')::bigint, 0))
                 FILTER (WHERE t.created_at >= now() - INTERVAL '7 days') AS override_7d,
               SUM(COALESCE((t.meta->>'overrideCoins')::bigint, 0))
                 FILTER (WHERE t.created_at >= now() - INTERVAL '30 days') AS override_30d
          FROM transactions t
         WHERE t.agency_id = ah.agency_id
           AND t.receiver_id = ah.host_user_id
           AND t.type = 'AGENCY_COMMISSION'
           AND t.status = 'COMPLETED'
      ) earnings ON TRUE
     WHERE ah.status = 'ACTIVE'
       AND a.status = 'ACTIVE'
  )
`;

function iso(value: DateValue): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function number(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function agencyOperationsReport(opts: {
  windowDays: 7 | 30;
  inactiveDays: 7 | 14 | 30;
  agencyLimit?: number;
  hostLimit?: number;
}): Promise<AgencyOperationsReport> {
  const agencyLimit = Math.max(1, Math.min(opts.agencyLimit ?? 200, 500));
  const hostLimit = Math.max(1, Math.min(opts.hostLimit ?? 500, 1000));

  const [agencyRows, hostRows, countRows] = await Promise.all([
    many<{
      id: string; name: string; status: string; parent_agency_id: string | null; parent_agency_name: string | null;
      active_hosts: string | number; inactive_hosts: string | number; last_checkin_at: DateValue;
      earnings_7d: string | number; earnings_30d: string | number;
      override_7d: string | number; override_30d: string | number;
      received_override_7d: string | number; received_override_30d: string | number;
    }>(
      `${ROSTER_CTE}, agency_earnings AS (
         SELECT t.agency_id,
                COALESCE(SUM(t.amount_r_coins) FILTER (WHERE t.created_at >= now() - INTERVAL '7 days'), 0)::bigint AS earnings_7d,
                COALESCE(SUM(t.amount_r_coins) FILTER (WHERE t.created_at >= now() - INTERVAL '30 days'), 0)::bigint AS earnings_30d,
                COALESCE(SUM(COALESCE((t.meta->>'overrideCoins')::bigint, 0))
                  FILTER (WHERE t.created_at >= now() - INTERVAL '7 days'), 0)::bigint AS override_7d,
                COALESCE(SUM(COALESCE((t.meta->>'overrideCoins')::bigint, 0))
                  FILTER (WHERE t.created_at >= now() - INTERVAL '30 days'), 0)::bigint AS override_30d
           FROM transactions t
          WHERE t.type = 'AGENCY_COMMISSION' AND t.status = 'COMPLETED'
          GROUP BY t.agency_id
       ), agency_override_receipts AS (
         SELECT (t.meta->>'parentAgencyId')::uuid AS agency_id,
                COALESCE(SUM(COALESCE((t.meta->>'overrideCoins')::bigint, 0))
                  FILTER (WHERE t.created_at >= now() - INTERVAL '7 days'), 0)::bigint AS received_7d,
                COALESCE(SUM(COALESCE((t.meta->>'overrideCoins')::bigint, 0))
                  FILTER (WHERE t.created_at >= now() - INTERVAL '30 days'), 0)::bigint AS received_30d
           FROM transactions t
          WHERE t.type = 'AGENCY_COMMISSION' AND t.status = 'COMPLETED'
            AND t.meta->>'parentAgencyId' IS NOT NULL
          GROUP BY (t.meta->>'parentAgencyId')::uuid
       )
       SELECT a.id, a.name, a.status, a.parent_agency_id, parent.name AS parent_agency_name,
              COUNT(r.host_user_id)::int AS active_hosts,
              COUNT(r.host_user_id) FILTER (
                WHERE r.last_checkin_at IS NULL
                   OR r.last_checkin_at < now() - ($2::int * INTERVAL '1 day')
              )::int AS inactive_hosts,
              MAX(r.last_checkin_at) AS last_checkin_at,
              COALESCE(financials.earnings_7d, 0)::bigint AS earnings_7d,
              COALESCE(financials.earnings_30d, 0)::bigint AS earnings_30d,
              COALESCE(financials.override_7d, 0)::bigint AS override_7d,
              COALESCE(financials.override_30d, 0)::bigint AS override_30d,
              COALESCE(receipts.received_7d, 0)::bigint AS received_override_7d,
              COALESCE(receipts.received_30d, 0)::bigint AS received_override_30d
         FROM agencies a
         LEFT JOIN agencies parent ON parent.id = a.parent_agency_id
         LEFT JOIN roster r ON r.agency_id = a.id
         LEFT JOIN agency_earnings financials ON financials.agency_id = a.id
         LEFT JOIN agency_override_receipts receipts ON receipts.agency_id = a.id
        GROUP BY a.id, a.name, a.status, a.parent_agency_id, parent.name,
                 financials.earnings_7d, financials.earnings_30d,
                 financials.override_7d, financials.override_30d,
                 receipts.received_7d, receipts.received_30d
        ORDER BY a.status = 'ACTIVE' DESC, a.name
        LIMIT $1`,
      [agencyLimit, opts.inactiveDays],
    ),
    many<{
      host_user_id: string; username: string; avatar_url: string | null; agency_id: string; agency_name: string;
      agency_status: string; parent_agency_id: string | null; parent_agency_name: string | null;
      joined_at: DateValue; last_checkin_at: DateValue; last_room_created_at: DateValue; last_visitor_at: DateValue;
      attendance_days_7d: string | number; attendance_days_30d: string | number;
      earnings_7d_coins: string | number; earnings_30d_coins: string | number; inactive: boolean;
      days_since_checkin: string | number | null; last_activity_at: DateValue;
    }>(
      `${ROSTER_CTE}
       SELECT r.host_user_id, r.username, r.avatar_url, r.agency_id, r.agency_name, r.agency_status,
              r.parent_agency_id, r.parent_agency_name, r.joined_at,
              r.last_checkin_at, r.last_room_created_at, r.last_visitor_at,
              r.attendance_days_7d, r.attendance_days_30d,
              r.earnings_7d_coins, r.earnings_30d_coins,
              (r.last_checkin_at IS NULL OR r.last_checkin_at < now() - ($2::int * INTERVAL '1 day')) AS inactive,
              CASE WHEN r.last_checkin_at IS NULL THEN NULL
                   ELSE FLOOR(EXTRACT(EPOCH FROM (now() - r.last_checkin_at)) / 86400)::int END AS days_since_checkin,
              GREATEST(r.last_checkin_at, r.last_room_created_at, r.last_visitor_at) AS last_activity_at
         FROM roster r
        ORDER BY (r.last_checkin_at IS NULL OR r.last_checkin_at < now() - ($2::int * INTERVAL '1 day')) DESC,
                 r.last_checkin_at ASC NULLS FIRST, r.earnings_30d_coins DESC, r.username
        LIMIT $1`,
      [hostLimit, opts.inactiveDays],
    ),
    many<{
      agency_count: string | number; active_agency_count: string | number;
      master_count: string | number; sub_count: string | number;
      host_count: string | number; inactive_host_count: string | number;
      earnings_7d: string | number; earnings_30d: string | number;
    }>(
      `${ROSTER_CTE}, agency_earnings AS (
         SELECT t.agency_id,
                COALESCE(SUM(t.amount_r_coins) FILTER (WHERE t.created_at >= now() - INTERVAL '7 days'), 0)::bigint AS earnings_7d,
                COALESCE(SUM(t.amount_r_coins) FILTER (WHERE t.created_at >= now() - INTERVAL '30 days'), 0)::bigint AS earnings_30d,
                COALESCE(SUM(COALESCE((t.meta->>'overrideCoins')::bigint, 0))
                  FILTER (WHERE t.created_at >= now() - INTERVAL '7 days'), 0)::bigint AS override_7d,
                COALESCE(SUM(COALESCE((t.meta->>'overrideCoins')::bigint, 0))
                  FILTER (WHERE t.created_at >= now() - INTERVAL '30 days'), 0)::bigint AS override_30d
           FROM transactions t
          WHERE t.type = 'AGENCY_COMMISSION' AND t.status = 'COMPLETED'
          GROUP BY t.agency_id
       )
       SELECT
         (SELECT COUNT(*)::int FROM agencies) AS agency_count,
         (SELECT COUNT(*)::int FROM agencies WHERE status = 'ACTIVE') AS active_agency_count,
         (SELECT COUNT(*)::int FROM agencies WHERE parent_agency_id IS NULL) AS master_count,
         (SELECT COUNT(*)::int FROM agencies WHERE parent_agency_id IS NOT NULL) AS sub_count,
         COUNT(*)::int AS host_count,
         COUNT(*) FILTER (
           WHERE last_checkin_at IS NULL
              OR last_checkin_at < now() - ($1::int * INTERVAL '1 day')
         )::int AS inactive_host_count,
         (SELECT COALESCE(SUM(earnings_7d), 0)::bigint FROM agency_earnings) AS earnings_7d,
         (SELECT COALESCE(SUM(earnings_30d), 0)::bigint FROM agency_earnings) AS earnings_30d
       FROM roster`,
      [opts.inactiveDays],
    ),
  ]);

  const agencies: AgencyOperationsAgency[] = agencyRows.map((row) => {
    const activeHosts = number(row.active_hosts);
    const inactiveHosts = number(row.inactive_hosts);
    const earnings7dCoins = number(row.earnings_7d);
    const earnings30dCoins = number(row.earnings_30d);
    const override7dCoins = number(row.override_7d);
    const override30dCoins = number(row.override_30d);
    const receivedOverride7dCoins = number(row.received_override_7d);
    const receivedOverride30dCoins = number(row.received_override_30d);
    return {
      id: row.id, name: row.name, status: row.status,
      kind: row.parent_agency_id ? 'SUB' : 'MASTER',
      parentAgencyId: row.parent_agency_id, parentAgencyName: row.parent_agency_name,
      activeHosts, inactiveHosts, hostsWithRecentAttendance: Math.max(0, activeHosts - inactiveHosts),
      lastVerifiedCheckInAt: iso(row.last_checkin_at),
      earnings7dCoins, earnings30dCoins, override7dCoins, override30dCoins,
      receivedOverride7dCoins, receivedOverride30dCoins,
      retained7dCoins: Math.max(0, earnings7dCoins - override7dCoins),
      retained30dCoins: Math.max(0, earnings30dCoins - override30dCoins),
    };
  });

  const hosts: AgencyOperationsHost[] = hostRows.map((row) => ({
    userId: row.host_user_id, username: row.username, avatarUrl: row.avatar_url,
    agencyId: row.agency_id, agencyName: row.agency_name, agencyStatus: row.agency_status,
    agencyKind: row.parent_agency_id ? 'SUB' : 'MASTER',
    parentAgencyId: row.parent_agency_id, parentAgencyName: row.parent_agency_name,
    joinedAt: iso(row.joined_at) ?? new Date(0).toISOString(),
    lastVerifiedCheckInAt: iso(row.last_checkin_at),
    lastRoomCreatedAt: iso(row.last_room_created_at), lastVisitorAt: iso(row.last_visitor_at),
    lastActivityAt: iso(row.last_activity_at),
    daysSinceVerifiedCheckIn: row.days_since_checkin === null ? null : number(row.days_since_checkin),
    attendanceDays7d: number(row.attendance_days_7d), attendanceDays30d: number(row.attendance_days_30d),
    earnings7dCoins: number(row.earnings_7d_coins), earnings30dCoins: number(row.earnings_30d_coins),
    inactive: Boolean(row.inactive),
  }));

  const counts = countRows[0];

  return {
    generatedAt: new Date().toISOString(), timezone: 'UTC',
    windowDays: opts.windowDays, inactiveDays: opts.inactiveDays,
    summary: {
      agencies: number(counts?.agency_count),
      activeAgencies: number(counts?.active_agency_count),
      masterAgencies: number(counts?.master_count),
      subAgencies: number(counts?.sub_count),
      activeHosts: number(counts?.host_count),
      inactiveHosts: number(counts?.inactive_host_count),
      hostsWithRecentAttendance: Math.max(0, number(counts?.host_count) - number(counts?.inactive_host_count)),
      earnings7dCoins: number(counts?.earnings_7d),
      earnings30dCoins: number(counts?.earnings_30d),
    },
    agencies, hosts,
    truncated: {
      agencies: number(counts?.agency_count) > agencies.length,
      hosts: number(counts?.host_count) > hosts.length,
    },
  };
}

export type AgencyOperationsAuditEntry = {
  id: string;
  action: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
  actor: string;
};

export async function agencyOperationsAudit(agencyId: string, limit: number): Promise<AgencyOperationsAuditEntry[]> {
  const rows = await many<{
    id: string; action: string; summary: string; details: Record<string, unknown>;
    created_at: DateValue; actor: string | null;
  }>(
    `SELECT a.id, a.action, a.summary, a.details, a.created_at,
            COALESCE(admin.username, business.code, a.actor_system, 'deleted-operator') AS actor
       FROM admin_audit a
       LEFT JOIN admins admin ON admin.id = a.admin_id
       LEFT JOIN business_accounts business ON business.id = a.business_id
       LEFT JOIN agency_settlements settlement
         ON a.target_type = 'agency_settlement' AND settlement.id::text = a.target_id
       LEFT JOIN agency_hosts host
         ON a.target_type = 'agency_host' AND host.id::text = a.target_id
      WHERE (a.target_type = 'agency' AND a.target_id = $1::text)
         OR (a.target_type = 'agency_settlement' AND settlement.agency_id = $1::uuid)
         OR (a.target_type = 'agency_host' AND host.agency_id = $1::uuid)
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [agencyId, Math.max(1, Math.min(limit, 100))],
  );
  return rows.map((row) => ({
    id: row.id, action: row.action, summary: row.summary, details: row.details ?? {},
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(), actor: row.actor ?? 'deleted-operator',
  }));
}
