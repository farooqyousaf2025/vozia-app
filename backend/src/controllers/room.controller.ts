import { Request, Response } from 'express';
import {
  closeRoom,
  createRoom,
  deleteRoom,
  getLivekitAccess,
  getRoomDetail,
  joinRoom,
  kickSeat,
  leaveRoom,
  listHostedRooms,
  listRoomStates,
  normalizeLanguage,
  normalizeRegion,
  quickJoinRoom,
  RULES_MAX_LENGTH,
  seatLimits,
  setHandRaised,
  setRoomTheme,
  setSeatLock,
  setSeatMute,
  updateRoom,
  vacateSeat,
  type RoomSort,
} from '../services/room.service';
import {
  broadcastMicToggle,
  broadcastRoomClosed,
  broadcastSeatUpdate,
  emitToRoom,
  emitToUser,
} from '../services/socket.service';
import { recordEarningProgressOutside } from '../services/earning.service';
import { themeCatalogue, themeSlugs } from '../services/theme.service';
import {
  addFavorite,
  approveSpeakerRequest,
  cancelSpeakerRequest,
  favoriteState,
  inviteToSeat,
  listFavoriteRooms,
  listSpeakerRequests,
  rejectSpeakerRequest,
  removeFavorite,
  setAnnouncement,
  takeSeatOrRequest,
  transferRoomOwnership,
} from '../services/room-community.service';
import {
  ApiError,
  asyncHandler,
  optionalInt,
  optionalString,
  requireBoolean,
  requireEnum,
  requireInt,
  requireString,
} from '../utils/http';

const CATEGORIES = ['POPULAR', 'PARTY', 'MUSIC', 'GAME', 'CHAT'] as const;

const roomId = (req: Request) => requireString(req.params.id, 'roomId', { min: 36, max: 36 });

/**
 * The largest seat index any room on this deployment could have. Which of those indices exist in
 * a given room is the service's job (`takeSeat` compares against `rooms.seat_capacity`); this only
 * keeps a client from sending an index the schema would reject.
 */
const maxSeatIndex = async () => (await seatLimits()).max - 1;
const seatIndex = async (req: Request) => requireInt(req.params.index, 'seatIndex', { min: 0, max: await maxSeatIndex() });

/**
 * The seat policy the create-room form needs. Public, like the room list: it names a capacity, not
 * a permission, and a client must not have to guess a number the administrator owns.
 */
export const capacity = asyncHandler(async (_req: Request, res: Response) => {
  const limits = await seatLimits();
  res.json({
    seatCapacity: { min: limits.min, default: limits.default, max: limits.max },
    speakerSeats: limits.policy.speakerSeats,
    maxSpeakerSeats: limits.policy.maxSpeakerSeats,
  });
});

const SORTS: readonly RoomSort[] = ['popular', 'trending', 'recent'];

export const list = asyncHandler(async (req: Request, res: Response) => {
  const category = optionalString(req.query.category, 'category', 12)?.toUpperCase();
  if (category && !CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    throw ApiError.badRequest(`category must be one of ${CATEGORIES.join(', ')}`);
  }
  const rawSort = optionalString(req.query.sort, 'sort', 12)?.toLowerCase();
  if (rawSort && !SORTS.includes(rawSort as RoomSort)) {
    throw ApiError.badRequest(`sort must be one of ${SORTS.join(', ')}`, 'sort_unknown');
  }
  const limit = optionalInt(req.query.limit, 'limit', { min: 1, max: 100 }) ?? 40;
  const search = optionalString(req.query.search, 'search', 60);
  // Filters are the server's, not the client's: a lobby that filtered trending or language
  // after fetching 40 rooms would show a different list on every phone.
  const rooms = await listRoomStates({
    category,
    limit,
    search,
    sort: rawSort as RoomSort | undefined,
    language: normalizeLanguage(optionalString(req.query.language, 'language', 16)),
    region: normalizeRegion(optionalString(req.query.region, 'region', 2)),
  });
  res.json({ rooms });
});

/** Quick Join: one busy public room this member is allowed to walk into. */
export const quickJoin = asyncHandler(async (req: Request, res: Response) => {
  res.json({ room: await quickJoinRoom(req.user!.sub) });
});

/** My Room: the rooms the caller hosts, open first. */
export const mine = asyncHandler(async (req: Request, res: Response) => {
  const limit = optionalInt(req.query.limit, 'limit', { min: 1, max: 50 }) ?? 10;
  res.json({ rooms: await listHostedRooms(req.user!.sub, limit) });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const title = requireString(req.body?.title, 'title', { min: 2, max: 60 });
  const type = req.body?.type === undefined ? 'PUBLIC' : requireEnum(req.body.type, 'type', ['PUBLIC', 'PRIVATE'] as const);
  const category =
    req.body?.category === undefined
      ? 'PARTY'
      : requireEnum(req.body.category, 'category', ['PARTY', 'MUSIC', 'GAME', 'CHAT', 'POPULAR'] as const);

  const limits = await seatLimits();
  const room = await createRoom(req.user!.sub, {
    title,
    description: optionalString(req.body?.description, 'description', 200),
    category,
    type,
    password: optionalString(req.body?.password, 'password', 32),
    // Absent means "use the platform default", so the client never has to hardcode one.
    seatCapacity: optionalInt(req.body?.seatCapacity, 'seatCapacity', { min: limits.min, max: limits.max }),
    coverUrl: optionalString(req.body?.coverUrl, 'coverUrl', 500),
    theme: req.body?.theme === undefined ? undefined : requireEnum(req.body.theme, 'theme', themeSlugs()),
    // Language/region/rules are optional profile text; the service normalizes the tags and
    // throws on a malformed one, so a typo is a 400 here rather than a room nobody can filter.
    language: optionalString(req.body?.language, 'language', 16),
    region: optionalString(req.body?.region, 'region', 2),
    rules: optionalString(req.body?.rules, 'rules', RULES_MAX_LENGTH),
  });
  res.status(201).json({ room });
});

/**
 * Edit the room's own profile. Absent means unchanged, empty means cleared — the host must be
 * able to remove a rule line without sending a blank title.
 */
export const update = asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = (key: string, max: number) =>
    body[key] === undefined ? undefined : optionalString(body[key], key, max) ?? '';
  const room = await updateRoom(roomId(req), req.user!.sub, {
    title: body.title === undefined ? undefined : requireString(body.title, 'title', { min: 2, max: 60 }),
    description: text('description', 200),
    category:
      body.category === undefined
        ? undefined
        : requireEnum(body.category, 'category', ['PARTY', 'MUSIC', 'GAME', 'CHAT', 'POPULAR'] as const),
    coverUrl: text('coverUrl', 500),
    language: text('language', 16),
    region: text('region', 2),
    rules: text('rules', RULES_MAX_LENGTH),
    announcement: body.announcement === undefined ? undefined : text('announcement', 300),
    speakerApprovalRequired:
      body.speakerApprovalRequired === undefined
        ? undefined
        : requireBoolean(body.speakerApprovalRequired, 'speakerApprovalRequired'),
  });
  // Members already inside see the new title and rule line without leaving and rejoining.
  emitToRoom(roomId(req), 'room:profile_updated', {
    roomId: roomId(req),
    title: room.room.title,
    description: room.room.description,
    category: room.room.category,
    language: room.room.language,
    region: room.room.region,
    rules: room.room.rules,
    announcement: room.room.announcement,
    announcementUpdatedAt: room.room.announcementUpdatedAt,
    speakerApprovalRequired: room.room.speakerApprovalRequired,
  });
  // A pinned notice gets its own event: the chat header can repaint it without re-reading the room.
  if (body.announcement !== undefined) {
    emitToRoom(roomId(req), 'room:announcement', {
      roomId: roomId(req),
      announcement: room.room.announcement,
      updatedAt: room.room.announcementUpdatedAt,
    });
  }
  if (body.speakerApprovalRequired !== undefined) {
    emitToRoom(roomId(req), 'room:speaker_approval', {
      roomId: roomId(req),
      required: room.room.speakerApprovalRequired,
    });
  }
  res.json({ room: room.room });
});

/** Delete an eligible room (closed, and nothing about it is still history). */
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const result = await deleteRoom(id, req.user!.sub);
  // The row is gone, so anyone who somehow still holds it open is told the way a host closing
  // the room tells them.
  broadcastRoomClosed(id);
  res.json(result);
});

/** Wallpaper/animation catalogue the clients need before they can restyle a room. */
export const themes = asyncHandler(async (_req: Request, res: Response) => {
  res.json(themeCatalogue());
});

export const show = asyncHandler(async (req: Request, res: Response) => {
  const detail = await getRoomDetail(roomId(req));
  res.json({
    room: detail.room,
    seats: detail.seats,
    audience: detail.audience,
    handRaises: detail.handRaises,
    chat: detail.chat,
    listenerCount: detail.listenerCount,
  });
});

export const join = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const result = await joinRoom(req.user!.sub, id, optionalString(req.body?.password, 'password', 32));
  await broadcastSeatUpdate(id);
  // ROOM_JOIN is counted from the one request that writes the participant row. Not awaited: the
  // earning runs in its own transaction, and a campaign that cannot pay must not hold up the token
  // the member needs to enter. The category travels with the event because that is the only thing a
  // room rule can be conditioned on, and it comes from the room the server just opened, not the body.
  recordEarningProgressOutside(req.user!.sub, [
    { metric: 'ROOM_JOIN', amount: 1, context: { roomCategory: result.room.category } },
  ]).catch((err) => console.warn('[room] earning progress', err.message));
  res.json({ room: result.room, seats: result.seats, audience: result.audience, livekit: result.livekit });
});

export const leave = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const result = await leaveRoom(req.user!.sub, id);
  await broadcastSeatUpdate(id);
  res.json(result);
});

export const seatTake = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const index = requireInt(req.body?.seatIndex, 'seatIndex', { min: 0, max: await maxSeatIndex() });
  const outcome = await takeSeatOrRequest(req.user!.sub, id, index);
  // Approval-enabled rooms answer with 202 and a queued request instead of a seat. The host is
  // notified privately; the member's client shows "waiting for the host" without a token.
  if (outcome.kind === 'requested') {
    emitToUser(outcome.hostId, 'room:speaker_request', { roomId: id, request: outcome.request });
    res.status(202).json({ requested: true, request: outcome.request });
    return;
  }
  // The new speaker needs a publisher token; issue it inline so the client never
  // has to guess whether it may open its microphone.
  const livekit = await getLivekitAccess(req.user!.sub, id);
  await broadcastSeatUpdate(id);
  res.json({ seats: outcome.seats, livekit });
});

export const seatLeave = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  await seatIndex(req); // validated for the client's benefit; the seat we clear is the caller's
  const { seats } = await vacateSeat(req.user!.sub, id);
  const livekit = await getLivekitAccess(req.user!.sub, id);
  await broadcastSeatUpdate(id);
  res.json({ seats, livekit });
});

export const seatLock = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const index = await seatIndex(req);
  const locked = requireBoolean(req.body?.locked, 'locked');
  const { seats } = await setSeatLock(req.user!.sub, id, index, locked);
  await broadcastSeatUpdate(id);
  res.json({ seats });
});

export const seatMute = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const index = await seatIndex(req);
  const muted = requireBoolean(req.body?.muted, 'muted');
  const { seats, self } = await setSeatMute(req.user!.sub, id, index, muted);
  const seat = seats.find((s) => s.seatIndex === index);
  broadcastMicToggle(id, index, muted, seat?.user?.id ?? null);
  await broadcastSeatUpdate(id);
  res.json({ seats, self });
});

export const seatKick = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const index = await seatIndex(req);
  const { seats, kickedUserId } = await kickSeat(req.user!.sub, id, index);
  if (kickedUserId) {
    const livekit = await getLivekitAccess(kickedUserId, id);
    emitToUser(kickedUserId, 'room:kicked', { roomId: id, livekit });
  }
  await broadcastSeatUpdate(id);
  res.json({ seats });
});

export const handRaise = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const raise = req.body?.raise === undefined ? true : requireBoolean(req.body.raise, 'raise');
  const { raised } = await setHandRaised(req.user!.sub, id, raise);
  res.json({ ok: true, raised });
});

export const close = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const result = await closeRoom(id, req.user!.sub);
  broadcastRoomClosed(id);
  res.json({ ok: true, room: result.room });
});

export const setTheme = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const theme = requireEnum(req.body?.theme, 'theme', themeSlugs());
  const { room } = await setRoomTheme(id, theme, req.user!.sub);
  // The wallpaper URL travels with the slug: a client that derived `/themes/<slug>/…` would 404
  // on any theme an operator pointed at the upload store.
  emitToRoom(id, 'room:theme_changed', { roomId: id, theme: room.theme, wallpaper: room.themeWallpaper });
  res.json({ room });
});

export const livekitToken = asyncHandler(async (req: Request, res: Response) => {
  const access = await getLivekitAccess(req.user!.sub, roomId(req));
  res.json(access);
});

// ---------------------------------------------------------------------------
// Favourites. A bookmark is per member, so every route here is authenticated; the
// room itself stays public and its payload does not carry one caller's opinion of it.
// ---------------------------------------------------------------------------

export const favorites = asyncHandler(async (req: Request, res: Response) => {
  const limit = optionalInt(req.query.limit, 'limit', { min: 1, max: 100 }) ?? 30;
  const offset = optionalInt(req.query.offset, 'offset', { min: 0 }) ?? 0;
  res.json({ rooms: await listFavoriteRooms(req.user!.sub, limit, offset) });
});

export const favoriteShow = asyncHandler(async (req: Request, res: Response) => {
  res.json(await favoriteState(req.user!.sub, roomId(req)));
});

export const favoriteAdd = asyncHandler(async (req: Request, res: Response) => {
  res.json(await addFavorite(req.user!.sub, roomId(req)));
});

export const favoriteRemove = asyncHandler(async (req: Request, res: Response) => {
  res.json(await removeFavorite(req.user!.sub, roomId(req)));
});

// ---------------------------------------------------------------------------
// Pinned notice. PATCH /rooms/:id can also write it; this route exists so a phone
// does not have to resend the whole profile to change one line.
// ---------------------------------------------------------------------------

export const announcement = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const room = await setAnnouncement(id, req.user!.sub, req.body?.announcement);
  emitToRoom(id, 'room:announcement', {
    roomId: id,
    announcement: room.announcement,
    updatedAt: room.announcementUpdatedAt,
  });
  res.json({ room });
});

// ---------------------------------------------------------------------------
// Speaker approval queue. The host works through it; a member may only cancel their
// own request. An approved request also mints the publisher token the member needs,
// which is why the approval response carries `livekit` in the private notification
// rather than waiting for the phone to ask again.
// ---------------------------------------------------------------------------

export const speakerRequests = asyncHandler(async (req: Request, res: Response) => {
  res.json({ requests: await listSpeakerRequests(roomId(req), req.user!.sub) });
});

export const speakerRequestCancel = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const { cancelled } = await cancelSpeakerRequest(req.user!.sub, id);
  res.json({ ok: true, cancelled });
});

export const speakerRequestApprove = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const requestId = requireString(req.params.requestId, 'requestId', { min: 36, max: 36 });
  const result = await approveSpeakerRequest(id, req.user!.sub, requestId);
  const livekit = await getLivekitAccess(result.userId, id);
  emitToUser(result.userId, 'room:speaker_decision', {
    roomId: id,
    status: 'APPROVED',
    request: result.request,
    seatIndex: result.seatIndex,
    livekit,
  });
  emitToRoom(id, 'room:speaker_request_updated', { roomId: id, request: result.request });
  await broadcastSeatUpdate(id);
  res.json({ request: result.request, seats: result.seats });
});

export const speakerRequestReject = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const requestId = requireString(req.params.requestId, 'requestId', { min: 36, max: 36 });
  const result = await rejectSpeakerRequest(id, req.user!.sub, requestId);
  emitToUser(result.userId, 'room:speaker_decision', {
    roomId: id,
    status: 'REJECTED',
    request: result.request,
  });
  emitToRoom(id, 'room:speaker_request_updated', { roomId: id, request: result.request });
  res.json({ request: result.request });
});

export const seatInvite = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const index = await seatIndex(req);
  const userId = requireString(req.body?.userId, 'userId', { min: 36, max: 36 });
  const result = await inviteToSeat(id, req.user!.sub, index, userId);
  const livekit = await getLivekitAccess(result.userId, id);
  emitToUser(result.userId, 'room:seat_invited', {
    roomId: id,
    seatIndex: result.seatIndex,
    livekit,
  });
  await broadcastSeatUpdate(id);
  res.json({ seats: result.seats });
});

// ---------------------------------------------------------------------------
// Ownership transfer. The room row is locked in the service, so a second transfer
// racing this one fails instead of producing two hosts.
// ---------------------------------------------------------------------------

export const transfer = asyncHandler(async (req: Request, res: Response) => {
  const id = roomId(req);
  const userId = requireString(req.body?.userId, 'userId', { min: 36, max: 36 });
  const result = await transferRoomOwnership(id, req.user!.sub, userId, req.body?.note);
  await broadcastSeatUpdate(id);
  emitToRoom(id, 'room:ownership_transferred', {
    roomId: id,
    previousHostId: result.previousHostId,
    host: result.host,
    room: result.room,
  });
  res.json(result);
});
