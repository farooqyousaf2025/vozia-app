// ---------------------------------------------------------------------------
// Voiza Admin Panel — API contract DTOs
// Field names mirror the backend's camelCase JSON (columns mirror the snake_case
// Postgres schema in backend/database/schema.sql).
// ---------------------------------------------------------------------------

// ---- Enums (Postgres enum labels) -----------------------------------------
export type UserType = 'HOST' | 'USER' | 'AGENCY_ADMIN';
export type UserStatus = 'ACTIVE' | 'BANNED';
export type RoomType = 'PUBLIC' | 'PRIVATE';
export type RoomStatus = 'ACTIVE' | 'CLOSED';
export type RoomCategory = 'POPULAR' | 'PARTY' | 'MUSIC' | 'GAME' | 'CHAT';
export type SeatStatus = 'EMPTY' | 'OCCUPIED' | 'LOCKED';
export type ParticipantRole = 'HOST' | 'SPEAKER' | 'AUDIENCE';
export type WithdrawalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAID';

/**
 * How loud a gift plays in the room: `TICKER` scrolls it down the side column,
 * `FULLSCREEN` takes over the screen. Clients fall back to `TICKER` for anything
 * they do not recognise, so an unset tier is the quiet one.
 */
export type GiftEffectKind = 'TICKER' | 'FULLSCREEN';

/**
 * Which renderer the phone hands the file to: `LOTTIE` for the vector scenes the app already
 * plays, `SVGA` and `MP4` for the two file types an operator uploads as richer animations. The
 * format is what the upload guard matched against the bytes, so picking one here commits to
 * having uploaded a file of that container into the animation slot.
 */
export type GiftAnimationFormat = 'LOTTIE' | 'SVGA' | 'MP4';

// ---- Auth ------------------------------------------------------------------
/**
 * The capabilities this operator holds, as the backend sees them. The panel uses them only to
 * decide which pages to show; every route is authorised again server-side from the database row,
 * so a stale list here can hide a page but never grant an action.
 */
export type AdminPermission = string;

export interface AdminIdentity {
  id: string;
  username: string;
  displayName: string;
  role: string; // 'SUPER_ADMIN' | 'FINANCE_ADMIN' | 'OPERATIONS_ADMIN' | 'MODERATOR'
  permissions?: AdminPermission[];
}

export interface LoginResponse {
  token: string;
  admin: AdminIdentity;
  permissions?: AdminPermission[];
}

// ---- Overview / stats ------------------------------------------------------
export interface StatsSeriesPoint {
  date: string; // ISO date (YYYY-MM-DD)
  diamonds: number;
  rooms: number;
}

export interface AdminStats {
  activeRooms: number;
  onlineUsers: number;
  totalUsers: number;
  newUsersToday: number;
  diamondsSpentToday: number;
  rCoinsIssuedToday: number;
  giftsSentToday: number;
  withdrawalsPending: number;
  series: StatsSeriesPoint[];
}

// ---- Users -----------------------------------------------------------------
export interface UserRow {
  id: string;
  phone: string;
  username: string;
  avatarUrl: string | null;
  userType: UserType;
  status: UserStatus;
  diamondBalance: number;
  rCoinBalance: number;
  totalGiftsSent: number;
  totalGiftsReceived: number;
  isVerified: boolean;
  /** Gift spend tier; 0 is the default unranked account. */
  vipLevel: number;
  /**
   * Earned experience and the rung it resolves to (`rank_levels`, migration 0017). `rank` is what a
   * phone paints; `nextRank` is null at the top of the ladder.
   */
  xp: number;
  rank: RankRung;
  nextRank: { level: number; name: string; remainingXp: number } | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface UserListResult {
  users: UserRow[];
  total: number;
  page: number;
  limit: number;
}

/** Ledger entry returned after an admin balance adjustment (transactions table). */
export interface LedgerTransaction {
  id: string;
  type: string; // transaction_type enum, e.g. 'ADMIN_ADJUSTMENT'
  status: string; // transaction_status enum
  senderId: string | null;
  receiverId: string | null;
  amountDiamonds: number;
  amountRCoins: number;
  note?: string | null;
  createdAt?: string;
}

export interface BalanceAdjustResult {
  user: UserRow;
  transaction: LedgerTransaction;
}

export interface UserMutationResult {
  user: UserRow;
}

// ---- Rooms -----------------------------------------------------------------
export interface RoomHostSummary {
  id: string;
  username: string;
  avatarUrl: string | null;
}

/**
 * A seat/audience occupant shown in the Room Monitor drawer.
 * `GET /api/admin/rooms` documents room + host + aggregate counters; the roster
 * fields below are consumed opportunistically when the backend chooses to
 * include them (the drawer degrades gracefully when they are absent).
 */
export interface RoomOccupant {
  userId: string;
  username: string;
  avatarUrl?: string | null;
  seatIndex?: number | null;
  role?: ParticipantRole;
  handRaised?: boolean;
}

export interface AdminRoom {
  id: string;
  roomNumber: number;
  title: string;
  description?: string | null;
  coverUrl?: string | null;
  theme: string;
  type: RoomType;
  seatCapacity: number;
  status: RoomStatus;
  category: RoomCategory;
  listenerCount: number;
  totalGiftValue: number;
  createdAt: string;
  closedAt?: string | null;
  host: RoomHostSummary;
  onlineSeatCount: number;
  seats?: RoomOccupant[];
  audience?: RoomOccupant[];
}

export interface RoomListResult {
  rooms: AdminRoom[];
}

export interface RoomMutationResult {
  room: AdminRoom;
}

/**
 * The administrator-owned seat policy (GET/PUT /api/admin/rooms/seat-policy).
 * Counts are speaker seats; a room holds one more seat than that, because seat 0 is the host.
 */
export interface SeatPolicyResult {
  speakerSeats: number;
  maxSpeakerSeats: number;
  seatCapacity: { min: number; default: number; max: number };
  /** On the read: the absolute ceiling the schema will accept. */
  ceiling?: number;
  /** On the write: when the row changed. */
  updatedAt?: string;
}

// ---- Room ops console (GET /api/admin/rooms/:id) ---------------------------
export type ChatMessageType = 'TEXT' | 'GIFT' | 'SYSTEM';

/** Seat-index-aligned grid; `user` is null for EMPTY and LOCKED seats. */
export interface RoomSeatDetail {
  seatIndex: number;
  status: SeatStatus;
  isMuted: boolean;
  isSpeaker: boolean;
  user: { id: string; username: string; avatarUrl?: string | null } | null;
}

export interface RoomChatMessage {
  id: string;
  roomId: string;
  user: { id: string; username: string; avatarUrl?: string | null } | null;
  content: string;
  type: ChatMessageType;
  createdAt: string;
}

export interface RoomBan {
  userId: string;
  username: string;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface RoomMetrics {
  liveSeats: number;
  mutedSeats: number;
  audienceCount: number;
  handRaiseCount: number;
  /** Count from the SFU itself; null when the LiveKit API was unreachable. */
  sfuParticipants: number | null;
  giftsToday: number;
  diamondsToday: number;
  rCoinsToday: number;
  chatLast5m: number;
  topSender: { username: string; diamonds: number } | null;
}

export interface ConsoleRoom {
  id: string;
  roomNumber: number;
  title: string;
  description?: string | null;
  coverUrl?: string | null;
  theme: string;
  type: RoomType;
  seatCapacity: number;
  status: RoomStatus;
  category: RoomCategory;
  listenerCount: number;
  totalGiftValue: number;
  livekitRoomName: string;
  createdAt: string;
  closedAt?: string | null;
  /** Pinned notice the host set (migration 0022); null when none is pinned. */
  announcement?: string | null;
  announcementUpdatedAt?: string | null;
  speakerApprovalRequired?: boolean;
  host: { id: string; username: string; avatarUrl?: string | null };
}

export interface RoomConsoleResult {
  room: ConsoleRoom;
  seats: RoomSeatDetail[];
  audience: RoomOccupant[];
  handRaises: RoomOccupant[];
  chat: RoomChatMessage[];
  bans: RoomBan[];
  metrics: RoomMetrics;
  listenerCount: number;
}

/** A room skin: wallpaper + accent the app paints behind the seat grid. */
export interface RoomTheme {
  slug: string;
  name: string;
  accent: string;
  wallpaper: string;
}

export interface ThemeCatalogue {
  themes: RoomTheme[];
  defaultTheme: string;
  /** null when the operator has removed every welcome flourish; the app then plays nothing. */
  welcome: string | null;
  effects: string[];
}

/** The operator view of one theme: what `/api/rooms/themes` publishes, plus the wiring. */
export interface AdminRoomTheme extends RoomTheme {
  isDefault: boolean;
  sortOrder: number;
  /** Rooms still carrying this slug. Deleting the theme leaves them on the default look. */
  roomsUsing: number;
  /** 0 when the theme is free for every host; a host must own a paid theme before a room wears it. */
  priceDiamonds: number;
  forSale: boolean;
  /** Rental length in days; null means a purchase never expires. */
  periodDays: number | null;
  /** Lowest `users.vip_level` allowed to buy this theme; 0 leaves it open to everyone. */
  minVipLevel: number;
  /** Editorial flag: the member's store lists recommended rows first and badges them. */
  recommended: boolean;
}

export type VisualEffectKind = 'AMBIENT' | 'WELCOME';

export interface VisualEffect {
  key: string;
  kind: VisualEffectKind;
  name: string;
  url: string;
  sortOrder: number;
  /** Room categories that play this loop; empty for a welcome flourish. */
  usedByCategories: string[];
  /** Only a WELCOME effect can be sold: an ambient loop belongs to a room category. */
  priceDiamonds: number;
  forSale: boolean;
  periodDays: number | null;
  /** Lowest `users.vip_level` allowed to buy this flourish; 0 leaves it open to everyone. */
  minVipLevel: number;
  /** Editorial flag: the member's store lists recommended rows first and badges them. */
  recommended: boolean;
}

/**
 * An avatar ring (migration 0019). `art` is a transparent PNG drawn over the avatar, and `holders`
 * is how many receipts name this key — the number an operator sees before retiring it.
 */
export interface ProfileFrame {
  key: string;
  name: string;
  art: string;
  accent: string;
  sortOrder: number;
  priceDiamonds: number;
  forSale: boolean;
  periodDays: number | null;
  /** Lowest `users.vip_level` allowed to buy this ring; 0 leaves it open to everyone. */
  minVipLevel: number;
  /** Editorial flag: the member's store lists recommended rows first and badges them. */
  recommended: boolean;
  holders: number;
}

export interface CategoryEffect {
  category: string;
  effectKey: string;
  name: string | null;
  url: string | null;
}

/**
 * Which renderer a device hands an entrance ride to — the same three the gift engine routes on, and
 * the only values the `RIDE` upload policy accepts.
 */
export type ProfileRideFormat = 'LOTTIE' | 'SVGA' | 'MP4';

/**
 * An entrance ride (migration 0026): the full-screen cinematic the whole room watches while a member
 * joins. Sold and worn exactly like a frame, but its row also says how the file opens and for how long
 * the room hands it the screen.
 */
export interface ProfileRide {
  key: string;
  name: string;
  /** Root-relative or `https://` URL of the Lottie, SVGA or MP4 asset. */
  url: string;
  format: ProfileRideFormat;
  /** `0` plays the asset for its own length; anything else is 250–30000 ms of screen time. */
  durationMs: number;
  sortOrder: number;
  priceDiamonds: number;
  forSale: boolean;
  /** Rental length in days; null means a purchase never expires. */
  periodDays: number | null;
  /** Lowest `users.vip_level` allowed to buy this ride; 0 leaves it open to everyone. */
  minVipLevel: number;
  /** Editorial flag: the member's store lists recommended rows first and badges them. */
  recommended: boolean;
  /** Receipts naming this key — the number an operator sees before retiring it. */
  holders: number;
}

/**
 * Body of POST/PUT /api/admin/rides. A create needs `key`, `name` and `url`; server-side a missing
 * `format` is LOTTIE and a missing `durationMs` is 0. `holders` is read-only. On an update a `key`
 * that differs from the path is refused (`ride_key_immutable`), so the panel only sends it on create.
 */
export interface RideInput {
  key?: string;
  name?: string;
  url?: string;
  format?: ProfileRideFormat;
  durationMs?: number;
  sortOrder?: number;
  priceDiamonds?: number;
  forSale?: boolean;
  /** `null` makes a purchase permanent; omitting it on an update keeps the current period. */
  periodDays?: number | null;
  /** 0–20; omitting it on an update keeps the current gate. */
  minVipLevel?: number;
  /** Omitting it on an update keeps the current flag. */
  recommended?: boolean;
}

/** "Who owns this ride": the fourth catalogue reports the same receipt shape as frames. */
export type RideHolder = FrameHolder;

export interface DecorCatalogue {
  themes: AdminRoomTheme[];
  effects: VisualEffect[];
  categoryEffects: CategoryEffect[];
  frames: ProfileFrame[];
  /** Entrance rides (migration 0026), sorted the way the server publishes them. */
  rides: ProfileRide[];
}

/** Body of POST/PUT /api/admin/themes — `wallpaperUrl`, not `wallpaper`: the row's column name. */
export interface ThemeInput {
  slug?: string;
  name?: string;
  accent?: string;
  wallpaperUrl?: string;
  isDefault?: boolean;
  sortOrder?: number;
  priceDiamonds?: number;
  forSale?: boolean;
  /** `null` makes a purchase permanent; omitting it on an update keeps the current period. */
  periodDays?: number | null;
  /** 0–20; omitting it on an update keeps the current gate. */
  minVipLevel?: number;
  /** Omitting it on an update keeps the current flag. */
  recommended?: boolean;
}

export interface EffectInput {
  key?: string;
  kind?: VisualEffectKind;
  name?: string;
  url?: string;
  sortOrder?: number;
  priceDiamonds?: number;
  forSale?: boolean;
  periodDays?: number | null;
  /** 0–20; omitting it on an update keeps the current gate. */
  minVipLevel?: number;
  /** Omitting it on an update keeps the current flag. */
  recommended?: boolean;
}

export interface FrameInput {
  key?: string;
  name?: string;
  artUrl?: string;
  accent?: string;
  sortOrder?: number;
  priceDiamonds?: number;
  forSale?: boolean;
  periodDays?: number | null;
  /** 0–20; omitting it on an update keeps the current gate. */
  minVipLevel?: number;
  /** Omitting it on an update keeps the current flag. */
  recommended?: boolean;
}

/** The three catalogues a member can buy from, as `/api/admin/users/:id/grant` names them. */
export type StoreItemKind = 'FRAME' | 'THEME' | 'EFFECT';

/** One row of "who holds this ring", including the door it came through. */
export interface FrameHolder {
  userId: string;
  username: string;
  acquiredVia: 'PURCHASE' | 'ADMIN_GRANT';
  expiresAt: string | null;
  createdAt: string;
}

/** What a member asked about it sees — what a grant answers with. */
export interface GrantedItem {
  kind: StoreItemKind;
  key: string;
  name: string;
  art: string;
  accent: string | null;
  priceDiamonds: number;
  periodDays: number | null;
  owned: boolean;
  expiresAt: string | null;
  equipped: boolean;
}

/**
 * One chat emoji (`emoji_characters`, migration 0016).
 *
 * `code` is derived by the server from `key` and is what a member types; a chat message stores that
 * token, never this URL, so retiring a row cannot rewrite history.
 */
export interface EmojiOption {
  key: string;
  label: string;
  code: string;
  url: string;
}

export interface AdminEmoji extends EmojiOption {
  sortOrder: number;
}

/** What `GET /api/emoji` hands to phones: the codes plus the expression a client matches with. */
export interface PublishedEmojiCatalogue {
  codePattern: string;
  emojis: EmojiOption[];
}

/** Body of POST/PUT /api/admin/emoji. `key` is immutable once a message carries it. */
export interface EmojiInput {
  key?: string;
  label?: string;
  url?: string;
  sortOrder?: number;
}

/**
 * One rung of the earned-level ladder (`rank_levels`, migration 0017).
 *
 * `badge` is the URL a phone loads; `minXp` is the floor the rung is reached at. This ladder is
 * separate from `vipLevel`, which an operator sets by hand and which gates gifts — a member earns
 * a rung here by spending and receiving coins, and no client can write it.
 */
export interface RankRung {
  level: number;
  name: string;
  badge: string;
  accent: string;
  minXp: number;
}

export interface AdminRank extends RankRung {
  isActive: boolean;
  /** Accounts resolving to this rung right now — what a delete or a move would shift. */
  membersOnRung: number;
}

/** What `GET /api/ranks` hands to phones: only the live rungs, cheapest floor first. */
export interface PublishedLadder {
  maxLevel: number;
  xpRules: { perDiamondSpent: number; perRCoinEarned: number };
  levels: RankRung[];
}

/** Body of POST/PUT /api/admin/ranks. `level` is only accepted on create. */
export interface RankInput {
  level?: number;
  name?: string;
  badgeUrl?: string;
  accent?: string;
  minXp?: number;
  isActive?: boolean;
}

// ---- Daily quests + check-in (migration 0020) --------------------------------
/** What a quest counts. Each one is a server-side event, never a client claim. */
export type QuestMetric = 'GIFT_SENT' | 'DIAMONDS_SPENT' | 'CHAT_MESSAGE';

/** Platform-wide dials: when the day resets, and how much a check-in pays. */
export interface QuestSettings {
  resetTimezone: string;
  checkinBaseXp: number;
  checkinStreakStepXp: number;
  checkinMaxStreakDays: number;
}

/** One row of the daily catalogue, with today's completion count for the operator. */
export interface AdminQuest {
  key: string;
  title: string;
  description: string;
  metric: QuestMetric;
  target: number;
  xpReward: number;
  isActive: boolean;
  sortOrder: number;
  /** Members who finished it today — the number to watch after re-tuning a target. */
  completedToday: number;
}

export interface AdminQuestsResult {
  /** The local date the counts are for, in `settings.resetTimezone`. */
  today: string;
  settings: QuestSettings;
  quests: AdminQuest[];
}

/** Body of POST /api/admin/quests — `key` is required only on create. */
export interface QuestInput {
  key?: string;
  title?: string;
  description?: string;
  metric?: QuestMetric;
  target?: number;
  xpReward?: number;
  isActive?: boolean;
  sortOrder?: number;
}

export type QuestSettingsInput = Partial<QuestSettings>;

/** Payloads the admin socket channel pushes to the console. */
export interface SocketSeatUpdate {
  roomId: string;
  seats: RoomSeatDetail[];
  audience: Array<{ id: string; username: string; avatarUrl?: string | null }>;
}

export interface SocketThemeChanged {
  roomId: string;
  theme: string;
}

export interface OkResult {
  ok: boolean;
}

// ---- Gifts (virtual store) --------------------------------------------------
/**
 * One prize of a lucky gift box (migration 0027), as the operator's catalogue serves it.
 *
 * `chanceBps` is this row's weight against the box's total, in ten-thousandths — the number a phone
 * prints. `weight` is the raw figure behind it and arrives only on the admin route: the member-facing
 * `GET /api/gifts` omits it, because a device that could edit the weights could edit the payout.
 */
export interface BoxOutcomeDto {
  label: string;
  /** What the prize pays, as ten-thousandths of the gift's R-coin value: 25000 is ×2.5. */
  multiplierBps: number;
  chanceBps: number;
  weight?: number;
}

/** One prize in a write body — the same row with the odds left out, since the weights are the input. */
export interface BoxOutcomeInput {
  label: string;
  multiplierBps: number;
  weight: number;
}

export interface Gift {
  id: string;
  name: string;
  iconUrl: string;
  animationUrl: string | null;
  soundUrl: string | null;
  diamondPrice: number;
  rCoinValue: number;
  /** A `gift_categories.key`. The set is rows an operator owns, so nothing here enumerates it. */
  category: string;
  effectKind: GiftEffectKind | string;
  /** Which renderer plays `animationUrl`, and how long the room hands the screen to it. */
  animationFormat: GiftAnimationFormat | string;
  durationMs: number;
  displayPriority: number;
  comboEnabled: boolean;
  comboWindowMs: number;
  minVipLevel: number;
  sortOrder: number;
  isActive: boolean;
  /** True when sending this gift rolls `boxOutcomes` instead of paying `rCoinValue` flat. */
  isLuckyBox: boolean;
  /**
   * The receiver's share of the rolled pool, in ten-thousandths. Present only on a box — a flat gift
   * carries neither this nor `boxOutcomes` at all, which is how a reader tells "no odds" from
   * "a box whose odds were never configured".
   */
  receiverShareBps?: number;
  /** The box's prize table, weights included; the draw walks it in this order. */
  boxOutcomes?: BoxOutcomeDto[];
}

/**
 * Body for POST /api/admin/gifts.
 *
 * The playback fields are optional because the backend defaults them: a gift created without them
 * is a Lottie ticker, 0 ms, priority 0, no combo. Omitting them is only safe for the shipped
 * vector art — an uploaded `.svga` or `.mp4` needs `animationFormat` set, or the phone is told to
 * open a video with the Lottie player.
 *
 * The box keys are optional for the same reason, and absent means something different for each:
 * no `isLuckyBox` is a flat gift, no `boxOutcomes` on an update means "leave the prize table I
 * already saved exactly as it is", while `boxOutcomes: []` is an explicit answer the server refuses.
 */
export interface GiftInput {
  name: string;
  iconUrl: string;
  animationUrl: string | null;
  soundUrl: string | null;
  diamondPrice: number;
  rCoinValue: number;
  category: string;
  effectKind: string;
  animationFormat?: string;
  durationMs?: number;
  displayPriority?: number;
  comboEnabled?: boolean;
  comboWindowMs?: number;
  minVipLevel: number;
  sortOrder: number;
  isActive: boolean;
  isLuckyBox?: boolean;
  /** 0..10000 ten-thousandths of the rolled pool the receiver banks; the box keeps the rest. */
  receiverShareBps?: number;
  /** The whole table, never a patch: sending it replaces every prize the box had. */
  boxOutcomes?: BoxOutcomeInput[];
}

/**
 * Body for PUT /api/admin/gifts/:id — partial update; keys left out are left alone. There is no
 * PATCH on this resource (it 404s), and `boxOutcomes` is deliberately absent-or-whole: omitting it
 * keeps the stored draw, sending `[]` is a refusal rather than an empty table.
 */
export type GiftPatch = Partial<GiftInput>;

export interface GiftListResult {
  gifts: Gift[];
}

export interface GiftMutationResult {
  gift: Gift;
}

// ---- Gift categories (migration 0025) ---------------------------------------
/**
 * One shelf of the gift panel. `key` is what a gift row stores and what the phone files gifts
 * under, so it never changes — a rename is an edit to `name`, the tab label. `sortOrder` is the tab
 * order the phone follows. `gifts` counts rows filed here: a zero-gift shelf is a tab that opens on
 * nothing, and a shelf holding gifts cannot be deleted.
 */
export interface GiftCategoryRow {
  key: string;
  name: string;
  sortOrder: number;
  gifts: number;
}

/** Body of POST /api/admin/gift-categories. The server upper-cases `key`; legal shape is `^[A-Z0-9][A-Z0-9_]{1,23}$`. */
export interface GiftCategoryInput {
  key: string;
  name: string;
  sortOrder: number;
}

/** Body of PUT /api/admin/gift-categories/:key. A different `key` in here is refused, not applied. */
export interface GiftCategoryPatch {
  name?: string;
  sortOrder?: number;
}

export interface GiftCategoryListResult {
  /** Already sorted by `sortOrder` ascending. */
  categories: GiftCategoryRow[];
}

export interface GiftCategoryMutationResult {
  category: GiftCategoryRow;
}

// ---- Gift analytics ----------------------------------------------------------
/**
 * One gift's earnings over the window, read from the ledger rather than from the catalogue row:
 * the row says what a gift costs, this says what it earned.
 */
export interface GiftAnalyticsRow {
  giftId: string;
  name: string;
  iconUrl: string;
  category: string;
  /** Taps of the send button, i.e. ledger rows — a combo of ten Roses is one send. */
  sends: number;
  /** Individual gifts, which is `quantity` summed. */
  gifts: number;
  /** Diamonds the senders spent. */
  diamonds: number;
  /** R-coins the receivers earned. */
  rCoins: number;
  senders: number;
  averageDiamonds: number;
  /**
   * Whether this gift is a lucky box. It is on the row because a box's `rCoins` are what a draw paid
   * out, not its price list: `rCoins / diamonds` is the realised payout rate, and on a flat gift that
   * ratio is the catalogue's own margin while on a box it is the outcome the odds actually produced.
   */
  isLuckyBox: boolean;
}

export interface GiftAnalyticsTotals {
  sends: number;
  gifts: number;
  diamonds: number;
  rCoins: number;
  averageDiamondPerGift: number;
  /**
   * Window spend on gifts since retired from the catalogue (`transactions.gift_id` is
   * `ON DELETE SET NULL`), so it is in `totals` but on no visible row — the rows will not sum to
   * the totals, and this is the difference.
   */
  unattributedDiamonds: number;
}

export interface GiftAnalyticsResult {
  days: number;
  totals: GiftAnalyticsTotals;
  /** Diamonds descending, capped at 100 rows. */
  gifts: GiftAnalyticsRow[];
}

// ---- Withdrawals -------------------------------------------------------------
/** Compact account view the withdrawals endpoints return alongside a request. */
export interface WithdrawalUser {
  id: string;
  username: string;
  avatarUrl: string | null;
  phone: string;
  rCoinBalance: number;
  userType: string;
  status: string;
}

export interface WithdrawalRow {
  id: string;
  user: WithdrawalUser;
  amountRCoins: number;
  status: WithdrawalStatus;
  payoutMethod: string; // e.g. 'BANK'
  payoutDetails: Record<string, unknown>;
  createdAt: string;
}

export interface WithdrawalListResult {
  withdrawals: WithdrawalRow[];
}

export interface WithdrawalMutationResult {
  withdrawal: WithdrawalRow;
}

// ---- Query parameter shapes ---------------------------------------------------
export interface UserListQuery {
  search?: string;
  status?: UserStatus | '';
  userType?: UserType | '';
  page?: number;
  limit?: number;
}

export interface RoomListQuery {
  status?: RoomStatus | '';
  search?: string;
}

export interface WithdrawalListQuery {
  status?: WithdrawalStatus | '';
}

// ---------------------------------------------------------------------------
// Games (§7, §8) — the catalogue, the versioned rules, the matches and disputes.
// ---------------------------------------------------------------------------
export type GameSessionStatus = 'WAITING' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'DISPUTED';
export type GameSettlementStatus = 'PENDING' | 'SETTLED' | 'PARTIAL' | 'REFUNDED' | 'DISPUTED';
export type GameRefundPolicy = 'NONE' | 'CANCELLED' | 'DISPUTED' | 'ALWAYS';

export interface GameDefinition {
  key: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  minPlayers: number;
  maxPlayers: number;
  allowSpectators: boolean;
  turnTimeoutSeconds: number;
  isActive: boolean;
  entryFeeEnabled: boolean;
  entryFeeDiamonds: number;
  entryFeeMin: number;
  entryFeeMax: number;
  prizeEnabled: boolean;
  commissionBps: number;
  refundPolicy: GameRefundPolicy;
  dailyEntryLimit: number;
  rulesVersion: number;
  prizeRules: Array<{ rank: number; shareBps: number }>;
  promoFreeEntry: boolean;
  promoUntil: string | null;
}

export interface GameParticipant {
  userId: string;
  username: string;
  avatarUrl: string | null;
  position: number;
  status: string;
  score: number;
  rank: number | null;
  entryFeeDiamonds: number;
  prizeDiamonds: number;
  ready: boolean;
}

export interface GameSession {
  id: string;
  gameKey: string;
  roomId: string | null;
  createdBy: string;
  status: GameSessionStatus;
  settlementStatus: GameSettlementStatus;
  rulesVersion: number;
  state: unknown;
  entryFeeDiamonds: number;
  maxPlayers: number;
  turnOwnerId: string | null;
  turnDeadlineAt: string | null;
  result: Record<string, unknown> | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  participants: GameParticipant[];
}

export interface GameEvent {
  seq: number;
  type: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface GameDispute {
  id: string;
  sessionId: string;
  reason: string;
  status: string;
  resolution: string | null;
  createdAt: string;
  reviewedAt: string | null;
  raisedBy: { id: string; username: string; avatarUrl: string | null };
}

/** Body for PUT /api/admin/games/:key/rules. Money switches need `confirmCompliance`. */
export interface GameRulePatch {
  isActive?: boolean;
  entryFeeEnabled?: boolean;
  entryFeeDiamonds?: number;
  entryFeeMin?: number;
  entryFeeMax?: number;
  prizeEnabled?: boolean;
  commissionBps?: number;
  prizeRules?: Array<{ rank: number; shareBps: number }>;
  refundPolicy?: GameRefundPolicy;
  turnTimeoutSeconds?: number;
  maxPlayers?: number;
  dailyEntryLimit?: number;
  promoFreeEntry?: boolean;
  promoUntil?: string | null;
  confirmCompliance?: boolean;
}

export interface GameRulesResult {
  game: GameDefinition;
  rulesChanged: boolean;
}

export interface AdminGamesResult {
  games: GameDefinition[];
  sessions: GameSession[];
}

// ---------------------------------------------------------------------------
// BD accounts, coin sellers, recharges, commission and the book (§21–§25).
// Money is always minor units plus its currency code.
// ---------------------------------------------------------------------------
export type BusinessAccountKind = 'BD_MANAGER' | 'BD_AGENT' | 'COIN_SELLER';
export type BusinessAccountStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export interface BusinessAccount {
  id: string;
  kind: BusinessAccountKind;
  code: string;
  displayName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  status: BusinessAccountStatus;
  marketCountry: string | null;
  parentId: string | null;
  parentCode: string | null;
  parentName: string | null;
  maxOrderDiamonds: number;
  dailyDiamondLimit: number;
  dailyOrderLimit: number;
  hasCredential: boolean;
  approvedAt: string | null;
  suspendedReason: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface BusinessAccountListResult {
  accounts: BusinessAccount[];
  total: number;
  page: number;
  limit: number;
}

export type RechargeOrderStatus =
  | 'AWAITING_PAYMENT'
  | 'AWAITING_VERIFICATION'
  | 'CREDITED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REVERSED';

export interface RechargeOrder {
  id: string;
  reference: string;
  status: RechargeOrderStatus;
  sellerId: string;
  sellerCode: string;
  sellerName: string;
  bdId: string | null;
  bdCode: string | null;
  userId: string;
  username: string;
  diamonds: number;
  amountCents: number;
  feeCents: number;
  currency: string;
  paymentMethod: string;
  paymentRef: string | null;
  provider: string | null;
  evidence: Record<string, unknown>;
  rulesSnapshot: Record<string, unknown>;
  transactionId: string | null;
  decisionNote: string | null;
  reversalReason: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export interface RechargeOrderListResult {
  orders: RechargeOrder[];
  total: number;
  page: number;
  limit: number;
}

export interface RechargePackage {
  key: string;
  label: string;
  diamonds: number;
  amountCents: number;
  currency: string;
  feeBps: number;
  unitPriceCents: number;
  isActive: boolean;
}

export type CommissionRuleKind = 'SELLER_PERCENT' | 'SELLER_FIXED' | 'SELLER_TIER' | 'BD_PERCENT' | 'BD_FIXED';
export type CommissionBeneficiary = 'SELLER' | 'BD' | 'PLATFORM' | 'PROVIDER';

export interface CommissionTier {
  uptoCents: number;
  percentBps?: number;
  fixedCents?: number;
}

export interface CommissionRule {
  id: string;
  kind: CommissionRuleKind;
  beneficiary: CommissionBeneficiary;
  appliesToId: string | null;
  appliesToCode: string | null;
  rulesVersion: number;
  percentBps: number | null;
  fixedCents: number | null;
  tiers: CommissionTier[] | null;
  minOrderCents: number | null;
  maxOrderCents: number | null;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  note: string | null;
}

export interface CommissionEntry {
  id: string;
  orderReference: string;
  beneficiary: CommissionBeneficiary;
  beneficiaryId: string | null;
  beneficiaryCode: string | null;
  beneficiaryName: string | null;
  kind: CommissionRuleKind;
  ruleVersion: number;
  status: 'ACCRUED' | 'SETTLED' | 'REVERSED' | string;
  basisCents: number;
  amountCents: number;
  currency: string;
  reversedAt: string | null;
  reversalReason: string | null;
  settlementReference: string | null;
  settledAt: string | null;
  createdAt: string;
}

export interface CommissionSettlement {
  id: string;
  reference: string;
  beneficiary: 'SELLER' | 'BD' | string;
  beneficiaryId: string;
  currency: string;
  amountCents: number;
  entryCount: number;
  status: 'DRAFT' | 'APPROVED' | 'PAID' | 'VOID' | string;
  periodFrom: string;
  periodTo: string;
  payoutMethod: string | null;
  paidAt: string | null;
  note: string | null;
  createdAt: string;
}

export interface CommissionSummary {
  accruedCents: number;
  settledCents: number;
  reversedCents: number;
  entryCount: number;
  currency: string;
}

export interface FinAccount {
  code: string;
  name: string;
  kind: 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE' | string;
  currency: string;
  normal_side: 'DEBIT' | 'CREDIT';
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  kind: string;
  debits: number;
  credits: number;
  balance: number;
}

export interface TrialBalance {
  accounts: TrialBalanceRow[];
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
}

export interface JournalLine {
  accountCode: string;
  accountName: string;
  accountKind: string;
  direction: 'DEBIT' | 'CREDIT';
  amountCents: number;
}

export interface JournalEntry {
  id: string;
  reference: string;
  sourceKind: string;
  sourceId: string;
  memo: string | null;
  currency: string;
  occurredAt: string;
  lines: JournalLine[];
}

export interface JournalListResult {
  entries: JournalEntry[];
  total: number;
  page: number;
  limit: number;
}

export interface ReconciliationCheck {
  key: string;
  domain: 'journal' | 'recharge' | 'commission' | 'revenue' | 'games' | string;
  label: string;
  unit: string;
  expected: string;
  breaches: number;
  passed: boolean;
}

export interface ReconciliationReport {
  generatedAt: string;
  range: { from: string | null; to: string | null };
  checks: ReconciliationCheck[];
  passed: number;
  breached: number;
}

/**
 * One partner, named but not described: enough to pick a beneficiary for a commission rate or
 * a seller for an order filter, without the limits and contacts that the operations view carries.
 * Readable by either desk because both desks need to point at a person.
 */
export interface PartnerRef {
  id: string;
  kind: 'COIN_SELLER' | 'BD_AGENT' | 'BD_MANAGER' | string;
  code: string;
  displayName: string;
  status: string;
}

export interface RechargeConfig {
  orderValidityMinutes: number;
  manualEvidenceRequired: boolean;
  autoCreditFromProvider: boolean;
}

export interface CommissionConfig {
  enabled: CommissionRuleKind[];
  maxAllocationBps: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
  actor: string;
  actorKind: 'admin' | 'business' | 'system';
}

// ---- Uploaded media --------------------------------------------------------
/** The nine slots an operator can fill from the panel. Mirrors `MEDIA_KINDS` server-side. */
export type MediaKind =
  | 'GIFT_ICON'
  | 'GIFT_ANIMATION'
  | 'GIFT_SOUND'
  | 'EFFECT'
  | 'RIDE'
  | 'BANNER'
  | 'BADGE'
  | 'WALLPAPER'
  | 'EMOJI';

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  /** The name the operator's file had, kept for the library listing only. */
  fileName: string;
  contentType: string;
  byteSize: number;
  /** Root-relative path stored on catalogue rows, e.g. `/uploads/3f2a….png`. */
  url: string;
  width: number | null;
  height: number | null;
  uploadedBy: string | null;
  createdAt: string;
}

// ---- Promotional banners (migration 0028) ----------------------------------
/** The four surfaces that hold art. Mirrors the CHECK on `banners.placement`. */
export type BannerPlacement = 'SPLASH' | 'HOME' | 'GIFT' | 'GAME';

/** Which renderer on the phone opens the file. Mirrors the CHECK on `banners.format`. */
export type BannerFormat = 'PNG' | 'GIF' | 'WEBP' | 'JPEG' | 'LOTTIE' | 'SVGA' | 'MP4';

/** What happens on a tap. Mirrors the CHECK on `banners.cta_type`. */
export type BannerCtaType = 'NONE' | 'INTERNAL' | 'ROOM' | 'URL';

/** The four screens reachable without naming a resource. Mirrors `BANNER_INTERNAL_TARGETS`. */
export type BannerInternalTarget = 'HOME' | 'STORE' | 'WALLET' | 'PROFILE';

/** One row as `GET /api/admin/banners` serves it. */
export interface Banner {
  id: string;
  key: string;
  placement: BannerPlacement;
  title: string;
  subtitle: string | null;
  url: string;
  format: BannerFormat;
  /** How long the surface holds this banner. `0` is the surface's own default. */
  durationMs: number;
  ctaType: BannerCtaType;
  ctaValue: string | null;
  /** Where the surface puts this row relative to its siblings; phones only ever get them ordered. */
  sortOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  impressions: number;
  taps: number;
  createdAt: string;
  updatedAt: string;
}

/** Body of POST/PUT /api/admin/banners. `key` is immutable once created. */
export interface BannerInput {
  key?: string;
  placement?: BannerPlacement;
  title?: string;
  subtitle?: string | null;
  url?: string;
  format?: BannerFormat;
  durationMs?: number;
  ctaType?: BannerCtaType;
  ctaValue?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

/** What `GET /api/banners` hands to phones: no window, no switch, no counts. */
export interface PublishedBanner {
  id: string;
  key: string;
  placement: BannerPlacement;
  title: string;
  subtitle: string | null;
  url: string;
  format: BannerFormat;
  durationMs: number;
  ctaType: BannerCtaType;
  ctaValue: string | null;
}

// ---- Social moderation (migration 0022) ------------------------------------
/** Mirrors the CHECK constraint on `user_reports.reason`. */
export type ReportReason = 'HARASSMENT' | 'SPAM' | 'FRAUD' | 'UNDERAGE' | 'VIOLENCE' | 'OTHER';

/** `PENDING` reports are the queue; the other three are terminal decisions. */
export type ReportStatus = 'PENDING' | 'REVIEWED' | 'DISMISSED' | 'ACTIONED';

/** What an operator may decide. Dismissing cannot also ban its target. */
export type ReportDecision = 'REVIEWED' | 'DISMISSED' | 'ACTIONED';

/** The lean party shape embedded in a report — enough to name an account. */
export interface ReportParty {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface AdminReport {
  id: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  resolution: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reporter: ReportParty;
  target: ReportParty;
  /** The room the report was filed from, when the reporter supplied one. */
  room: { id: string; roomNumber: number; title: string } | null;
}

export interface ReportListResult {
  reports: AdminReport[];
  total: number;
  page: number;
  limit: number;
}

export interface ReportReviewResult {
  report: AdminReport;
  banned: boolean;
}

export interface SocialCounts {
  followers: number;
  following: number;
  /** Accounts this member has blocked. */
  blocked: number;
  /** Accounts that blocked this member — a count only, never an identity list. */
  blockedBy: number;
}

export interface SocialGraphEntry extends ReportParty {
  followedAt: string;
  /** Present on the blocked list; null when the blocker left no reason. */
  blockReason?: string | null;
}

/** `GET /api/admin/users/:id/social` — the drawer behind "Social" on the users page. */
export interface UserSocialSummary {
  counts: SocialCounts;
  followers: SocialGraphEntry[];
  following: SocialGraphEntry[];
  blocked: SocialGraphEntry[];
  reportsAgainst: AdminReport[];
  reportsFiled: AdminReport[];
}
