import { many } from '../config/db';
import { redis } from '../config/redis';
import { excludeTestSql } from './qa.service';

/**
 * Live discovery rankings. These are deliberately separate from the financial podiums:
 * room/host/agency positions are based on current room health, never wallet balances or
 * commission amounts. Only public rooms with real, currently-present participants qualify.
 *
 * The region is an ISO-3166 alpha-2 tag already used by room profiles. When a room has no
 * explicit target region, the host's account country is the fallback. No GPS or location
 * history is read or stored.
 */
export type DiscoveryKind = 'rooms' | 'hosts' | 'agencies';

export type DiscoveryLeader = {
  position: number;
  id: string;
  name: string;
  avatarUrl: string | null;
  region: string | null;
  score: number;
  activeRooms: number;
  listenerCount: number;
  activeHostCount?: number;
  hostName?: string | null;
  hostAvatarUrl?: string | null;
};

type RoomActivityRow = {
  id: string;
  name: string;
  avatar_url: string | null;
  region: string | null;
  score: string | number;
  active_rooms: string | number;
  listener_count: string | number;
  host_name?: string | null;
  host_avatar_url?: string | null;
  active_host_count?: string | number;
};

const ROOM_ACTIVITY = `
  SELECT r.id, r.host_id, r.title, r.cover_url, r.region,
         COALESCE(r.region, u.country_code) AS region_code,
         u.username AS host_name, u.avatar_url AS host_avatar_url,
         COALESCE(p.present_count, 0)::int AS present_count,
         COALESCE(p.speaker_count, 0)::int AS speaker_count,
         COALESCE(g.gift_diamonds, 0)::bigint AS gift_diamonds,
         COALESCE(r.like_count, 0)::bigint AS like_count,
         (COALESCE(p.present_count, 0) * 100
           + COALESCE(p.speaker_count, 0) * 25
           + LEAST(COALESCE(g.gift_diamonds, 0), 5000) / 50
           + LEAST(COALESCE(r.like_count, 0), 1000) / 20)::bigint AS score
    FROM rooms r
    JOIN users u ON u.id = r.host_id
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT rp.user_id)::int AS present_count,
             COUNT(DISTINCT rp.user_id) FILTER (WHERE rp.role IN ('HOST', 'SPEAKER'))::int AS speaker_count
        FROM room_participants rp
       WHERE rp.room_id = r.id AND rp.left_at IS NULL
    ) p ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(t.amount_diamonds), 0)::bigint AS gift_diamonds
        FROM transactions t
       WHERE t.room_id = r.id AND t.type = 'GIFT_SENT'
         AND t.created_at >= now() - INTERVAL '24 hours'
         AND ${excludeTestSql('t', ['sender_id', 'receiver_id'])}
    ) g ON TRUE
   WHERE r.status = 'ACTIVE' AND r.type = 'PUBLIC'
     AND u.status = 'ACTIVE' AND NOT u.is_test
     AND COALESCE(p.present_count, 0) > 0
     AND ($1::varchar IS NULL OR COALESCE(r.region, u.country_code) = $1)
`;

export async function discoveryRanking(
  kind: DiscoveryKind,
  region: string | null,
  limit: number,
): Promise<{ kind: DiscoveryKind; region: string | null; leaders: DiscoveryLeader[] }> {
  // A short cache absorbs lobby refresh bursts without making the board feel stale.
  const cacheKey = `discovery:ranking:${kind}:${region ?? 'global'}:${limit}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as { kind: DiscoveryKind; region: string | null; leaders: DiscoveryLeader[] };
  } catch {
    // Cache availability must not make public discovery unavailable; fall through to PostgreSQL.
  }

  let rows: RoomActivityRow[];
  if (kind === 'rooms') {
    rows = await many<RoomActivityRow>(
      `WITH activity AS (${ROOM_ACTIVITY})
       SELECT id, title AS name, cover_url AS avatar_url, region_code AS region,
              score, 1::int AS active_rooms, present_count AS listener_count,
              host_name, host_avatar_url
         FROM activity
        ORDER BY score DESC, present_count DESC, title ASC, id ASC
        LIMIT $2`,
      [region, limit],
    );
  } else if (kind === 'hosts') {
    rows = await many<RoomActivityRow>(
      `WITH activity AS (${ROOM_ACTIVITY})
       SELECT u.id, u.username AS name, u.avatar_url,
              (SELECT mode() WITHIN GROUP (ORDER BY a.region_code)
                 FROM activity a WHERE a.host_id = u.id AND a.region_code IS NOT NULL) AS region,
              SUM(a.score)::bigint AS score,
              COUNT(DISTINCT a.id)::int AS active_rooms,
              SUM(a.present_count)::int AS listener_count
         FROM activity a
         JOIN users u ON u.id = a.host_id
        GROUP BY u.id, u.username, u.avatar_url
        ORDER BY score DESC, listener_count DESC, name ASC, u.id ASC
        LIMIT $2`,
      [region, limit],
    );
  } else {
    rows = await many<RoomActivityRow>(
      `WITH activity AS (${ROOM_ACTIVITY})
       SELECT ag.id, ag.name, ag.logo_url AS avatar_url,
              (SELECT mode() WITHIN GROUP (ORDER BY a.region_code)
                 FROM activity a
                 JOIN agency_hosts ah2 ON ah2.host_user_id = a.host_id AND ah2.status = 'ACTIVE'
                WHERE ah2.agency_id = ag.id AND a.region_code IS NOT NULL) AS region,
              (SUM(a.score) + COUNT(DISTINCT a.host_id) * 75)::bigint AS score,
              COUNT(DISTINCT a.id)::int AS active_rooms,
              SUM(a.present_count)::int AS listener_count,
              COUNT(DISTINCT a.host_id)::int AS active_host_count
         FROM activity a
         JOIN agency_hosts ah ON ah.host_user_id = a.host_id AND ah.status = 'ACTIVE'
         JOIN agencies ag ON ag.id = ah.agency_id AND ag.status = 'ACTIVE'
        GROUP BY ag.id, ag.name, ag.logo_url
        ORDER BY score DESC, listener_count DESC, name ASC, ag.id ASC
        LIMIT $2`,
      [region, limit],
    );
  }

  const result = {
    kind,
    region,
    leaders: rows.map((row, index) => ({
      position: index + 1,
      id: row.id,
      name: row.name,
      avatarUrl: row.avatar_url,
      region: row.region,
      score: Number(row.score),
      activeRooms: Number(row.active_rooms),
      listenerCount: Number(row.listener_count),
      ...(row.active_host_count === undefined ? {} : { activeHostCount: Number(row.active_host_count) }),
      ...(row.host_name === undefined ? {} : { hostName: row.host_name, hostAvatarUrl: row.host_avatar_url ?? null }),
    })),
  };
  try {
    await redis.set(cacheKey, JSON.stringify(result), 'EX', 20);
  } catch {
    // The next request can recompute; a cache write is never a ranking dependency.
  }
  return result;
}
