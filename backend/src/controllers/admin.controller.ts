import { Request, Response } from 'express';
import { one } from '../config/db';
import { THEME_SLUGS } from '../config/themes';
import { UserRow } from '../types/db';
import {
  ApiError,
  asyncHandler,
  optionalInt,
  optionalString,
  optionalEnum,
  optionalUuid,
  requireBoolean,
  requireEnum,
  requireInt,
  requireString,
} from '../utils/http';
import { toAdmin, toUser, toWithdrawal, UserDto } from '../utils/serialize';
import {
  createGift,
  dashboardStats,
  deleteGift,
  findAdminByUsername,
  getAdminWithdrawal,
  listGifts,
  listRoomsForAdmin,
  listWithdrawals,
  roomConsole,
  searchUsers,
  setUserStatus,
  setUserVipLevel,
  updateGift,
  GIFT_EFFECT_KINDS,
  GiftInput,
} from '../services/admin.service';
import { adjustBalance, reviewWithdrawal } from '../services/ledger.service';
import { pushToUser } from '../services/push.service';
import {
  SEAT_CEILING,
  SEAT_POLICY_KEY,
  appendModeratorChat,
  banFromRoom,
  closeRoom,
  disconnectFromRoom,
  fetchMiniUser,
  loadRoom,
  seatLimits,
  setAllSeatsMuted,
  setRoomTheme as applyRoomTheme,
  setSeatLock,
  setSeatMute,
  unbanFromRoom,
} from '../services/room.service';
import { writeConfig } from '../services/business.service';
import {
  broadcastMicToggle,
  broadcastRoomClosed,
  broadcastSeatUpdate,
  emitToRoom,
  emitToUser,
} from '../services/socket.service';
import { hashSecret, verifySecret } from '../utils/crypto';
import {
  DisputeDecision,
  GameRulePatch,
  listDefinitions,
  listDisputes,
  listSessionEvents,
  listSessionsForAdmin,
  reviewDispute,
  updateGameDefinition,
} from '../services/game.service';
import { AuditEntry, listAudit, recordAudit } from '../services/audit.service';
import { adminPermissions } from '../services/rbac.service';

/**
 * Every admin mutation drops one line here before it responds. The write is deliberately
 * non-fatal: the balance has already moved, and an audit outage must not tempt anyone into
 * replaying a payout. Failures are loud in the server log instead.
 */
async function logAction(req: Request, entry: Omit<AuditEntry, 'adminId'>): Promise<void> {
  try {
    await recordAudit({ adminId: req.admin?.sub ?? null, ...entry });
  } catch (err) {
    console.error('[admin] audit write failed', entry.action, err);
  }
}

export const stats = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await dashboardStats());
});

export const users = asyncHandler(async (req: Request, res: Response) => {
  const result = await searchUsers({
    search: optionalString(req.query.search, 'search', 60),
    status: optionalString(req.query.status, 'status', 10)?.toUpperCase(),
    userType: optionalString(req.query.userType, 'userType', 20)?.toUpperCase(),
    page: optionalInt(req.query.page, 'page', { min: 1 }) ?? 1,
    limit: optionalInt(req.query.limit, 'limit', { min: 1, max: 200 }) ?? 25,
  });
  res.json({
    users: result.users.map((row) => ({ ...toUser(row), agency: row.agency_name })),
    total: result.total,
    page: result.page,
    limit: result.limit,
  });
});

export const adjustUserBalance = asyncHandler(async (req: Request, res: Response) => {
  const adminId = req.admin!.sub;
  const userId = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const diamondDelta = optionalInt(req.body?.diamondDelta, 'diamondDelta', { min: -100_000_000, max: 100_000_000 }) ?? 0;
  const rCoinDelta = optionalInt(req.body?.rCoinDelta, 'rCoinDelta', { min: -1_000_000_000, max: 1_000_000_000 }) ?? 0;
  const note = optionalString(req.body?.note, 'note', 200);
  const result = await adjustBalance(userId, { diamondDelta, rCoinDelta, note }, adminId);
  await logAction(req, {
    action: 'USER_BALANCE_ADJUST',
    targetType: 'user',
    targetId: userId,
    summary: `${diamondDelta >= 0 ? '+' : ''}${diamondDelta} diamonds, ${rCoinDelta >= 0 ? '+' : ''}${rCoinDelta} R-coins${note ? ` — ${note}` : ''}`,
    details: { diamondDelta, rCoinDelta, note: note ?? null },
  });
  emitToUser(userId, 'wallet:update', {
    diamondBalance: result.user.diamondBalance,
    rCoinBalance: result.user.rCoinBalance,
  });
  res.json(result);
});

export const ban = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const banned = requireBoolean(req.body?.banned, 'banned');
  const reason = optionalString(req.body?.reason, 'reason', 200);
  const row = await setUserStatus(userId, banned);
  await logAction(req, {
    action: banned ? 'USER_BAN' : 'USER_UNBAN',
    targetType: 'user',
    targetId: userId,
    summary: reason ?? (banned ? 'Account banned' : 'Account unbanned'),
    details: { reason: reason ?? null },
  });
  emitToUser(userId, 'account:status', { status: row.status, reason: reason ?? null });
  res.json({ user: toUser(row) });
});

export const setVipLevel = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const level = requireInt(req.body?.vipLevel, 'vipLevel', { min: 0, max: 20 });
  const row = await setUserVipLevel(userId, level);
  await logAction(req, {
    action: 'USER_VIP_SET',
    targetType: 'user',
    targetId: userId,
    summary: `VIP level set to ${level}`,
    details: { vipLevel: level },
  });
  res.json({ user: toUser(row) });
});

export const rooms = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    rooms: await listRoomsForAdmin({
      status: (optionalString(req.query.status, 'status', 10)?.toUpperCase() as 'ACTIVE' | 'CLOSED') ?? 'ACTIVE',
      search: optionalString(req.query.search, 'search', 60),
    }),
  });
});

export const closeMonitoredRoom = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  const { room } = await closeRoom(id, null, { asAdmin: true });
  await logAction(req, { action: 'ROOM_CLOSE', targetType: 'room', targetId: id, summary: `Force-closed room ${room.roomNumber}` });
  broadcastRoomClosed(id);
  // A closed room has nobody seated; the panel renders the same AdminRoom shape.
  res.json({ room: { ...room, onlineSeatCount: 0, seats: [], audience: [] } });
});

export const disconnectUser = asyncHandler(async (req: Request, res: Response) => {
  const roomId = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  const userId = requireString(req.body?.userId, 'userId', { min: 36, max: 36 });
  const { seats, wasPresent } = await disconnectFromRoom(roomId, userId);
  await logAction(req, {
    action: 'ROOM_DISCONNECT_USER',
    targetType: 'room',
    targetId: roomId,
    summary: wasPresent ? 'Disconnected a member' : 'Asked to disconnect a member who was not present',
    details: { userId, wasPresent },
  });
  if (wasPresent) emitToUser(userId, 'room:kicked', { roomId, reason: 'moderation' });
  await broadcastSeatUpdate(roomId);
  res.json({ ok: true, seats });
});

// ---------------------------------------------------------------------------
// Room ops console. These mirror the host's own moderation powers, but are
// exercised by an operator: the seat actions bypass the "only the host" check,
// moderator chat is attributed to the admin account, and a ban blocks re-entry
// to that room instead of just disconnecting the guest.
// ---------------------------------------------------------------------------

export const roomDetail = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  res.json(await roomConsole(id));
});

export const sendRoomChat = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  const content = requireString(req.body?.message, 'message', { min: 1, max: 300 });
  const message = await appendModeratorChat(id, req.admin!.username, content.trim());
  await logAction(req, { action: 'ROOM_ANNOUNCE', targetType: 'room', targetId: id, summary: `Posted to room chat: ${content.trim()}` });
  emitToRoom(id, 'room:chat_message', message);
  res.json({ message });
});

export const warnHost = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  const message = requireString(req.body?.message, 'message', { min: 1, max: 300 });
  const room = await loadRoom(id);
  const host = await fetchMiniUser(room.host_id);
  // Private to the host: a warning is a nudge, not a public shaming.
  emitToUser(room.host_id, 'room:warning', {
    roomId: id,
    roomNumber: room.room_number,
    message: message.trim(),
  });
  await logAction(req, {
    action: 'ROOM_WARN_HOST',
    targetType: 'room',
    targetId: id,
    summary: `Warned the host: ${message.trim()}`,
    details: { hostId: room.host_id },
  });
  res.json({ ok: true, host });
});

export const muteAll = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  const muted = requireBoolean(req.body?.muted, 'muted');
  const { seats, affected } = await setAllSeatsMuted(id, muted);
  await logAction(req, {
    action: muted ? 'ROOM_MUTE_ALL' : 'ROOM_UNMUTE_ALL',
    targetType: 'room',
    targetId: id,
    summary: `${muted ? 'Muted' : 'Unmuted'} ${affected} seat(s)`,
  });
  await broadcastSeatUpdate(id);
  res.json({ seats, affected });
});

/**
 * The seat policy — "a default of 15 speaker seats, configurable by the administrator".
 *
 * Reading it is a room concern; changing it is a `config:manage` one, the same permission that
 * holds the commission order and the recharge window, because it decides how many microphones the
 * platform hands out. The bounds are checked here so an impossible policy is refused with a
 * message rather than silently clamped when someone creates a room.
 */
export const seatPolicy = asyncHandler(async (_req: Request, res: Response) => {
  const limits = await seatLimits();
  res.json({
    speakerSeats: limits.policy.speakerSeats,
    maxSpeakerSeats: limits.policy.maxSpeakerSeats,
    seatCapacity: { min: limits.min, default: limits.default, max: limits.max },
    ceiling: SEAT_CEILING,
  });
});

export const setSeatPolicy = asyncHandler(async (req: Request, res: Response) => {
  const speakerSeats = requireInt(req.body?.speakerSeats, 'speakerSeats', { min: 1, max: SEAT_CEILING - 1 });
  const maxSpeakerSeats = requireInt(req.body?.maxSpeakerSeats, 'maxSpeakerSeats', {
    min: speakerSeats,
    max: SEAT_CEILING - 1,
  });
  // `writeConfig` writes the SYSTEM_CONFIG_UPDATE audit line itself. Rooms keep the capacity they
  // were created with, so this moves the number for new rooms only.
  const row = await writeConfig(req.admin!.sub, SEAT_POLICY_KEY, { speakerSeats, maxSpeakerSeats });
  res.json({
    speakerSeats,
    maxSpeakerSeats,
    seatCapacity: { min: 2, default: speakerSeats + 1, max: maxSpeakerSeats + 1 },
    updatedAt: new Date(row.updated_at).toISOString(),
  });
});

export const muteSeat = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  const index = requireInt(req.params.index, 'seatIndex', { min: 0, max: (await seatLimits()).max - 1 });
  const muted = requireBoolean(req.body?.muted, 'muted');
  const { seats } = await setSeatMute(req.admin!.sub, id, index, muted, { asAdmin: true });
  const seat = seats.find((s) => s.seatIndex === index);
  broadcastMicToggle(id, index, muted, seat?.user?.id ?? null);
  await broadcastSeatUpdate(id);
  res.json({ seats });
});

export const lockSeat = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  const index = requireInt(req.params.index, 'seatIndex', { min: 0, max: (await seatLimits()).max - 1 });
  const locked = requireBoolean(req.body?.locked, 'locked');
  const { seats } = await setSeatLock(req.admin!.sub, id, index, locked, { asAdmin: true });
  await broadcastSeatUpdate(id);
  res.json({ seats });
});

/** Ops-console restyle: same validation as the host route, admin authority. */
export const setRoomTheme = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  const theme = requireEnum(req.body?.theme, 'theme', THEME_SLUGS);
  const { room } = await applyRoomTheme(id, theme, req.admin!.sub, { asAdmin: true });
  emitToRoom(id, 'room:theme_changed', { roomId: id, theme: room.theme });
  res.json({ room });
});

export const banUser = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  const userId = requireString(req.body?.userId, 'userId', { min: 36, max: 36 });
  const minutes = optionalInt(req.body?.minutes, 'minutes', { min: 1, max: 60 * 24 * 365 });
  const reason = optionalString(req.body?.reason, 'reason', 200);
  const result = await banFromRoom(id, userId, { adminId: req.admin!.sub, reason, minutes: minutes ?? null });
  await logAction(req, {
    action: 'ROOM_BAN_USER',
    targetType: 'room',
    targetId: id,
    summary: `Banned a member${minutes ? ` for ${minutes} min` : ' permanently'}${reason ? ` — ${reason}` : ''}`,
    details: { userId, minutes: minutes ?? null, reason: reason ?? null },
  });
  emitToUser(userId, 'room:kicked', { roomId: id, reason: 'banned' });
  await broadcastSeatUpdate(id);
  res.json({ ok: true, seats: result.seats, wasPresent: result.wasPresent, expiresAt: result.expiresAt });
});

export const liftBan = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'roomId', { min: 36, max: 36 });
  const userId = requireString(req.params.userId, 'userId', { min: 36, max: 36 });
  const result = await unbanFromRoom(id, userId);
  await logAction(req, { action: 'ROOM_UNBAN_USER', targetType: 'room', targetId: id, summary: 'Lifted a room ban', details: { userId } });
  res.json(result);
});

export const gifts = asyncHandler(async (_req: Request, res: Response) => {
  res.json({ gifts: await listGifts({ includeInactive: true }) });
});

// In partial mode only the keys the client actually sent may survive: updateGift
// writes every key present in the object, so filling defaults here turned an
// enable/disable toggle into UPDATE gifts SET name='', icon_url='', diamond_price=0.
function parseGiftInput(body: Record<string, unknown>, partial: false): GiftInput;
function parseGiftInput(body: Record<string, unknown>, partial: true): Partial<GiftInput>;
function parseGiftInput(body: Record<string, unknown>, partial: boolean): Partial<GiftInput> {
  const pick = <T,>(key: string, read: (raw: unknown) => T, fallback: T): T | undefined =>
    body[key] === undefined ? (partial ? undefined : fallback) : read(body[key]);

  if (!partial && body.name === undefined) throw ApiError.badRequest('name is required');
  const input: Partial<GiftInput> = {
    name: pick('name', (raw) => requireString(raw, 'name', { max: 40 }), ''),
    iconUrl: pick('iconUrl', (raw) => requireString(raw, 'iconUrl', { max: 500 }), ''),
    animationUrl: pick('animationUrl', (raw) => optionalString(raw, 'animationUrl', 500) ?? null, null),
    soundUrl: pick('soundUrl', (raw) => optionalString(raw, 'soundUrl', 500) ?? null, null),
    diamondPrice: pick('diamondPrice', (raw) => requireInt(raw, 'diamondPrice', { min: 1, max: 10_000_000 }), 0),
    rCoinValue: pick('rCoinValue', (raw) => requireInt(raw, 'rCoinValue', { min: 0, max: 10_000_000 }), 0),
    category: pick('category', (raw) => requireString(raw, 'category', { max: 24 }), 'SPECIAL'),
    minVipLevel: pick('minVipLevel', (raw) => requireInt(raw, 'minVipLevel', { min: 0, max: 999 }), 0),
    sortOrder: pick('sortOrder', (raw) => requireInt(raw, 'sortOrder', { min: -9999, max: 9999 }), 0),
    effectKind: pick('effectKind', (raw) => requireEnum(raw, 'effectKind', GIFT_EFFECT_KINDS), 'TICKER'),
    isActive: pick('isActive', (raw) => requireBoolean(raw, 'isActive'), true),
  };
  return input;
}

export const createGiftEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const input = parseGiftInput(req.body ?? {}, false);
  if (!input.name || !input.iconUrl || input.diamondPrice < 1) {
    throw ApiError.badRequest('name, iconUrl and a positive diamondPrice are required');
  }
  const gift = await createGift(input);
  await logAction(req, {
    action: 'GIFT_CREATE',
    targetType: 'gift',
    targetId: gift.id,
    summary: `Added gift ${gift.name} at ${gift.diamondPrice} diamonds`,
    details: { gift },
  });
  res.status(201).json({ gift });
});

export const updateGiftEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'giftId', { min: 36, max: 36 });
  const input = parseGiftInput(req.body ?? {}, true);
  const gift = await updateGift(id, input);
  await logAction(req, {
    action: 'GIFT_UPDATE',
    targetType: 'gift',
    targetId: id,
    summary: `Updated gift ${gift.name}`,
    details: { changes: input },
  });
  res.json({ gift });
});

export const removeGiftEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'giftId', { min: 36, max: 36 });
  const result = await deleteGift(id);
  await logAction(req, { action: 'GIFT_DELETE', targetType: 'gift', targetId: id, summary: 'Removed a gift from the catalogue', details: result });
  res.json(result);
});

export const withdrawals = asyncHandler(async (req: Request, res: Response) => {
  res.json(await listWithdrawals(optionalString(req.query.status, 'status', 12)?.toUpperCase()));
});

export const reviewWithdrawalEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'withdrawalId', { min: 36, max: 36 });
  const approve = requireBoolean(req.body?.approve, 'approve');
  const note = optionalString(req.body?.note, 'note', 200);
  const withdrawal = await reviewWithdrawal(id, approve, req.admin!.sub, note);
  await logAction(req, {
    action: 'WITHDRAWAL_REVIEW',
    targetType: 'withdrawal',
    targetId: id,
    summary: `${approve ? 'Approved' : 'Rejected'} a ${withdrawal.amount_r_coins} R-coin withdrawal${note ? ` — ${note}` : ''}`,
    details: { approve, note: note ?? null, userId: withdrawal.user_id },
  });
  const holder = await one<UserRow>('SELECT * FROM users WHERE id = $1', [withdrawal.user_id]);
  if (holder) {
    const user: UserDto = toUser(holder);
    emitToUser(user.id, 'withdrawal:update', { id: withdrawal.id, status: withdrawal.status, rCoinBalance: user.rCoinBalance });
    // The decision happens in the panel, hours after the host filed it, so the
    // socket event alone is unlikely to reach them.
    void pushToUser(user.id, {
      title: withdrawal.status === 'APPROVED' ? 'Withdrawal approved' : 'Withdrawal rejected',
      body: withdrawal.status === 'APPROVED'
        ? `${withdrawal.amount_r_coins} R-coins released for payout.`
        : `${withdrawal.amount_r_coins} R-coins were returned to your balance.`,
      data: { type: 'withdrawal', status: withdrawal.status },
    });
  }
  res.json({ withdrawal: (await getAdminWithdrawal(withdrawal.id)) ?? toWithdrawal(withdrawal) });
});

/** Rotate the operator password from inside the panel. */
export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const current = requireString(req.body?.currentPassword, 'currentPassword', { max: 200 });
  const next = requireString(req.body?.newPassword, 'newPassword', { min: 8, max: 200 });
  const admin = await findAdminByUsername(req.admin!.username);
  if (!admin || !verifySecret(current, admin.password_hash)) {
    throw ApiError.unauthorized('Current password is wrong');
  }
  await one('UPDATE admins SET password_hash = $2 WHERE id = $1', [admin.id, hashSecret(next)]);
  await logAction(req, {
    action: 'ADMIN_PASSWORD_CHANGE',
    targetType: 'admin',
    targetId: admin.id,
    summary: 'Operator rotated their own password',
  });
  res.json({ ok: true });
});

export const whoami = asyncHandler(async (req: Request, res: Response) => {
  const admin = await findAdminByUsername(req.admin!.username);
  if (!admin) throw ApiError.notFound('Operator not found');
  res.json({
    admin: toAdmin(admin),
    // Advice for the panel's navigation only. Every route still re-reads the role from the
    // table and checks its own permission; hiding a button is not how access is enforced.
    permissions: adminPermissions(admin.role),
  });
});

// ---------------------------------------------------------------------------
// Games: catalogue, versioned rules, match review, disputes, audit trail.
// ---------------------------------------------------------------------------

/** A console list of both halves of the game domain: what can be played, and what was. */
export const games = asyncHandler(async (req: Request, res: Response) => {
  const limit = requireInt(req.query?.limit ?? 25, 'limit', { min: 1, max: 200 });
  res.json({
    games: await listDefinitions({ activeOnly: false }),
    sessions: await listSessionsForAdmin({
      gameKey: optionalString(req.query?.gameKey, 'gameKey', 32),
      status: optionalString(req.query?.status, 'status', 16),
      limit,
    }),
  });
});

/** The replay. A ruling on a match without the event log is a ruling on a guess. */
export const gameEventLog = asyncHandler(async (req: Request, res: Response) => {
  const sessionId = requireString(req.params.id, 'id', { min: 36, max: 36 });
  res.json({ events: await listSessionEvents(sessionId, requireInt(req.query?.limit ?? 200, 'limit', { min: 1, max: 1_000 })) });
});

function prizeRulesFrom(raw: unknown): Array<{ rank: number; shareBps: number }> {
  if (!Array.isArray(raw)) throw ApiError.badRequest('prizeRules must be an array of {rank, shareBps}');
  return raw.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return { rank: requireInt(record.rank, 'prizeRules[].rank', { min: 1, max: 8 }), shareBps: requireInt(record.shareBps, 'prizeRules[].shareBps', { min: 0, max: 10_000 }) };
  });
}

/**
 * Edit a game's rules.
 *
 * Switching paid entry or redeemable prizes on is the one action in this panel that turns
 * a casual game into a regulated product, so it asks for an explicit acknowledgement rather
 * than a checkbox that defaults to yes. Everything else the operator changes here is
 * versioned and audited by the service.
 */
export const setGameRules = asyncHandler(async (req: Request, res: Response) => {
  const key = requireString(req.params.key, 'key', { max: 32 });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: GameRulePatch = {};

  if (body.isActive !== undefined) patch.isActive = requireBoolean(body.isActive, 'isActive');
  if (body.entryFeeEnabled !== undefined) patch.entryFeeEnabled = requireBoolean(body.entryFeeEnabled, 'entryFeeEnabled');
  if (body.entryFeeDiamonds !== undefined) patch.entryFeeDiamonds = requireInt(body.entryFeeDiamonds, 'entryFeeDiamonds', { min: 0, max: 1_000_000 });
  if (body.entryFeeMin !== undefined) patch.entryFeeMin = requireInt(body.entryFeeMin, 'entryFeeMin', { min: 0, max: 100_000 });
  if (body.entryFeeMax !== undefined) patch.entryFeeMax = requireInt(body.entryFeeMax, 'entryFeeMax', { min: 0, max: 100_000 });
  if (body.prizeEnabled !== undefined) patch.prizeEnabled = requireBoolean(body.prizeEnabled, 'prizeEnabled');
  if (body.commissionBps !== undefined) patch.commissionBps = requireInt(body.commissionBps, 'commissionBps', { min: 0, max: 5_000 });
  if (body.turnTimeoutSeconds !== undefined) patch.turnTimeoutSeconds = requireInt(body.turnTimeoutSeconds, 'turnTimeoutSeconds', { min: 5, max: 300 });
  if (body.maxPlayers !== undefined) patch.maxPlayers = requireInt(body.maxPlayers, 'maxPlayers', { min: 1, max: 8 });
  if (body.dailyEntryLimit !== undefined) patch.dailyEntryLimit = requireInt(body.dailyEntryLimit, 'dailyEntryLimit', { min: 0, max: 10_000 });
  if (body.promoFreeEntry !== undefined) patch.promoFreeEntry = requireBoolean(body.promoFreeEntry, 'promoFreeEntry');
  if (body.promoUntil !== undefined) patch.promoUntil = body.promoUntil === null ? null : requireString(body.promoUntil, 'promoUntil', { max: 40 });
  if (body.refundPolicy !== undefined) {
    patch.refundPolicy = requireEnum(body.refundPolicy, 'refundPolicy', ['NONE', 'CANCELLED', 'DISPUTED', 'ALWAYS'] as const);
  }
  if (body.prizeRules !== undefined) patch.prizeRules = prizeRulesFrom(body.prizeRules);

  // Raising the ceiling is itself the regulated step: with 0..0 every game is free to play by
  // construction, so paid entry only exists after somebody with `game:manage` says so out loud.
  const raisesTheCeiling = patch.entryFeeMax !== undefined && patch.entryFeeMax > (patch.entryFeeMin ?? 0);
  const turnsMoneyOn = patch.entryFeeEnabled === true || patch.prizeEnabled === true || raisesTheCeiling;
  if (turnsMoneyOn && body.confirmCompliance !== true) {
    throw ApiError.forbidden(
      'Paid entry and redeemable prizes need a completed compliance review for the target market. Send confirmCompliance: true to record that decision.',
      'compliance_unconfirmed',
    );
  }

  const result = await updateGameDefinition(req.admin!.sub, key, patch);
  res.json({ game: result.definition, rulesChanged: result.rulesChanged });
});

export const disputes = asyncHandler(async (req: Request, res: Response) => {
  res.json({ disputes: await listDisputes({ status: optionalString(req.query?.status, 'status', 16), limit: requireInt(req.query?.limit ?? 50, 'limit', { min: 1, max: 200 }) }) });
});

export const reviewGameDispute = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'id', { min: 36, max: 36 });
  const decision = requireEnum(req.body?.decision, 'decision', ['UPHELD', 'REJECTED', 'REFUNDED'] as const) as DisputeDecision;
  const resolution = requireString(req.body?.resolution, 'resolution', { max: 500 });
  res.json({ dispute: await reviewDispute(req.admin!.sub, id, decision, resolution) });
});

/** Who changed what in this panel. */
export const audit = asyncHandler(async (req: Request, res: Response) => {
  res.json({
    entries: await listAudit({
      limit: requireInt(req.query?.limit ?? 100, 'limit', { min: 1, max: 500 }),
      targetType: optionalString(req.query?.targetType, 'targetType', 32),
      // A partner's own trail: who opened what, who claimed it was paid.
      businessId: optionalUuid(req.query?.businessId, 'businessId'),
      adminId: optionalUuid(req.query?.adminId, 'adminId'),
      actorKind: optionalEnum(req.query?.actorKind, 'actorKind', ['admin', 'business', 'system'] as const),
    }),
  });
});
