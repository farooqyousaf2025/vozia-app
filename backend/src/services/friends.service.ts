import { many, one, query } from '../config/db';
import { ApiError } from '../utils/http';
import { MiniUser, toMiniUser } from '../utils/serialize';

export const FRIEND_REQUEST_STATUSES = ['PENDING', 'ACCEPTED', 'DECLINED'] as const;
export type FriendRequestStatus = (typeof FRIEND_REQUEST_STATUSES)[number];

export const MAX_FRIEND_MESSAGE = 2000;
export const MAX_REQUESTS_PER_PAIR = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUserId(value: unknown, field = 'userId'): string {
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
    throw ApiError.badRequest(`${field} must be a UUID`, 'invalid_uuid');
  }
  return value.trim();
}

export function normalizeMessageContent(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('content must be a string', 'invalid_content');
  const text = value.trim();
  if (!text) throw ApiError.badRequest('content must not be empty', 'empty_content');
  if (text.length > MAX_FRIEND_MESSAGE) {
    throw ApiError.badRequest(`content must be ${MAX_FRIEND_MESSAGE} characters or fewer`, 'content_too_long');
  }
  return text;
}

function canonical(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

async function userExists(userId: string): Promise<{ id: string; status: string }> {
  const row = await one<{ id: string; status: string }>('SELECT id, status FROM users WHERE id = $1', [userId]);
  if (!row) throw ApiError.notFound('User not found', 'user_not_found');
  return row;
}

export type FriendRequestRow = {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: FriendRequestStatus;
  created_at: Date;
  responded_at: Date | null;
  requester_username?: string;
  requester_avatar_url?: string | null;
  addressee_username?: string;
  addressee_avatar_url?: string | null;
};

export type FriendRequestDto = {
  id: string;
  status: FriendRequestStatus;
  createdAt: string;
  respondedAt: string | null;
  requester: MiniUser;
  addressee: MiniUser;
};

export function toFriendRequest(row: FriendRequestRow): FriendRequestDto {
  return {
    id: row.id,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
    requester: toMiniUser({
      id: row.requester_id,
      username: row.requester_username ?? 'unknown',
      avatar_url: row.requester_avatar_url ?? null,
    }),
    addressee: toMiniUser({
      id: row.addressee_id,
      username: row.addressee_username ?? 'unknown',
      avatar_url: row.addressee_avatar_url ?? null,
    }),
  };
}

const REQUEST_WITH_PARTIES = `
  SELECT r.*, rq.username AS requester_username, rq.avatar_url AS requester_avatar_url,
         ad.username AS addressee_username, ad.avatar_url AS addressee_avatar_url
    FROM friend_requests r
    JOIN users rq ON rq.id = r.requester_id
    JOIN users ad ON ad.id = r.addressee_id`;

export async function sendFriendRequest(requesterId: string, addresseeId: string): Promise<FriendRequestDto> {
  if (requesterId === addresseeId) throw ApiError.badRequest('You cannot friend yourself', 'self_friend');
  const target = await userExists(addresseeId);
  if (target.status === 'BANNED') throw ApiError.notFound('User not found', 'user_not_found');

  // Do-not-contact flag set by the addressee wins over everything.
  const blocked = await one<{ id: string }>(
    'SELECT 1 AS id FROM friend_contact_blocks WHERE blocker_id = $1 AND blocked_id = $2',
    [addresseeId, requesterId],
  );
  if (blocked) throw ApiError.forbidden('This member has asked not to be contacted', 'do_not_contact');

  const [a, b] = canonical(requesterId, addresseeId);
  const alreadyFriends = await one<{ id: string }>(
    'SELECT 1 AS id FROM friendships WHERE user_a_id = $1 AND user_b_id = $2',
    [a, b],
  );
  if (alreadyFriends) throw ApiError.conflict('You are already friends', 'already_friends');

  const pending = await one<{ id: string }>(
    `SELECT id FROM friend_requests WHERE requester_id = $1 AND addressee_id = $2 AND status = 'PENDING'`,
    [requesterId, addresseeId],
  );
  if (pending) throw ApiError.conflict('A friend request is already pending', 'request_pending');

  const countRow = await one<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM friend_requests WHERE requester_id = $1 AND addressee_id = $2',
    [requesterId, addresseeId],
  );
  if (Number(countRow?.n ?? 0) >= MAX_REQUESTS_PER_PAIR) {
    throw ApiError.forbidden('You have reached the request limit for this member', 'friend_request_cap_reached');
  }

  const inserted = await one<{ id: string }>(
    `INSERT INTO friend_requests (requester_id, addressee_id) VALUES ($1, $2) RETURNING id`,
    [requesterId, addresseeId],
  );
  const row = await one<FriendRequestRow>(`${REQUEST_WITH_PARTIES} WHERE r.id = $1`, [inserted!.id]);
  return toFriendRequest(row!);
}

export async function listFriendRequests(
  userId: string,
  direction: 'incoming' | 'outgoing',
  page: number,
  limit: number,
): Promise<{ requests: FriendRequestDto[]; total: number; page: number; limit: number }> {
  const where =
    direction === 'incoming'
      ? 'WHERE r.addressee_id = $1 AND r.status = \'PENDING\''
      : 'WHERE r.requester_id = $1 AND r.status = \'PENDING\'';
  const rows = await many<FriendRequestRow>(
    `${REQUEST_WITH_PARTIES} ${where} ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, (page - 1) * limit],
  );
  const total = await one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM friend_requests r ${where}`,
    [userId],
  );
  return {
    requests: rows.map(toFriendRequest),
    total: Number(total?.n ?? 0),
    page,
    limit,
  };
}

export async function acceptFriendRequest(requestId: string, actorId: string): Promise<{ request: FriendRequestDto; friends: true }> {
  const req = await one<FriendRequestRow>(`${REQUEST_WITH_PARTIES} WHERE r.id = $1`, [requestId]);
  if (!req) throw ApiError.notFound('Friend request not found', 'friend_request_not_found');
  if (req.addressee_id !== actorId) throw ApiError.forbidden('Not your request to accept', 'not_request_addressee');
  if (req.status !== 'PENDING') throw ApiError.conflict('This request is no longer pending', 'request_not_pending');

  await query(
    `UPDATE friend_requests SET status = 'ACCEPTED', responded_at = now() WHERE id = $1`,
    [requestId],
  );

  const [a, b] = canonical(req.requester_id, req.addressee_id);
  await query(
    `INSERT INTO friendships (user_a_id, user_b_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [a, b],
  );

  const updated = await one<FriendRequestRow>(`${REQUEST_WITH_PARTIES} WHERE r.id = $1`, [requestId]);
  return { request: toFriendRequest(updated!), friends: true };
}

export async function declineFriendRequest(requestId: string, actorId: string): Promise<{ request: FriendRequestDto; friends: false }> {
  const req = await one<FriendRequestRow>(`${REQUEST_WITH_PARTIES} WHERE r.id = $1`, [requestId]);
  if (!req) throw ApiError.notFound('Friend request not found', 'friend_request_not_found');
  if (req.addressee_id !== actorId) throw ApiError.forbidden('Not your request to decline', 'not_request_addressee');
  if (req.status !== 'PENDING') throw ApiError.conflict('This request is no longer pending', 'request_not_pending');

  await query(
    `UPDATE friend_requests SET status = 'DECLINED', responded_at = now() WHERE id = $1`,
    [requestId],
  );

  const updated = await one<FriendRequestRow>(`${REQUEST_WITH_PARTIES} WHERE r.id = $1`, [requestId]);
  return { request: toFriendRequest(updated!), friends: false };
}

export async function listFriends(
  userId: string,
  page: number,
  limit: number,
): Promise<{ friends: MiniUser[]; total: number; page: number; limit: number }> {
  const rows = await many<{
    id: string;
    username: string;
    avatar_url: string | null;
    vip_level: number;
    xp: string | number;
    profile_frame_key: string | null;
    profile_frame_expires_at: Date | null;
    created_at: Date;
  }>(
    `SELECT u.id, u.username, u.avatar_url, u.vip_level, u.xp,
            u.profile_frame_key, u.profile_frame_expires_at, f.created_at
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user_a_id = $1 THEN f.user_b_id ELSE f.user_a_id END
      WHERE (f.user_a_id = $1 OR f.user_b_id = $1) AND u.status = 'ACTIVE'
      ORDER BY f.created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, (page - 1) * limit],
  );
  const total = await one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM friendships WHERE user_a_id = $1 OR user_b_id = $1`,
    [userId],
  );
  return {
    friends: rows.map(toMiniUser),
    total: Number(total?.n ?? 0),
    page,
    limit,
  };
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  const [x, y] = canonical(a, b);
  const row = await one<{ id: string }>('SELECT 1 AS id FROM friendships WHERE user_a_id = $1 AND user_b_id = $2', [x, y]);
  return Boolean(row);
}

export async function unfriend(actorId: string, targetId: string): Promise<{ friends: false }> {
  if (actorId === targetId) throw ApiError.badRequest('You cannot unfriend yourself', 'self_friend');
  const [a, b] = canonical(actorId, targetId);
  await query('DELETE FROM friendships WHERE user_a_id = $1 AND user_b_id = $2', [a, b]);
  return { friends: false };
}

export async function setDoNotContact(blockerId: string, blockedId: string, value: boolean): Promise<{ doNotContact: boolean }> {
  if (blockerId === blockedId) throw ApiError.badRequest('You cannot block yourself', 'self_block');
  if (value) {
    await query(
      `INSERT INTO friend_contact_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [blockerId, blockedId],
    );
  } else {
    await query('DELETE FROM friend_contact_blocks WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId]);
  }
  return { doNotContact: value };
}

export type ConversationRow = {
  id: string;
  user_a_id: string;
  user_b_id: string;
  created_at: Date;
  last_message_at: Date | null;
};

export type ConversationDto = {
  id: string;
  partner: MiniUser;
  lastMessageAt: string | null;
  unreadCount: number;
};

export async function getOrCreateConversation(a: string, b: string): Promise<ConversationRow> {
  const [x, y] = canonical(a, b);
  const existing = await one<ConversationRow>(
    'SELECT * FROM conversations WHERE user_a_id = $1 AND user_b_id = $2',
    [x, y],
  );
  if (existing) return existing;
  const inserted = await one<ConversationRow>(
    `INSERT INTO conversations (user_a_id, user_b_id) VALUES ($1, $2)
     ON CONFLICT (user_a_id, user_b_id) DO NOTHING RETURNING *`,
    [x, y],
  );
  if (inserted) return inserted;
  const again = await one<ConversationRow>(
    'SELECT * FROM conversations WHERE user_a_id = $1 AND user_b_id = $2',
    [x, y],
  );
  return again!;
}

export async function listConversations(userId: string): Promise<ConversationDto[]> {
  const rows = await many<ConversationRow & { partner_id: string; partner_username: string; partner_avatar_url: string | null; partner_vip_level: number; partner_xp: string | number }>(
    `SELECT c.*,
            CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END AS partner_id,
            u.username AS partner_username, u.avatar_url AS partner_avatar_url,
            u.vip_level AS partner_vip_level, u.xp AS partner_xp
       FROM conversations c
       JOIN users u ON u.id = (CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END)
      WHERE c.user_a_id = $1 OR c.user_b_id = $1
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    [userId],
  );

  const out: ConversationDto[] = [];
  for (const row of rows) {
    const unread = await one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM direct_messages m
        WHERE m.conversation_id = $1 AND m.sender_id <> $2 AND m.read_at IS NULL`,
      [row.id, userId],
    );
    out.push({
      id: row.id,
      partner: toMiniUser({
        id: row.partner_id,
        username: row.partner_username,
        avatar_url: row.partner_avatar_url,
        vip_level: row.partner_vip_level,
        xp: row.partner_xp,
      }),
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      unreadCount: Number(unread?.n ?? 0),
    });
  }
  return out;
}

// Aliases for contract-test / client naming variants.
export const FRIEND_STATUSES = FRIEND_REQUEST_STATUSES;
export const MAX_MESSAGE_LENGTH = MAX_FRIEND_MESSAGE;
export const MAX_REQUESTS = MAX_REQUESTS_PER_PAIR;

export type DirectMessageDto = {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: string;
  readAt: string | null;
};

export function toDirectMessage(row: {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: Date;
  read_at: Date | null;
}): DirectMessageDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
  };
}

export async function listMessages(
  userId: string,
  partnerId: string,
  page: number,
  limit: number,
): Promise<{ messages: DirectMessageDto[]; total: number; page: number; limit: number }> {
  if (!(await areFriends(userId, partnerId))) {
    throw ApiError.forbidden('You can only message friends', 'not_friends');
  }
  const conv = await getOrCreateConversation(userId, partnerId);
  const rows = await many<{
    id: string;
    conversation_id: string;
    sender_id: string;
    content: string;
    created_at: Date;
    read_at: Date | null;
  }>(
    `SELECT id, conversation_id, sender_id, content, created_at, read_at
       FROM direct_messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [conv.id, limit, (page - 1) * limit],
  );
  const total = await one<{ n: string }>(
    'SELECT COUNT(*) AS n FROM direct_messages WHERE conversation_id = $1',
    [conv.id],
  );
  return {
    messages: rows.map(toDirectMessage).reverse(),
    total: Number(total?.n ?? 0),
    page,
    limit,
  };
}

export async function sendMessage(userId: string, partnerId: string, content: unknown): Promise<DirectMessageDto> {
  if (!(await areFriends(userId, partnerId))) {
    throw ApiError.forbidden('You can only message friends', 'not_friends');
  }
  // Block check symmetric.
  const blocked = await one<{ id: string }>(
    `SELECT 1 AS id FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [userId, partnerId],
  );
  if (blocked) throw ApiError.forbidden('You cannot message this member', 'interaction_blocked');

  const text = normalizeMessageContent(content);
  const conv = await getOrCreateConversation(userId, partnerId);
  const inserted = await one<{
    id: string;
    conversation_id: string;
    sender_id: string;
    content: string;
    created_at: Date;
    read_at: Date | null;
  }>(
    `INSERT INTO direct_messages (conversation_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *`,
    [conv.id, userId, text],
  );
  await query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conv.id]);
  return toDirectMessage(inserted!);
}

export async function markRead(userId: string, partnerId: string): Promise<{ read: true }> {
  if (!(await areFriends(userId, partnerId))) {
    throw ApiError.forbidden('You can only message friends', 'not_friends');
  }
  const conv = await getOrCreateConversation(userId, partnerId);
  await query(
    `UPDATE direct_messages SET read_at = now()
      WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL`,
    [conv.id, userId],
  );
  return { read: true };
}