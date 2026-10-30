import { Request, Response } from 'express';
import { one } from '../config/db';
import {
  createEffect,
  createFrame,
  createTheme,
  deleteEffect,
  deleteFrame,
  deleteTheme,
  listAdminCatalogue,
  setCategoryEffect,
  themeSlugs,
  updateEffect,
  updateFrame,
  updateTheme,
} from '../services/theme.service';
import {
  createEmoji,
  deleteEmoji,
  listAdminEmoji,
  updateEmoji,
} from '../services/emoji.service';
import {
  MAX_LEVEL,
  createRank,
  deleteRank,
  listAdminRanks,
  updateRank,
} from '../services/rank.service';
import {
  createQuest,
  deleteQuest,
  listAdminQuests,
  updateQuest,
  updateQuestSettings,
} from '../services/quest.service';
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
  adjustUserXp,
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
import {
  MEDIA_KINDS,
  MediaKind,
  decodeUploadPayload,
  deleteUpload,
  listUploads,
  saveUpload,
} from '../services/media.service';
import { pushToUser } from '../services/push.service';
import { grantItem, holdersOf, readItemKey, readKind } from '../services/store.service';
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
  const theme = requireEnum(req.body?.theme, 'theme', themeSlugs());
  const { room } = await applyRoomTheme(id, theme, req.admin!.sub, { asAdmin: true });
  emitToRoom(id, 'room:theme_changed', { roomId: id, theme: room.theme, wallpaper: room.themeWallpaper });
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

// --- Uploaded media -------------------------------------------------------
//
// The gift catalogue above is only usable if an operator can put art *into* it, so these
// routes are the other half of "add and remove gifts from the panel". They sit behind their own
// permission rather than `gift:manage` because the same store holds room effects and rank
// badges, and whoever maintains those should not thereby gain the right to price a gift.

export const uploads = asyncHandler(async (req: Request, res: Response) => {
  const kind = optionalEnum(req.query.kind, 'kind', MEDIA_KINDS) as MediaKind | undefined;
  const limit = optionalInt(req.query.limit, 'limit', { min: 1, max: 200 }) ?? 50;
  const offset = optionalInt(req.query.offset, 'offset', { min: 0, max: 100_000 }) ?? 0;
  res.json(await listUploads({ kind, limit, offset }));
});

export const createUploadEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = requireEnum(body.kind, 'kind', MEDIA_KINDS) as MediaKind;
  const fileName = requireString(body.fileName, 'fileName', { max: 120 });
  const buffer = decodeUploadPayload(body.data);

  const { asset, duplicate } = await saveUpload({ kind, fileName, buffer, adminId: req.admin?.sub ?? null });
  if (!duplicate) {
    await logAction(req, {
      action: 'MEDIA_UPLOAD',
      targetType: 'media',
      targetId: asset.id,
      summary: `Uploaded ${kind.toLowerCase()} ${fileName} (${Math.round(asset.byteSize / 1024)} KB)`,
      details: { asset },
    });
  }
  // Re-uploading identical bytes returns the row that already points at them, with a 200 so the
  // panel can say "already there" instead of implying a second file was written.
  res.status(duplicate ? 200 : 201).json({ asset, duplicate });
});

export const removeUploadEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const id = requireString(req.params.id, 'assetId', { min: 36, max: 36 });
  const existing = await one<{ file_name: string; kind: string; url: string }>(
    'SELECT file_name, kind, url FROM media_assets WHERE id = $1',
    [id],
  );
  const result = await deleteUpload(id);
  await logAction(req, {
    action: 'MEDIA_DELETE',
    targetType: 'media',
    targetId: id,
    summary: `Deleted uploaded ${existing?.kind.toLowerCase() ?? 'media'} ${existing?.file_name ?? ''}`.trim(),
    details: { ...result, fileName: existing?.file_name ?? null, url: existing?.url ?? null },
  });
  res.json(result);
});

// --- Room decoration ------------------------------------------------------
//
// Themes, Lottie loops and the category→loop mapping, which migration 0015 moved out of
// `public/themes/manifest.json` and into rows. `config:manage` rather than `room:moderate`:
// these rows decide what every room on the platform looks like, which is the same order of
// consequence as the seat policy. An edit lands on the next room DTO — a room already open keeps
// the loop it was handed when it started.

export const decorCatalogue = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await listAdminCatalogue());
});

/** Path parameter identities: a slug or a key, validated before it reaches a WHERE clause. */
function requireIdentity(raw: unknown, field: string): string {
  const value = requireString(raw, field, { min: 2, max: 39 });
  if (!/^[a-z0-9][a-z0-9-]{1,38}$/.test(value)) {
    throw ApiError.badRequest(`${field} must be lower-case letters, digits and hyphens`, `${field}_invalid`);
  }
  return value;
}

/** A rung number from the path: `0` to `20`, nothing else, and the refusal says so. */
function requireRankLevel(raw: unknown): number {
  const text = requireString(raw, 'level', { min: 1, max: 12 });
  const rung = /^\d+$/.test(text) ? Number(text) : -1;
  if (rung < 0 || rung > MAX_LEVEL) {
    throw ApiError.badRequest(`level must be a whole rung between 0 and ${MAX_LEVEL}`, 'rank_level_invalid');
  }
  return rung;
}

export const createThemeEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const theme = await createTheme(req.body ?? {});
  await logAction(req, {
    action: 'THEME_CREATE',
    targetType: 'theme',
    targetId: theme.slug,
    summary: `Added room theme ${theme.name} (${theme.slug})`,
    details: { theme },
  });
  res.status(201).json({ theme });
});

export const updateThemeEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const slug = requireIdentity(req.params.slug, 'slug');
  const theme = await updateTheme(slug, req.body ?? {});
  await logAction(req, {
    action: 'THEME_UPDATE',
    targetType: 'theme',
    targetId: slug,
    summary: `Updated room theme ${theme.name}${theme.isDefault ? ' (now the default)' : ''}`,
    details: { changes: req.body ?? {}, theme },
  });
  res.json({ theme });
});

export const deleteThemeEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const slug = requireIdentity(req.params.slug, 'slug');
  const result = await deleteTheme(slug);
  await logAction(req, {
    action: 'THEME_DELETE',
    targetType: 'theme',
    targetId: slug,
    summary: `Removed room theme ${slug}; ${result.roomsLeftOnDefault} room(s) now render the default`,
    details: result,
  });
  res.json(result);
});

export const createEffectEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const effect = await createEffect(req.body ?? {});
  await logAction(req, {
    action: 'EFFECT_CREATE',
    targetType: 'effect',
    targetId: effect.key,
    summary: `Added ${effect.kind.toLowerCase()} effect ${effect.name} (${effect.key})`,
    details: { effect },
  });
  res.status(201).json({ effect });
});

export const updateEffectEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const key = requireIdentity(req.params.key, 'key');
  const effect = await updateEffect(key, req.body ?? {});
  await logAction(req, {
    action: 'EFFECT_UPDATE',
    targetType: 'effect',
    targetId: key,
    summary: `Updated effect ${effect.name}`,
    details: { changes: req.body ?? {}, effect },
  });
  res.json({ effect });
});

export const deleteEffectEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const key = requireIdentity(req.params.key, 'key');
  const result = await deleteEffect(key);
  await logAction(req, {
    action: 'EFFECT_DELETE',
    targetType: 'effect',
    targetId: key,
    summary: `Removed effect ${key}`,
    details: result,
  });
  res.json(result);
});

export const mapCategoryEffect = asyncHandler(async (req: Request, res: Response) => {
  // A category is an enum label (PARTY, MUSIC, …), so it is validated against the schema by the
  // service rather than against the lower-case slug pattern an effect key has to satisfy.
  const category = requireString(req.params.category, 'category', { max: 24 });
  const effectKey = requireIdentity(req.body?.effectKey, 'effectKey');
  const mapping = await setCategoryEffect(category, effectKey);
  await logAction(req, {
    action: 'EFFECT_CATEGORY_MAP',
    targetType: 'effect',
    targetId: effectKey,
    summary: `Rooms of category ${category} now play ${mapping.name ?? effectKey}`,
    details: { category, effectKey },
  });
  res.json({ mapping });
});

// --- Avatar frames and store grants (migration 0019) ----------------------
//
// A ring is the one catalogue whose rows are both sold and worn by a member. Pricing it is the
// same `config:manage` power that owns every other catalogue, while handing one to an account
// without money moving is a wallet-shaped act and asks for `user:wallet`. The published
// catalogue lives in `GET /admin/decor`, beside the themes and loops.

export const createFrameEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const frame = await createFrame(req.body ?? {});
  await logAction(req, {
    action: 'FRAME_CREATE',
    targetType: 'frame',
    targetId: frame.key,
    summary: frame.forSale
      ? `Added avatar frame ${frame.name} (${frame.key}) at ${frame.priceDiamonds} diamonds`
      : `Added avatar frame ${frame.name} (${frame.key}), not for sale`,
    details: { frame },
  });
  res.status(201).json({ frame });
});

export const updateFrameEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const key = requireIdentity(req.params.key, 'key');
  const frame = await updateFrame(key, req.body ?? {});
  await logAction(req, {
    action: 'FRAME_UPDATE',
    targetType: 'frame',
    targetId: key,
    summary: frame.forSale
      ? `Updated avatar frame ${frame.name} — on sale at ${frame.priceDiamonds} diamonds, ${frame.holders} holder(s)`
      : `Updated avatar frame ${frame.name} — off sale, ${frame.holders} holder(s) keep it`,
    details: { changes: req.body ?? {}, frame },
  });
  res.json({ frame });
});

export const deleteFrameEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const key = requireIdentity(req.params.key, 'key');
  const result = await deleteFrame(key);
  await logAction(req, {
    action: 'FRAME_DELETE',
    targetType: 'frame',
    targetId: key,
    summary: `Removed avatar frame ${key}; ${result.membersStillHolding} member(s) keep their receipt and stop showing it`,
    details: result,
  });
  res.json(result);
});

/** Who holds a ring — the panel's answer to "this member says they bought it". */
export const frameHoldersEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const key = requireIdentity(req.params.key, 'key');
  res.json({ key, holders: await holdersOf('FRAME', key) });
});

/**
 * Give a member an item without diamonds moving.
 *
 * `days` is optional: omitted keeps the catalogue's period, and `null` makes the grant permanent.
 * A grant is never written as a zero-price purchase — the ledger would say money moved when it
 * did not.
 */
export const grantItemEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const kind = readKind(req.body?.kind);
  const key = readItemKey(req.body?.key);
  // `null` is a value here, not an omission: it is how an operator makes a grant permanent.
  const days = req.body?.days === null ? null : optionalInt(req.body?.days, 'days', { min: 1, max: 3650 });
  const item = await grantItem({ userId, kind, key, days });
  await logAction(req, {
    action: 'ITEM_GRANT',
    targetType: 'user',
    targetId: userId,
    summary: `Granted ${kind.toLowerCase()} ${item.name} to a member${item.expiresAt ? ` until ${item.expiresAt.slice(0, 10)}` : ' permanently'}`,
    details: { kind, key, days: days === undefined ? 'catalogue period' : days, item },
  });
  res.status(201).json({ item });
});

// --- Chat emoji -----------------------------------------------------------
//
// The picker a member opens in a room. Same shape as the decoration catalogue: reads are a room
// concern, writes change what every device shows and so need `config:manage`, and each one is
// audited because the string stored here is rendered inside other people's messages.

export const emojiCatalogueEndpoint = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await listAdminEmoji());
});

export const createEmojiEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const emoji = await createEmoji(req.body ?? {});
  await logAction(req, {
    action: 'EMOJI_CREATE',
    targetType: 'emoji',
    targetId: emoji.key,
    summary: `Added chat emoji ${emoji.label} (${emoji.code})`,
    details: { emoji },
  });
  res.status(201).json({ emoji });
});

export const updateEmojiEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const key = requireIdentity(req.params.key, 'key');
  const emoji = await updateEmoji(key, req.body ?? {});
  await logAction(req, {
    action: 'EMOJI_UPDATE',
    targetType: 'emoji',
    targetId: key,
    summary: `Updated chat emoji ${emoji.label} (${emoji.code})`,
    details: { changes: req.body ?? {}, emoji },
  });
  res.json({ emoji });
});

export const deleteEmojiEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const key = requireIdentity(req.params.key, 'key');
  const result = await deleteEmoji(key);
  await logAction(req, {
    action: 'EMOJI_DELETE',
    targetType: 'emoji',
    targetId: key,
    summary: `Removed chat emoji [${key}]; messages already carrying it show the text`,
    details: result,
  });
  res.json(result);
});

/**
 * The earned-level ladder (migration 0017). Reading it is a `user:read` concern — an operator who
 * can see accounts has to know what a badge on one of them means — while moving a threshold or
 * retiring a rung reshapes what every device shows, which is `config:manage`, the same permission
 * that holds the seat policy and the decoration catalogue.
 */
export const rankLadderEndpoint = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await listAdminRanks());
});

export const createRankEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const rank = await createRank(req.body ?? {});
  await logAction(req, {
    action: 'RANK_CREATE',
    targetType: 'rank',
    targetId: String(rank.level),
    summary: `Added level ${rank.level} (${rank.name}) at ${rank.minXp} XP`,
    details: { rank },
  });
  res.status(201).json({ rank });
});

export const updateRankEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const level = requireRankLevel(req.params.level);
  const rank = await updateRank(level, req.body ?? {});
  await logAction(req, {
    action: 'RANK_UPDATE',
    targetType: 'rank',
    targetId: String(level),
    summary: `Updated level ${level} (${rank.name}) at ${rank.minXp} XP, ${rank.membersOnRung} account(s) sit on it`,
    details: { changes: req.body ?? {}, rank },
  });
  res.json({ rank });
});

export const deleteRankEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const level = requireRankLevel(req.params.level);
  const result = await deleteRank(level);
  await logAction(req, {
    action: 'RANK_DELETE',
    targetType: 'rank',
    targetId: String(level),
    summary: `Removed level ${level}; ${result.membersMoved} account(s) fell to the rung below`,
    details: result,
  });
  res.json(result);
});

/**
 * Correcting a member's experience, and therefore their badge. The delta and the reason are both
 * written to the audit log: a rung somebody earned by gifting cannot be taken away quietly.
 */
export const adjustUserXpEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireString(req.params.id, 'userId', { min: 36, max: 36 });
  const delta = requireInt(req.body?.delta, 'delta', { min: -1_000_000_000, max: 1_000_000_000 });
  const reason = optionalString(req.body?.reason, 'reason', 200);
  const row = await adjustUserXp(userId, delta);
  const user = toUser(row);
  await logAction(req, {
    action: 'USER_XP_ADJUST',
    targetType: 'user',
    targetId: userId,
    summary: `Adjusted experience by ${delta > 0 ? '+' : ''}${delta} to ${user.xp} (${user.rank.name})${reason ? ` — ${reason}` : ''}`,
    details: { delta, reason: reason ?? null, xp: user.xp, rank: user.rank },
  });
  res.json({ user });
});

/**
 * Daily quests and the check-in dials (migration 0020).
 *
 * These rows decide how much experience the *whole platform* can earn per day, which is why
 * reading them is `user:read` and writing them is `config:manage`. The service never accepts an
 * experience value on a member route; the only XP these endpoints can cause is the reward an
 * operator typed here, paid later by a real gift or check-in.
 */
export const questsEndpoint = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await listAdminQuests());
});

export const createQuestEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const quest = await createQuest(req.body ?? {});
  await logAction(req, {
    action: 'QUEST_CREATE',
    targetType: 'quest',
    targetId: quest.key,
    summary: `Added quest "${quest.title}" (${quest.metric} x${quest.target} for ${quest.xpReward} XP)`,
    details: { quest },
  });
  res.status(201).json({ quest });
});

export const updateQuestEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const key = requireString(req.params.key, 'key', { min: 2, max: 40 });
  const quest = await updateQuest(key, req.body ?? {});
  await logAction(req, {
    action: 'QUEST_UPDATE',
    targetType: 'quest',
    targetId: key,
    summary: `Updated quest "${quest.title}" (${quest.metric} x${quest.target} for ${quest.xpReward} XP, ${quest.isActive ? 'active' : 'retired'})`,
    details: { changes: req.body ?? {}, quest },
  });
  res.json({ quest });
});

export const deleteQuestEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const key = requireString(req.params.key, 'key', { min: 2, max: 40 });
  const result = await deleteQuest(key);
  await logAction(req, {
    action: 'QUEST_DELETE',
    targetType: 'quest',
    targetId: key,
    summary: `Removed quest ${key}`,
    details: result,
  });
  res.json(result);
});

export const questSettingsEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const settings = await updateQuestSettings(req.body ?? {});
  await logAction(req, {
    action: 'QUEST_SETTINGS_UPDATE',
    targetType: 'quest_settings',
    targetId: 'singleton',
    summary: `Quest reset timezone ${settings.resetTimezone}, check-in ${settings.checkinBaseXp}+${settings.checkinStreakStepXp}/day up to ${settings.checkinMaxStreakDays} days`,
    details: { changes: req.body ?? {}, settings },
  });
  res.json({ settings });
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
