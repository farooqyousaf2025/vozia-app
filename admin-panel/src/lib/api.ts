// ---------------------------------------------------------------------------
// Typed fetch wrapper for the Voiza admin API.
// - injects `Authorization: Bearer <jwt>` from localStorage
// - parses JSON, throws a typed ApiError carrying the server message
// - on 401 clears the session and bounces the browser to /login
//   (except on the login call itself, where the error is surfaced inline)
// ---------------------------------------------------------------------------
import type {
  AccountHold,
  AccountHoldListResult,
  AccountListResult,
  AccountMovementListResult,
  AccountReconciliation,
  AccountStatus,
  AdminEmoji,
  AdminGamesResult,
  AdminIdentity,
  AdminQuest,
  AdminQuestsResult,
  AdminRank,
  AdminReport,
  AdminRoomTheme,
  AdminStats,
  Agency,
  AgencyDetailResult,
  AgencyListResult,
  AgencyRosterRow,
  AgencySettlement,
  AgencySettlementEntriesResult,
  AgencySettlementListResult,
  AuditEntry,
  BalanceAdjustResult,
  Banner,
  BannerInput,
  BusinessAccount,
  BusinessAccountListResult,
  CategoryEffect,
  CommissionBeneficiary,
  CommissionEntry,
  CommissionRule,
  CommissionRuleKind,
  CommissionSettlement,
  PartnerRef,
  CommissionSummary,
  CommissionTier,
  ConsoleRoom,
  DecorCatalogue,
  EffectInput,
  EmojiInput,
  FinAccount,
  FrameHolder,
  FrameInput,
  GameDefinition,
  GameDispute,
  GameEvent,
  GameRulePatch,
  GameRulesResult,
  GiftAnalyticsResult,
  GiftCategoryInput,
  GiftCategoryListResult,
  GiftCategoryMutationResult,
  GiftCategoryPatch,
  GiftInput,
  GiftListResult,
  GiftMutationResult,
  GiftPatch,
  GrantedItem,
  HoldKind,
  JournalListResult,
  LoginResponse,
  MediaAsset,
  MediaKind,
  OkResult,
  Operator,
  OperatorListResult,
  OperatorRoleInfo,
  ProfileFrame,
  ProfileRide,
  PurposeAccount,
  PublishedBanner,
  PublishedEmojiCatalogue,
  PublishedLadder,
  QuestInput,
  QuestSettings,
  QuestSettingsInput,
  RankInput,
  RechargeOrder,
  RechargeOrderListResult,
  RechargePackage,
  ReconciliationReport,
  ReportDecision,
  ReportListResult,
  ReportReviewResult,
  RideHolder,
  RideInput,
  RoomChatMessage,
  RoomConsoleResult,
  RoomListQuery,
  RoomListResult,
  RoomMutationResult,
  RoomSeatDetail,
  SeatPolicyResult,
  StoreItemKind,
  ThemeCatalogue,
  ThemeInput,
  TrialBalance,
  UserListQuery,
  UserListResult,
  UserMutationResult,
  UserSocialSummary,
  VisualEffect,
  VisualEffectKind,
  WithdrawalListQuery,
  WithdrawalListResult,
  WithdrawalMutationResult,
} from '../types';

const TOKEN_KEY = 'voiza.admin.token';
const ADMIN_KEY = 'voiza.admin.identity';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable — session simply will not persist */
  }
}

export function getStoredAdmin(): AdminIdentity | null {
  try {
    const raw = localStorage.getItem(ADMIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdminIdentity;
    if (typeof parsed?.id === 'string' && typeof parsed?.username === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function setStoredAdmin(admin: AdminIdentity | null): void {
  try {
    if (admin === null) localStorage.removeItem(ADMIN_KEY);
    else localStorage.setItem(ADMIN_KEY, JSON.stringify(admin));
  } catch {
    /* ignore */
  }
}

/**
 * Error carrying the HTTP status plus the server-provided message.
 *
 * `code` is the stable machine code the backend answers a refusal with (`error.code`), and `details`
 * the structured facts beside it (`error.details`). The panel needs both because a refusal's message
 * is prose a month from now will not match, while its code is a contract — a lucky box that pays more
 * than it sells and a box with no prizes are both 400s, and only the code says which one the operator
 * has to fix.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function apiBase(): string {
  const raw = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';
  return raw.replace(/\/+$/, '');
}

/** Origin the Socket.IO console channel dials — the same host that serves the API. */
export function socketBase(): string {
  return apiBase();
}

/**
 * Gift icons and host avatars are stored as root-relative paths (`/gifts/rose.png`)
 * that live on the API origin, not on whatever host serves this bundle.
 * Absolute URLs (a CDN, a data URI) pass through untouched.
 */
export function assetUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return `${apiBase()}/${url.replace(/^\/+/, '')}`;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** attach the bearer token (default true) */
  auth?: boolean;
  /** suppress the automatic redirect on 401 (used by /login) */
  noRedirect?: boolean;
}

/** What a failed response says: the sentence for the screen, the code for the branch, the facts for the maths. */
interface ServerFailure {
  message: string;
  code: string;
  details?: unknown;
}

function describeFailure(payload: unknown, status: number): ServerFailure {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const nested = record.error;
    if (typeof nested === 'object' && nested !== null) {
      const error = nested as Record<string, unknown>;
      const msg = error.message;
      const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : 'error';
      const details = error.details === undefined ? {} : { details: error.details };
      // A body with neither `code` nor `message` is an unexpected shape, so it still falls through to
      // the plain-message and status-derived readings below rather than inventing an empty sentence.
      if (typeof msg === 'string' && msg.length > 0) return { message: msg, code, ...details };
      if (code !== 'error') return { message: fallbackMessage(status), code, ...details };
    }
    if (typeof nested === 'string' && nested.length > 0) return { message: nested, code: 'error' };
    if (typeof record.message === 'string' && record.message.length > 0) {
      return { message: record.message, code: typeof record.code === 'string' ? record.code : 'error' };
    }
  }
  return { message: fallbackMessage(status), code: 'error' };
}

function fallbackMessage(status: number): string {
  if (status === 401) return 'Session expired. Please sign in again.';
  if (status === 403) return 'This admin account is not allowed to perform that action.';
  if (status === 404) return 'Not found.';
  if (status >= 500) return 'The Voiza backend returned a server error. Try again shortly.';
  return `Request failed with status ${status}.`;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, noRedirect = false } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = auth ? getToken() : null;
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, `Network error: cannot reach the Voiza backend at ${apiBase()}.`);
  }

  let payload: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const failure = describeFailure(payload, response.status);
    // A 401 ends the session because the token has expired. `operator_disabled` ends it the same
    // way even though it is a 403: the account was switched off, so this is not a permission to
    // retry on the next screen — every request carrying this token answers identically.
    const endsSession =
      (response.status === 401 || (response.status === 403 && failure.code === 'operator_disabled')) &&
      auth &&
      !noRedirect;
    if (endsSession) {
      setToken(null);
      setStoredAdmin(null);
      if (window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    }
    throw new ApiError(response.status, failure.message, failure.code, failure.details);
  }

  return payload as T;
}

function query(params: Record<string, string | number | undefined | null>): string {  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

/**
 * Fetch an authenticated CSV and hand it to the browser as a file. A plain link cannot carry
 * the bearer token, so the bytes come through fetch and leave as an object URL.
 */
async function downloadCsv(path: string, filename: string): Promise<void> {
  await downloadFile(path, filename, 'text/csv');
}

const EXPORT_TYPES: Record<'csv' | 'xlsx', string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The same shape as `downloadCsv` for any export the backend can attach a filename to. */
async function downloadFile(path: string, filename: string, accept: string): Promise<void> {
  const headers: Record<string, string> = { Accept: accept };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, { headers });
  } catch {
    throw new ApiError(0, `Network error: cannot reach the Voiza backend at ${apiBase()}.`);
  }
  if (!response.ok) {
    const failure = describeFailure(null, response.status);
    throw new ApiError(response.status, failure.message, failure.code);
  }

  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  // ---- auth ----------------------------------------------------------------
  login(username: string, password: string): Promise<LoginResponse> {
    return request<LoginResponse>('/api/admin/login', {
      method: 'POST',
      body: { username, password },
      auth: false,
      noRedirect: true,
    });
  },

  // ---- overview -------------------------------------------------------------
  whoami(): Promise<{ admin: AdminIdentity; permissions: string[] }> {
    return request<{ admin: AdminIdentity; permissions: string[] }>('/api/admin/me');
  },

  stats(): Promise<AdminStats> {
    return request<AdminStats>('/api/admin/stats');
  },

  // ---- users ------------------------------------------------------------------
  listUsers(params: UserListQuery = {}): Promise<UserListResult> {
    return request<UserListResult>(
      `/api/admin/users${query({
        search: params.search,
        status: params.status,
        userType: params.userType,
        page: params.page ?? 1,
        limit: params.limit ?? 20,
      })}`,
    );
  },

  adjustBalance(userId: string, diamondDelta: number, rCoinDelta: number, note: string): Promise<BalanceAdjustResult> {
    return request<BalanceAdjustResult>(`/api/admin/users/${userId}/balance`, {
      method: 'POST',
      body: { diamondDelta, rCoinDelta, note },
    });
  },

  setBan(userId: string, banned: boolean, reason?: string): Promise<UserMutationResult> {
    return request<UserMutationResult>(`/api/admin/users/${userId}/ban`, {
      method: 'POST',
      body: { banned, reason: banned ? reason : undefined },
    });
  },

  setVipLevel(userId: string, vipLevel: number): Promise<UserMutationResult> {
    return request<UserMutationResult>(`/api/admin/users/${userId}/vip`, {
      method: 'POST',
      body: { vipLevel },
    });
  },

  /**
   * Nudge a member's earned experience. It is a delta, not an absolute, so an adjustment cannot
   * clobber the gifts a member sent while this dialog was open.
   */
  addXp(userId: string, delta: number, reason?: string): Promise<UserMutationResult> {
    return request<UserMutationResult>(`/api/admin/users/${userId}/xp`, {
      method: 'POST',
      body: { delta, reason: reason && reason.length > 0 ? reason : undefined },
    });
  },

  // ---- social moderation (migration 0022) --------------------------------------
  /**
   * The report work queue. `status` defaults to the server's combined view; pass `PENDING` to see
   * only what still needs a decision.
   */
  reports(params: {
    status?: string;
    targetUserId?: string;
    reporterId?: string;
    page?: number;
    limit?: number;
  } = {}): Promise<ReportListResult> {
    return request<ReportListResult>(
      `/api/admin/reports${query({
        status: params.status,
        targetUserId: params.targetUserId,
        reporterId: params.reporterId,
        page: params.page ?? 1,
        limit: params.limit ?? 25,
      })}`,
    );
  },

  /**
   * Resolve one report. `banUser` is a second, explicit act: the server refuses it together with
   * `DISMISSED`, because a dismissal says the complaint was unfounded.
   */
  reviewReport(
    reportId: string,
    decision: ReportDecision,
    resolution?: string,
    banUser?: boolean,
  ): Promise<ReportReviewResult> {
    return request<ReportReviewResult>(`/api/admin/reports/${reportId}/review`, {
      method: 'POST',
      body: {
        decision,
        resolution: resolution && resolution.length > 0 ? resolution : undefined,
        banUser: banUser === true ? true : undefined,
      },
    });
  },

  /** Followers, follows, blocks and both directions of reports around one account. */
  userSocial(userId: string): Promise<UserSocialSummary> {
    return request<UserSocialSummary>(`/api/admin/users/${userId}/social`);
  },

  // ---- rooms -------------------------------------------------------------------
  listRooms(params: RoomListQuery = {}): Promise<RoomListResult> {
    return request<RoomListResult>(
      `/api/admin/rooms${query({ status: params.status, search: params.search })}`,
    );
  },

  // ---- seat policy -------------------------------------------------------------
  /** How many seats a new room gets, and the most a host may ask for. */
  seatPolicy(): Promise<SeatPolicyResult> {
    return request<SeatPolicyResult>(`/api/admin/rooms/seat-policy`);
  },

  writeSeatPolicy(body: { speakerSeats: number; maxSpeakerSeats: number }): Promise<SeatPolicyResult> {
    return request<SeatPolicyResult>(`/api/admin/rooms/seat-policy`, { method: 'PUT', body });
  },

  closeRoom(roomId: string): Promise<RoomMutationResult> {
    return request<RoomMutationResult>(`/api/admin/rooms/${roomId}/close`, { method: 'POST' });
  },

  disconnectRoomUser(roomId: string, userId: string): Promise<OkResult> {
    return request<OkResult>(`/api/admin/rooms/${roomId}/disconnect-user`, {
      method: 'POST',
      body: { userId },
    });
  },

  // ---- room ops console -------------------------------------------------------
  roomConsole(roomId: string): Promise<RoomConsoleResult> {
    return request<RoomConsoleResult>(`/api/admin/rooms/${encodeURIComponent(roomId)}`);
  },

  sendRoomMessage(roomId: string, message: string): Promise<{ message: RoomChatMessage }> {
    return request<{ message: RoomChatMessage }>(`/api/admin/rooms/${roomId}/chat`, {
      method: 'POST',
      body: { message },
    });
  },

  warnRoomHost(roomId: string, message: string): Promise<OkResult> {
    return request<OkResult>(`/api/admin/rooms/${roomId}/warn`, { method: 'POST', body: { message } });
  },

  muteAllSeats(roomId: string, muted: boolean): Promise<{ seats: RoomSeatDetail[]; affected: number }> {
    return request<{ seats: RoomSeatDetail[]; affected: number }>(`/api/admin/rooms/${roomId}/mute-all`, {
      method: 'POST',
      body: { muted },
    });
  },

  muteSeat(roomId: string, seatIndex: number, muted: boolean): Promise<{ seats: RoomSeatDetail[] }> {
    return request<{ seats: RoomSeatDetail[] }>(
      `/api/admin/rooms/${roomId}/seat/${seatIndex}/mute`,
      { method: 'POST', body: { muted } },
    );
  },

  lockSeat(roomId: string, seatIndex: number, locked: boolean): Promise<{ seats: RoomSeatDetail[] }> {
    return request<{ seats: RoomSeatDetail[] }>(
      `/api/admin/rooms/${roomId}/seat/${seatIndex}/lock`,
      { method: 'POST', body: { locked } },
    );
  },

  banRoomUser(
    roomId: string,
    userId: string,
    opts: { minutes?: number; reason?: string } = {},
  ): Promise<OkResult> {
    return request<OkResult>(`/api/admin/rooms/${roomId}/ban`, {
      method: 'POST',
      body: { userId, minutes: opts.minutes, reason: opts.reason },
    });
  },

  liftRoomBan(roomId: string, userId: string): Promise<{ removed: boolean }> {
    return request<{ removed: boolean }>(
      `/api/admin/rooms/${roomId}/ban/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
  },

  /** Wallpapers and animations an operator maintains in the database (migration 0015). */
  themeCatalogue(): Promise<ThemeCatalogue> {
    return request<ThemeCatalogue>('/api/rooms/themes');
  },

  setRoomTheme(roomId: string, theme: string): Promise<{ room: ConsoleRoom }> {
    return request<{ room: ConsoleRoom }>(`/api/admin/rooms/${roomId}/theme`, {
      method: 'POST',
      body: { theme },
    });
  },

  /** Pin or clear the notice above the seats. `null`/blank removes it; the host sees the same change. */
  setRoomAnnouncement(roomId: string, announcement: string | null): Promise<{ room: ConsoleRoom }> {
    return request<{ room: ConsoleRoom }>(`/api/admin/rooms/${roomId}/announcement`, {
      method: 'POST',
      body: { announcement },
    });
  },

  // ---- gifts ---------------------------------------------------------------------
  /**
   * Every gift, active or not, with a lucky box's prize table attached.
   *
   * This is the operator's read: `listGifts({ includeWeights })` on the server puts the raw `weight`
   * beside the `chanceBps` it produces, because editing 4,000 against 100 is how an operator reasons
   * and a phone is only ever shown the odds.
   */
  listGifts(): Promise<GiftListResult> {
    return request<GiftListResult>('/api/admin/gifts');
  },

  /** One write creates the gift, the box flags and the whole prize table together. */
  createGift(input: GiftInput): Promise<GiftMutationResult> {
    return request<GiftMutationResult>('/api/admin/gifts', { method: 'POST', body: input });
  },

  /**
   * Partial update: keys left out of `patch` are left alone in the database.
   *
   * PUT is the verb — `PATCH` on this path 404s, so nothing here may reach for it. For a box that
   * makes the presence of a key a decision: `boxOutcomes` omitted means "keep the draw that is
   * stored", while sending it replaces every prize row. The caller therefore sends the table only
   * when the operator actually edited it.
   */
  updateGift(giftId: string, patch: GiftPatch): Promise<GiftMutationResult> {
    return request<GiftMutationResult>(`/api/admin/gifts/${giftId}`, { method: 'PUT', body: patch });
  },

  /** A box's prizes go with it; the gift's own ledger history is untouched. */
  deleteGift(giftId: string): Promise<OkResult> {
    return request<OkResult>(`/api/admin/gifts/${giftId}`, { method: 'DELETE' });
  },

  /**
   * The shelves the gift panel tabs are built from (`gift_categories`, migration 0025). Nothing in
   * the panel may hardcode a key any more — a shelf an operator adds has to appear here, in the
   * order they set, or the phone and this screen would disagree about what the catalogue contains.
   */
  giftCategories(): Promise<GiftCategoryListResult> {
    return request<GiftCategoryListResult>('/api/admin/gift-categories');
  },

  createGiftCategory(input: GiftCategoryInput): Promise<GiftCategoryMutationResult> {
    return request<GiftCategoryMutationResult>('/api/admin/gift-categories', { method: 'POST', body: input });
  },

  /** `key` is an identity and is the path segment, never the body; a rename edits `name`. */
  updateGiftCategory(key: string, patch: GiftCategoryPatch): Promise<GiftCategoryMutationResult> {
    return request<GiftCategoryMutationResult>(
      `/api/admin/gift-categories/${encodeURIComponent(key)}`,
      { method: 'PUT', body: patch },
    );
  },

  /** Refused with `category_in_use` while any gift is filed on the shelf; there is no forced delete. */
  deleteGiftCategory(key: string): Promise<{ ok: true; key: string }> {
    return request<{ ok: true; key: string }>(`/api/admin/gift-categories/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
  },

  /**
   * Per-gift earnings over `days` (1..365); the server caps the row list at the top 100 spenders.
   * Each row carries `isLuckyBox`, so a box's realised payout rate is readable rather than guessed.
   */
  giftAnalytics(days: number): Promise<GiftAnalyticsResult> {
    return request<GiftAnalyticsResult>(`/api/admin/gifts/analytics${query({ days })}`);
  },

  // ---- uploaded media -------------------------------------------------------------
  // The file travels as base64 inside JSON, so it can carry the bearer token without a
  // multipart request the CSRF-protected API would have to special-case. `/api/admin/uploads`
  // is the only route given a multi-megabyte body limit.
  listUploads(params: { kind?: MediaKind; limit?: number; offset?: number } = {}): Promise<{ assets: MediaAsset[]; total: number }> {
    return request<{ assets: MediaAsset[]; total: number }>(
      `/api/admin/uploads${query({ kind: params.kind, limit: params.limit ?? 60, offset: params.offset ?? 0 })}`,
    );
  },

  uploadAsset(kind: MediaKind, fileName: string, base64: string): Promise<{ asset: MediaAsset; duplicate: boolean }> {
    return request<{ asset: MediaAsset; duplicate: boolean }>('/api/admin/uploads', {
      method: 'POST',
      body: { kind, fileName, data: base64 },
    });
  },

  deleteUpload(assetId: string): Promise<OkResult> {
    return request<OkResult>(`/api/admin/uploads/${assetId}`, { method: 'DELETE' });
  },

  // ---- room decoration ----------------------------------------------------------
  // Themes, Lottie loops and which category plays which loop are rows since migration
  // 0015, so this is the only place the panel learns what skins exist — nothing here may
  // hardcode a slug, or an operator's new theme would be invisible.
  decorCatalogue(): Promise<DecorCatalogue> {
    return request<DecorCatalogue>('/api/admin/decor');
  },

  createTheme(input: ThemeInput): Promise<{ theme: AdminRoomTheme }> {
    return request<{ theme: AdminRoomTheme }>('/api/admin/themes', { method: 'POST', body: input });
  },

  updateTheme(slug: string, patch: ThemeInput): Promise<{ theme: AdminRoomTheme }> {
    return request<{ theme: AdminRoomTheme }>(`/api/admin/themes/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      body: patch,
    });
  },

  deleteTheme(slug: string): Promise<{ ok: true; slug: string; roomsLeftOnDefault: number }> {
    return request<{ ok: true; slug: string; roomsLeftOnDefault: number }>(
      `/api/admin/themes/${encodeURIComponent(slug)}`,
      { method: 'DELETE' },
    );
  },

  createEffect(input: EffectInput): Promise<{ effect: VisualEffect }> {
    return request<{ effect: VisualEffect }>('/api/admin/effects', { method: 'POST', body: input });
  },

  updateEffect(key: string, patch: EffectInput): Promise<{ effect: VisualEffect }> {
    return request<{ effect: VisualEffect }>(`/api/admin/effects/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: patch,
    });
  },

  deleteEffect(key: string): Promise<{ ok: true; key: string }> {
    return request<{ ok: true; key: string }>(`/api/admin/effects/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
  },

  // ---- cosmetic store ----------------------------------------------------------
  // Frames are their own catalogue (migration 0019); prices on themes and effects are columns on
  // the rows above, which is why they are saved through the same create/update calls.
  createFrame(input: FrameInput): Promise<{ frame: ProfileFrame }> {
    return request<{ frame: ProfileFrame }>('/api/admin/frames', { method: 'POST', body: input });
  },

  updateFrame(key: string, patch: FrameInput): Promise<{ frame: ProfileFrame }> {
    return request<{ frame: ProfileFrame }>(`/api/admin/frames/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: patch,
    });
  },

  deleteFrame(key: string): Promise<{ ok: true; key: string; membersStillHolding: number }> {
    return request<{ ok: true; key: string; membersStillHolding: number }>(
      `/api/admin/frames/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    );
  },

  frameHolders(key: string): Promise<{ key: string; holders: FrameHolder[] }> {
    return request<{ key: string; holders: FrameHolder[] }>(
      `/api/admin/frames/${encodeURIComponent(key)}/holders`,
    );
  },

  // ---- entrance rides -------------------------------------------------------
  // The fourth sellable catalogue (migration 0026): bought and worn like a frame, so the same four
  // calls, and the same rule that `key` is a receipt identity — it goes in the body of a create and
  // nowhere in an update, where the path already names the row.
  createRide(input: RideInput): Promise<{ ride: ProfileRide }> {
    return request<{ ride: ProfileRide }>('/api/admin/rides', { method: 'POST', body: input });
  },

  updateRide(key: string, patch: RideInput): Promise<{ ride: ProfileRide }> {
    return request<{ ride: ProfileRide }>(`/api/admin/rides/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: patch,
    });
  },

  /** Retiring a ride never touches the receipts: the count says who stops playing it. */
  deleteRide(key: string): Promise<{ ok: true; key: string; membersStillHolding: number }> {
    return request<{ ok: true; key: string; membersStillHolding: number }>(
      `/api/admin/rides/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    );
  },

  rideHolders(key: string): Promise<{ key: string; holders: RideHolder[] }> {
    return request<{ key: string; holders: RideHolder[] }>(
      `/api/admin/rides/${encodeURIComponent(key)}/holders`,
    );
  },

  /** Give an item to a member without diamonds moving. `days: null` means permanent. */
  grantItem(userId: string, body: { kind: StoreItemKind; key: string; days?: number | null }): Promise<{ item: GrantedItem }> {
    return request<{ item: GrantedItem }>(`/api/admin/users/${userId}/grant`, { method: 'POST', body });
  },

  setCategoryEffect(category: string, effectKey: string): Promise<{ mapping: CategoryEffect }> {
    return request<{ mapping: CategoryEffect }>(
      `/api/admin/room-categories/${encodeURIComponent(category)}/effect`,
      { method: 'PUT', body: { effectKey } },
    );
  },

  // ---- chat emoji --------------------------------------------------------------
  // The picker members open in a room. `key` is the code a message stores (`[key]`), so this is
  // the only screen that decides which tokens the app will ever be able to draw as art.
  emojiCatalogue(): Promise<{ emojis: AdminEmoji[] }> {
    return request<{ emojis: AdminEmoji[] }>('/api/admin/emoji');
  },

  /** The unauthenticated view a phone reads — used here to prove a saved row was published. */
  publicEmoji(): Promise<PublishedEmojiCatalogue> {
    return request<PublishedEmojiCatalogue>('/api/emoji');
  },

  createEmoji(input: EmojiInput): Promise<{ emoji: AdminEmoji }> {
    return request<{ emoji: AdminEmoji }>('/api/admin/emoji', { method: 'POST', body: input });
  },

  updateEmoji(key: string, patch: EmojiInput): Promise<{ emoji: AdminEmoji }> {
    return request<{ emoji: AdminEmoji }>(`/api/admin/emoji/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: patch,
    });
  },

  deleteEmoji(key: string): Promise<{ ok: true; key: string }> {
    return request<{ ok: true; key: string }>(`/api/admin/emoji/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
  },

  // ---- promotional banners ----------------------------------------------------
  // Splash, home, gift-panel and game-desk art (migration 0028). The row is addressed by id, not
  // by key like the other catalogues: a key is a marketing label an operator may want to reuse,
  // while the thing being edited is one specific campaign.
  banners(): Promise<{ banners: Banner[] }> {
    return request<{ banners: Banner[] }>('/api/admin/banners');
  },

  /** The unauthenticated view a phone reads, used here to prove a saved row is actually live. */
  publicBanners(): Promise<{ banners: PublishedBanner[] }> {
    return request<{ banners: PublishedBanner[] }>('/api/banners');
  },

  createBanner(input: BannerInput): Promise<{ banner: Banner }> {
    return request<{ banner: Banner }>('/api/admin/banners', { method: 'POST', body: input });
  },

  updateBanner(id: string, patch: BannerInput): Promise<{ banner: Banner }> {
    return request<{ banner: Banner }>(`/api/admin/banners/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: patch,
    });
  },

  deleteBanner(id: string): Promise<{ ok: true; key: string; placement: string }> {
    return request<{ ok: true; key: string; placement: string }>(
      `/api/admin/banners/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  },

  // ---- level ladder ------------------------------------------------------------
  // Rungs members earn with experience (migration 0017). This is the only screen that decides
  // where each rung sits and what badge it carries, so nothing here may hardcode a level number.
  rankLadder(): Promise<{ levels: AdminRank[] }> {
    return request<{ levels: AdminRank[] }>('/api/admin/ranks');
  },

  /** The unauthenticated view a phone reads — proves a saved rung is actually published. */
  publicRanks(): Promise<PublishedLadder> {
    return request<PublishedLadder>('/api/ranks');
  },

  createRank(input: RankInput): Promise<{ rank: AdminRank }> {
    return request<{ rank: AdminRank }>('/api/admin/ranks', { method: 'POST', body: input });
  },

  updateRank(level: number, patch: RankInput): Promise<{ rank: AdminRank }> {
    return request<{ rank: AdminRank }>(`/api/admin/ranks/${level}`, { method: 'PUT', body: patch });
  },

  deleteRank(level: number): Promise<{ ok: true; level: string; membersMoved: number }> {
    return request<{ ok: true; level: string; membersMoved: number }>(`/api/admin/ranks/${level}`, {
      method: 'DELETE',
    });
  },

  // ---- daily quests + check-in -------------------------------------------------
  // The catalogue and the dials (migration 0020). Targets and rewards are rows, so tuning the
  // platform's daily pace is an operation rather than an app release; XP itself still only moves
  // when a gift or a check-in is recorded server-side.
  adminQuests(): Promise<AdminQuestsResult> {
    return request<AdminQuestsResult>('/api/admin/quests');
  },

  createQuest(input: QuestInput): Promise<{ quest: AdminQuest }> {
    return request<{ quest: AdminQuest }>('/api/admin/quests', { method: 'POST', body: input });
  },

  updateQuest(key: string, patch: QuestInput): Promise<{ quest: AdminQuest }> {
    return request<{ quest: AdminQuest }>(`/api/admin/quests/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: patch,
    });
  },

  deleteQuest(key: string): Promise<{ ok: true; key: string }> {
    return request<{ ok: true; key: string }>(`/api/admin/quests/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
  },

  updateQuestSettings(patch: QuestSettingsInput): Promise<{ settings: QuestSettings }> {
    return request<{ settings: QuestSettings }>('/api/admin/quests/settings', { method: 'PUT', body: patch });
  },

  // ---- withdrawals ------------------------------------------------------------------
  listWithdrawals(params: WithdrawalListQuery = {}): Promise<WithdrawalListResult> {
    return request<WithdrawalListResult>(`/api/admin/withdrawals${query({ status: params.status })}`);
  },

  reviewWithdrawal(withdrawalId: string, approve: boolean, note?: string): Promise<WithdrawalMutationResult> {
    return request<WithdrawalMutationResult>(`/api/admin/withdrawals/${withdrawalId}/review`, {
      method: 'POST',
      body: { approve, note: note && note.length > 0 ? note : undefined },
    });
  },

  /**
   * Record that the money was actually sent. The reference is required by the server and by the
   * database: it is the only thing that will answer the host who asks a month later which transfer
   * paid their request.
   */
  payWithdrawal(withdrawalId: string, payoutReference: string): Promise<WithdrawalMutationResult> {
    return request<WithdrawalMutationResult>(`/api/admin/withdrawals/${withdrawalId}/pay`, {
      method: 'POST',
      body: { payoutReference },
    });
  },

  // ---- games --------------------------------------------------------------
  adminGames(params: { gameKey?: string; status?: string; limit?: number } = {}): Promise<AdminGamesResult> {
    return request<AdminGamesResult>(
      `/api/admin/games${query({ gameKey: params.gameKey, status: params.status, limit: params.limit ?? 50 })}`,
    );
  },

  setGameRules(gameKey: string, patch: GameRulePatch): Promise<GameRulesResult> {
    return request<GameRulesResult>(`/api/admin/games/${encodeURIComponent(gameKey)}/rules`, {
      method: 'PUT',
      body: patch,
    });
  },

  gameEvents(sessionId: string, limit = 300): Promise<{ events: GameEvent[] }> {
    return request<{ events: GameEvent[] }>(
      `/api/admin/games/${encodeURIComponent(sessionId)}/events${query({ limit })}`,
    );
  },

  listDisputes(params: { status?: string; limit?: number } = {}): Promise<{ disputes: GameDispute[] }> {
    return request<{ disputes: GameDispute[] }>(
      `/api/admin/disputes${query({ status: params.status, limit: params.limit ?? 50 })}`,
    );
  },

  reviewDispute(
    disputeId: string,
    decision: 'UPHELD' | 'REJECTED' | 'REFUNDED',
    resolution: string,
  ): Promise<{ dispute: GameDispute }> {
    return request<{ dispute: GameDispute }>(`/api/admin/disputes/${disputeId}/review`, {
      method: 'POST',
      body: { decision, resolution },
    });
  },

  // ---- BD accounts and coin sellers ---------------------------------------
  businessAccounts(
    params: { kind?: string; status?: string; parentId?: string; search?: string; page?: number; limit?: number } = {},
  ): Promise<BusinessAccountListResult> {
    return request<BusinessAccountListResult>(
      `/api/admin/business/accounts${query({
        kind: params.kind,
        status: params.status,
        parentId: params.parentId,
        search: params.search,
        page: params.page ?? 1,
        limit: params.limit ?? 25,
      })}`,
    );
  },

  createBusinessAccount(body: Record<string, unknown>): Promise<{ account: BusinessAccount }> {
    return request<{ account: BusinessAccount }>('/api/admin/business/accounts', { method: 'POST', body });
  },

  updateBusinessAccount(id: string, body: Record<string, unknown>): Promise<{ account: BusinessAccount }> {
    return request<{ account: BusinessAccount }>(`/api/admin/business/accounts/${id}`, { method: 'PATCH', body });
  },

  setBusinessAccountStatus(id: string, status: string, reason?: string): Promise<{ account: BusinessAccount }> {
    return request<{ account: BusinessAccount }>(`/api/admin/business/accounts/${id}/status`, {
      method: 'POST',
      body: { status, reason },
    });
  },

  resetBusinessPassword(id: string, password: string): Promise<{ reset: boolean }> {
    return request<{ reset: boolean }>(`/api/admin/business/accounts/${id}/password`, {
      method: 'POST',
      body: { password },
    });
  },

  bdTerritory(id: string): Promise<{ sellers: BusinessAccount[] }> {
    return request<{ sellers: BusinessAccount[] }>(`/api/admin/business/accounts/${id}/sellers`);
  },

  assignSellerPackages(id: string, packageKeys: string[]): Promise<{ sellerId: string; packageKeys: string[] }> {
    return request<{ sellerId: string; packageKeys: string[] }>(`/api/admin/business/accounts/${id}/packages`, {
      method: 'PUT',
      body: { packageKeys },
    });
  },

  /** The explicit allowlist only; an empty array means "every active package", not "nothing". */
  sellerPackages(id: string): Promise<{ packageKeys: string[] }> {
    return request<{ packageKeys: string[] }>(`/api/admin/business/accounts/${id}/packages`);
  },

  // ---- the package catalog --------------------------------------------------
  rechargePackages(includeInactive = false): Promise<{ packages: RechargePackage[] }> {
    return request<{ packages: RechargePackage[] }>(
      `/api/admin/business/packages${includeInactive ? '?includeInactive=true' : ''}`,
    );
  },

  savePackage(body: {
    key: string;
    label: string;
    diamonds: number;
    amountCents: number;
    currency?: string;
    feeBps?: number;
  }): Promise<{ package: RechargePackage }> {
    return request<{ package: RechargePackage }>('/api/admin/business/packages', { method: 'PUT', body });
  },

  setPackageActive(key: string, isActive: boolean): Promise<{ package: RechargePackage }> {
    return request<{ package: RechargePackage }>(
      `/api/admin/business/packages/${encodeURIComponent(key)}/active`,
      { method: 'POST', body: { isActive } },
    );
  },

  // ---- recharge orders ------------------------------------------------------
  rechargeOrders(
    params: {
      sellerId?: string;
      bdId?: string;
      status?: string;
      search?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<RechargeOrderListResult> {
    return request<RechargeOrderListResult>(
      `/api/admin/business/recharges${query({
        sellerId: params.sellerId,
        bdId: params.bdId,
        status: params.status,
        search: params.search,
        from: params.from,
        to: params.to,
        page: params.page ?? 1,
        limit: params.limit ?? 25,
      })}`,
    );
  },

  approveRecharge(id: string, body: { decisionNote?: string; feeCents?: number }): Promise<{ order: RechargeOrder; credited: boolean }> {
    return request<{ order: RechargeOrder; credited: boolean }>(`/api/admin/business/recharges/${id}/approve`, {
      method: 'POST',
      body,
    });
  },

  rejectRecharge(id: string, reason: string): Promise<{ order: RechargeOrder }> {
    return request<{ order: RechargeOrder }>(`/api/admin/business/recharges/${id}/reject`, {
      method: 'POST',
      body: { reason },
    });
  },

  reverseRecharge(body: {
    id: string;
    reason: string;
    refundCents?: number;
    clawback?: boolean;
  }): Promise<{ order: RechargeOrder }> {
    return request<{ order: RechargeOrder }>(`/api/admin/business/recharges/${body.id}/reverse`, {
      method: 'POST',
      body: { reason: body.reason, refundCents: body.refundCents, clawback: body.clawback },
    });
  },

  sweepRechargeExpiry(): Promise<{ expired: number; orders?: string[] }> {
    return request<{ expired: number; orders?: string[] }>('/api/admin/business/recharges/sweep-expiry', {
      method: 'POST',
    });
  },

  // ---- commission -----------------------------------------------------------
  /** The roster the commission desk may attach a rate to — identity fields only. */
  partnerRoster(): Promise<{ partners: PartnerRef[] }> {
    return request<{ partners: PartnerRef[] }>('/api/admin/business/partners');
  },

  commissionRules(
    params: { beneficiary?: string; kind?: string; appliesToId?: string; includeInactive?: boolean } = {},
  ): Promise<{ rules: CommissionRule[]; kinds: CommissionRuleKind[]; beneficiaries: CommissionBeneficiary[] }> {
    return request<{ rules: CommissionRule[]; kinds: CommissionRuleKind[]; beneficiaries: CommissionBeneficiary[] }>(
      `/api/admin/business/commissions/rules${query({
        beneficiary: params.beneficiary,
        kind: params.kind,
        appliesToId: params.appliesToId,
        includeInactive: params.includeInactive ? 'true' : undefined,
      })}`,
    );
  },

  putCommissionRule(body: {
    kind: CommissionRuleKind;
    appliesToId?: string;
    percentBps?: number;
    fixedCents?: number;
    tiers?: CommissionTier[];
    minOrderCents?: number;
    maxOrderCents?: number;
    currency?: string;
    effectiveFrom?: string;
    note?: string;
  }): Promise<{ rule: CommissionRule }> {
    return request<{ rule: CommissionRule }>('/api/admin/business/commissions/rules', { method: 'PUT', body });
  },

  retireCommissionRule(id: string, reason: string): Promise<{ rule: CommissionRule }> {
    return request<{ rule: CommissionRule }>(`/api/admin/business/commissions/rules/${id}/retire`, {
      method: 'POST',
      body: { reason },
    });
  },

  commissionEntries(
    params: { beneficiaryId?: string; status?: string; from?: string; to?: string; page?: number; limit?: number } = {},
  ): Promise<{ entries: CommissionEntry[]; total: number; page: number; limit: number }> {
    return request<{ entries: CommissionEntry[]; total: number; page: number; limit: number }>(
      `/api/admin/business/commissions/entries${query({
        beneficiaryId: params.beneficiaryId,
        status: params.status,
        from: params.from,
        to: params.to,
        page: params.page ?? 1,
        limit: params.limit ?? 25,
      })}`,
    );
  },

  commissionSummary(beneficiaryId: string): Promise<{ summary: CommissionSummary }> {
    return request<{ summary: CommissionSummary }>(
      `/api/admin/business/commissions/summary/${beneficiaryId}`,
    );
  },

  commissionSettlements(
    params: { beneficiaryId?: string; status?: string; limit?: number } = {},
  ): Promise<{ settlements: CommissionSettlement[] }> {
    return request<{ settlements: CommissionSettlement[] }>(
      `/api/admin/business/commissions/settlements${query({
        beneficiaryId: params.beneficiaryId,
        status: params.status,
        limit: params.limit ?? 50,
      })}`,
    );
  },

  createCommissionSettlement(body: {
    beneficiary: 'SELLER' | 'BD';
    beneficiaryId: string;
    periodFrom: string;
    periodTo: string;
    payoutMethod?: string;
  }): Promise<{ settlement: CommissionSettlement }> {
    return request<{ settlement: CommissionSettlement }>('/api/admin/business/commissions/settlements', {
      method: 'POST',
      body,
    });
  },

  approveCommissionSettlement(id: string): Promise<{ settlement: CommissionSettlement }> {
    return request<{ settlement: CommissionSettlement }>(
      `/api/admin/business/commissions/settlements/${id}/approve`,
      { method: 'POST' },
    );
  },

  payCommissionSettlement(id: string, note?: string): Promise<{ settlement: CommissionSettlement }> {
    return request<{ settlement: CommissionSettlement }>(
      `/api/admin/business/commissions/settlements/${id}/pay`,
      { method: 'POST', body: { note } },
    );
  },

  // ---- the agency desk ------------------------------------------------------
  /**
   * Rates and payout batches for agency rosters (migration 0033).
   *
   * Reads need `finance:read`, every write here needs `commission:manage`; the server decides both on
   * each call, so this client only decides which buttons to draw. Nothing here moves a balance: the
   * accrual is written by the gift path, and `payAgencySettlement` records a transfer that already
   * happened outside the platform's rails.
   *
   * The three batch actions carry an `idempotencyKey` because a retry is not an operator mistake — it
   * is what a lost response on a slow connection looks like, and the server replays its first answer
   * rather than raising a second batch over the same accruals.
   */
  agencies(
    params: { search?: string; status?: string; page?: number; limit?: number } = {},
  ): Promise<AgencyListResult> {
    return request<AgencyListResult>(
      `/api/admin/agencies${query({
        search: params.search,
        status: params.status,
        page: params.page ?? 1,
        limit: params.limit ?? 25,
      })}`,
    );
  },

  agencyDetail(id: string): Promise<AgencyDetailResult> {
    return request<AgencyDetailResult>(`/api/admin/agencies/${encodeURIComponent(id)}`);
  },

  /** `null` is a value here, not an omission: it means "this agency takes the platform default". */
  setAgencyRate(id: string, commissionBps: number | null): Promise<{ agency: Agency }> {
    return request<{ agency: Agency }>(`/api/admin/agencies/${encodeURIComponent(id)}/rate`, {
      method: 'PUT',
      body: { commissionBps },
    });
  },

  setHostRate(id: string, hostUserId: string, commissionBps: number | null): Promise<{ host: AgencyRosterRow }> {
    return request<{ host: AgencyRosterRow }>(
      `/api/admin/agencies/${encodeURIComponent(id)}/hosts/${encodeURIComponent(hostUserId)}/rate`,
      { method: 'PUT', body: { commissionBps } },
    );
  },

  agencySettlements(
    params: { agencyId?: string; status?: string; limit?: number } = {},
  ): Promise<AgencySettlementListResult> {
    return request<AgencySettlementListResult>(
      `/api/admin/agencies/settlements${query({
        agencyId: params.agencyId,
        status: params.status,
        limit: params.limit ?? 50,
      })}`,
    );
  },

  agencySettlementEntries(id: string): Promise<AgencySettlementEntriesResult> {
    return request<AgencySettlementEntriesResult>(`/api/admin/agencies/settlements/${encodeURIComponent(id)}`);
  },

  /** Claim a period's unclaimed accruals into a DRAFT batch and freeze what it pays. */
  raiseAgencySettlement(
    agencyId: string,
    body: { periodFrom: string; periodTo: string; payoutMethod?: string | null; idempotencyKey: string },
  ): Promise<{ settlement: AgencySettlement; replay: boolean }> {
    return request<{ settlement: AgencySettlement; replay: boolean }>(
      `/api/admin/agencies/${encodeURIComponent(agencyId)}/settlements`,
      { method: 'POST', body },
    );
  },

  approveAgencySettlement(id: string): Promise<{ settlement: AgencySettlement }> {
    return request<{ settlement: AgencySettlement }>(
      `/api/admin/agencies/settlements/${encodeURIComponent(id)}/approve`,
      { method: 'POST' },
    );
  },

  payAgencySettlement(
    id: string,
    body: { payoutReference: string; payoutMethod?: string | null; note?: string | null; idempotencyKey: string },
  ): Promise<{ settlement: AgencySettlement; replay: boolean }> {
    return request<{ settlement: AgencySettlement; replay: boolean }>(
      `/api/admin/agencies/settlements/${encodeURIComponent(id)}/pay`,
      { method: 'POST', body },
    );
  },

  voidAgencySettlement(
    id: string,
    body: { reason: string; idempotencyKey: string },
  ): Promise<{ settlement: AgencySettlement; replay: boolean }> {
    return request<{ settlement: AgencySettlement; replay: boolean }>(
      `/api/admin/agencies/settlements/${encodeURIComponent(id)}/void`,
      { method: 'POST', body },
    );
  },

  // ---- the book -------------------------------------------------------------
  finAccounts(): Promise<{ accounts: FinAccount[] }> {
    return request<{ accounts: FinAccount[] }>('/api/admin/business/finance/accounts');
  },

  trialBalance(params: { from?: string; to?: string } = {}): Promise<{ trial: TrialBalance }> {
    return request<{ trial: TrialBalance }>(`/api/admin/business/finance/trial-balance${query(params)}`);
  },

  journal(
    params: { sourceKind?: string; sourceId?: string; accountCode?: string; from?: string; to?: string; page?: number; limit?: number } = {},
  ): Promise<JournalListResult> {
    return request<JournalListResult>(
      `/api/admin/business/finance/journal${query({
        sourceKind: params.sourceKind,
        sourceId: params.sourceId,
        accountCode: params.accountCode,
        from: params.from,
        to: params.to,
        page: params.page ?? 1,
        limit: params.limit ?? 25,
      })}`,
    );
  },

  reconciliation(params: { from?: string; to?: string } = {}): Promise<ReconciliationReport> {
    return request<ReconciliationReport>(`/api/admin/business/finance/reconciliation${query(params)}`);
  },

  downloadReconciliationCsv(params: { from?: string; to?: string } = {}): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 10);
    return downloadCsv(`/api/admin/business/finance/reconciliation?format=csv${query(params).replace('?', '&')}`, `voiza-reconciliation-${stamp}.csv`);
  },

  // ---- purpose accounts ------------------------------------------------------
  /**
   * The book (§8). Reads need `account:read` and writes need `account:manage`; the server decides
   * both on every call, so this client only decides which buttons to draw.
   */
  accounts(
    params: {
      category?: string;
      ownerKind?: string;
      ownerId?: string;
      status?: string;
      currency?: string;
      search?: string;
      onlyWithPosition?: boolean;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<AccountListResult> {
    return request<AccountListResult>(
      `/api/admin/accounts${query({
        category: params.category,
        ownerKind: params.ownerKind,
        ownerId: params.ownerId,
        status: params.status,
        currency: params.currency,
        search: params.search,
        onlyWithPosition: params.onlyWithPosition ? 'true' : undefined,
        page: params.page ?? 1,
        limit: params.limit ?? 25,
      })}`,
    );
  },

  account(code: string): Promise<{ account: PurposeAccount }> {
    return request<{ account: PurposeAccount }>(`/api/admin/accounts/${encodeURIComponent(code)}`);
  },

  accountMovements(
    code: string,
    params: { from?: string; to?: string; page?: number; limit?: number } = {},
  ): Promise<AccountMovementListResult> {
    return request<AccountMovementListResult>(
      `/api/admin/accounts/${encodeURIComponent(code)}/movements${query({
        from: params.from,
        to: params.to,
        page: params.page ?? 1,
        limit: params.limit ?? 25,
      })}`,
    );
  },

  accountHolds(
    params: { accountCode?: string; status?: string; page?: number; limit?: number } = {},
  ): Promise<AccountHoldListResult> {
    const path = params.accountCode
      ? `/api/admin/accounts/${encodeURIComponent(params.accountCode)}/holds`
      : '/api/admin/accounts/holds';
    return request<AccountHoldListResult>(
      `${path}${query({ status: params.status, page: params.page ?? 1, limit: params.limit ?? 25 })}`,
    );
  },

  /**
   * `idempotencyKey` is generated per click, not per form: the server replays a key it has already
   * answered for, so a retry after a lost response cannot freeze the same money twice.
   */
  createAccountHold(
    code: string,
    body: { kind: HoldKind; amount: number; reason: string; idempotencyKey: string },
  ): Promise<{ hold: AccountHold; replay: boolean }> {
    return request<{ hold: AccountHold; replay: boolean }>(
      `/api/admin/accounts/${encodeURIComponent(code)}/holds`,
      { method: 'POST', body },
    );
  },

  releaseAccountHold(
    id: string,
    body: { convertTo?: string | null; idempotencyKey: string },
  ): Promise<{ id: string; status: string; replay: boolean }> {
    return request<{ id: string; status: string; replay: boolean }>(
      `/api/admin/holds/${encodeURIComponent(id)}/release`,
      { method: 'POST', body },
    );
  },

  setAccountStatus(
    code: string,
    body: { status: AccountStatus; reason?: string },
  ): Promise<PurposeAccount> {
    return request<PurposeAccount>(`/api/admin/accounts/${encodeURIComponent(code)}/status`, {
      method: 'POST',
      body,
    });
  },

  accountReconciliation(): Promise<AccountReconciliation> {
    return request<AccountReconciliation>('/api/admin/accounts/reconcile');
  },

  /** A statement is one page at most (200 rows), so an export carries the page being looked at. */
  downloadAccountStatement(
    code: string,
    format: 'csv' | 'xlsx',
    params: { from?: string; to?: string; limit?: number } = {},
  ): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = `/api/admin/accounts/${encodeURIComponent(code)}/movements?format=${format}&limit=${params.limit ?? 200}${query({ from: params.from, to: params.to }).replace('?', '&')}`;
    return downloadFile(path, `voiza-${code.replace(/[^A-Za-z0-9]/g, '-')}-statement-${stamp}.${format}`, EXPORT_TYPES[format]);
  },

  downloadAccountReconciliation(format: 'csv' | 'xlsx'): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 10);
    return downloadFile(
      `/api/admin/accounts/reconcile?format=${format}`,
      `voiza-account-reconciliation-${stamp}.${format}`,
      EXPORT_TYPES[format],
    );
  },

  // ---- the operator roster --------------------------------------------------
  /**
   * Who may sign into this panel (migration 0030). Everything here needs `operator:manage`, which
   * only SUPER_ADMIN holds, so a finance operator sees the page exist and nothing in it.
   *
   * There is no delete call and there never will be: an operator who has written an audit row
   * cannot be removed at all — the database refuses it — so the lifecycle is disable and enable.
   */
  operators(
    params: { search?: string; role?: string; active?: string; page?: number; limit?: number } = {},
  ): Promise<OperatorListResult> {
    return request<OperatorListResult>(
      `/api/admin/operators${query({
        search: params.search,
        role: params.role,
        active: params.active,
        page: params.page ?? 1,
        limit: params.limit ?? 25,
      })}`,
    );
  },

  /** The roles and the permissions each one carries, read from the table the guards use. */
  operatorRoles(): Promise<{ roles: OperatorRoleInfo[] }> {
    return request<{ roles: OperatorRoleInfo[] }>('/api/admin/operators/roles');
  },

  createOperator(body: {
    username: string;
    password: string;
    role: string;
    displayName?: string;
  }): Promise<{ operator: Operator }> {
    return request<{ operator: Operator }>('/api/admin/operators', { method: 'POST', body });
  },

  updateOperator(id: string, body: { role?: string; displayName?: string }): Promise<{ operator: Operator }> {
    return request<{ operator: Operator }>(`/api/admin/operators/${id}`, { method: 'PUT', body });
  },

  /** A reason of at least 8 characters is what makes a disable a decision rather than a click. */
  disableOperator(id: string, reason: string): Promise<{ operator: Operator }> {
    return request<{ operator: Operator }>(`/api/admin/operators/${id}/disable`, {
      method: 'POST',
      body: { reason },
    });
  },

  enableOperator(id: string): Promise<{ operator: Operator }> {
    return request<{ operator: Operator }>(`/api/admin/operators/${id}/enable`, { method: 'POST', body: {} });
  },

  // ---- the switches ---------------------------------------------------------
  /** The stored JSON is an object of unknown shape; each page narrows it where it reads it. */
  readConfig<T extends object>(key: string): Promise<{ key: string; value: T }> {
    return request<{ key: string; value: T }>(`/api/admin/business/config/${encodeURIComponent(key)}`);
  },

  writeConfig(key: string, value: Record<string, unknown>): Promise<{ key: string; value: Record<string, unknown>; updatedAt: string }> {
    return request<{ key: string; value: Record<string, unknown>; updatedAt: string }>(
      `/api/admin/business/config/${encodeURIComponent(key)}`,
      { method: 'PUT', body: { value } },
    );
  },

  // ---- audit ----------------------------------------------------------------
  audit(
    params: {
      limit?: number;
      targetType?: string;
      businessId?: string;
      adminId?: string;
      actorKind?: 'admin' | 'business' | 'system';
    } = {},
  ): Promise<{ entries: AuditEntry[] }> {
    return request<{ entries: AuditEntry[] }>(
      `/api/admin/audit${query({
        limit: params.limit ?? 100,
        targetType: params.targetType,
        businessId: params.businessId,
        adminId: params.adminId,
        actorKind: params.actorKind,
      })}`,
    );
  },
};
