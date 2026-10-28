// ---------------------------------------------------------------------------
// Typed fetch wrapper for the Voiza admin API.
// - injects `Authorization: Bearer <jwt>` from localStorage
// - parses JSON, throws a typed ApiError carrying the server message
// - on 401 clears the session and bounces the browser to /login
//   (except on the login call itself, where the error is surfaced inline)
// ---------------------------------------------------------------------------
import type {
  AdminEmoji,
  AdminGamesResult,
  AdminIdentity,
  AdminRank,
  AdminRoomTheme,
  AdminStats,
  AuditEntry,
  BalanceAdjustResult,
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
  GiftInput,
  GiftListResult,
  GiftMutationResult,
  GiftPatch,
  GrantedItem,
  JournalListResult,
  LoginResponse,
  MediaAsset,
  MediaKind,
  OkResult,
  ProfileFrame,
  PublishedEmojiCatalogue,
  PublishedLadder,
  RankInput,
  RechargeOrder,
  RechargeOrderListResult,
  RechargePackage,
  ReconciliationReport,
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

/** Error carrying the HTTP status plus the server-provided message. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
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

function extractMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const nested = record.error;
    if (typeof nested === 'object' && nested !== null) {
      const msg = (nested as Record<string, unknown>).message;
      if (typeof msg === 'string' && msg.length > 0) return msg;
    }
    if (typeof nested === 'string' && nested.length > 0) return nested;
    if (typeof record.message === 'string' && record.message.length > 0) return record.message;
  }
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
    if (response.status === 401 && auth && !noRedirect) {
      setToken(null);
      setStoredAdmin(null);
      if (window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    }
    throw new ApiError(response.status, extractMessage(payload, response.status));
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
  const headers: Record<string, string> = { Accept: 'text/csv' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, { headers });
  } catch {
    throw new ApiError(0, `Network error: cannot reach the Voiza backend at ${apiBase()}.`);
  }
  if (!response.ok) throw new ApiError(response.status, extractMessage(null, response.status));

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

  // ---- gifts ---------------------------------------------------------------------
  listGifts(): Promise<GiftListResult> {
    return request<GiftListResult>('/api/admin/gifts');
  },

  createGift(input: GiftInput): Promise<GiftMutationResult> {
    return request<GiftMutationResult>('/api/admin/gifts', { method: 'POST', body: input });
  },

  updateGift(giftId: string, patch: GiftPatch): Promise<GiftMutationResult> {
    return request<GiftMutationResult>(`/api/admin/gifts/${giftId}`, { method: 'PUT', body: patch });
  },

  deleteGift(giftId: string): Promise<OkResult> {
    return request<OkResult>(`/api/admin/gifts/${giftId}`, { method: 'DELETE' });
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
