package com.voiza.app.domain.model

// ---------------------------------------------------------------------------
// Domain models mirroring the fixed API contract. Field names follow the
// backend JSON (camelCase) which in turn follows backend/database/schema.sql.
// ---------------------------------------------------------------------------

/**
 * One rung of the earned ladder (`rank_levels`, migration 0017) as the server resolves it for a
 * member. Every field is data an operator edits in the admin panel, so the app must paint these
 * values and never derive a level, a badge path or a threshold itself.
 */
data class UserRank(
    val level: Int,
    val name: String,
    /** Root-relative art (`/badges/level-3.png`) or an uploaded `/uploads/<uuid>.png`. */
    val badge: String?,
    /** `#rrggbb` used to tint the rung's name next to the badge. */
    val accent: String?,
)

/** `MiniUser` in the contract: trimmed user reference embedded in rooms/seats/chat. */
data class MiniUser(
    val id: String,
    val username: String,
    val avatarUrl: String?,
    val diamondBalance: Int? = null,
    /** Only on `room:user_joined`; sizes that user's entry banner. */
    val vipLevel: Int? = null,
    /**
     * The rung this member has earned, already resolved by the server from their XP. Null on the
     * lean payloads (seat lists, audience) that do not read XP at all — the absence is the server
     * choosing not to ship it, never a hint that the app should compute one.
     */
    val rank: UserRank? = null,
    /** The paid ring drawn over this member's avatar, or null when they wear none. */
    val profileFrame: ProfileFrame? = null,
    /** The paid entry flourish URL the server resolved for this join, or null for the free one. */
    val entryEffect: String? = null,
)

/**
 * An avatar ring sold in the store and worn by a member (migration 0019).
 *
 * [art] is a ring PNG with a transparent middle, drawn *over* the avatar rather than replacing
 * it, and [accent] is the colour to show while that file loads. Both come from the server's
 * catalogue; neither is built here from [key].
 */
data class ProfileFrame(
    val key: String,
    val name: String,
    val art: String,
    val accent: String?,
)

/** Full `users` row as returned by /api/auth/me and auth responses. */
data class User(
    val id: String,
    val phone: String,
    val username: String,
    val avatarUrl: String?,
    val bio: String?,
    val gender: String?,
    val countryCode: String?,
    val diamondBalance: Int,
    val rCoinBalance: Int,
    val totalGiftsSent: Long,
    val totalGiftsReceived: Long,
    /** HOST | USER | AGENCY_ADMIN (users.user_type enum). */
    val userType: String,
    /** ACTIVE | BANNED. */
    val status: String,
    val isVerified: Boolean,
    /** Spend tier; ops-assigned server-side and compared with Gift.minVipLevel. */
    val vipLevel: Int = 0,
    /** Lifetime experience (`users.xp`). Read-only here: only the server's ledger moves it. */
    val xp: Long = 0,
    /** The rung [xp] sits on. */
    val rank: UserRank? = null,
    /** What this account is wearing right now, as the server resolved it from the worn columns. */
    val profileFrame: ProfileFrame? = null,
    val entryEffect: String? = null,
)

enum class SeatStatus { EMPTY, OCCUPIED, LOCKED }

data class Seat(
    val seatIndex: Int,
    val status: SeatStatus,
    val isMuted: Boolean,
    val isSpeaker: Boolean,
    val user: MiniUser?,
) {
    fun occupiedBy(userId: String?): Boolean =
        status == SeatStatus.OCCUPIED && user != null && user.id == userId
}

enum class RoomCategory { POPULAR, PARTY, MUSIC, GAME, CHAT }

/**
 * Lobby ordering, asked of the server as `?sort=`. [DEFAULT] sends no parameter at all, so the
 * tab keeps whatever ordering the API has always used for it — this client does not decide what
 * "trending" means, it only asks for it.
 */
enum class RoomSort(val apiValue: String?, val label: String) {
    DEFAULT(null, "Default"),
    POPULAR("popular", "Popular"),
    TRENDING("trending", "Trending"),
    RECENT("recent", "New"),
}

enum class RoomType { PUBLIC, PRIVATE }

enum class RoomStatus { ACTIVE, CLOSED }

/** Slug of the room look to fall back on when the API omits `theme`. */
const val DEFAULT_ROOM_THEME = "aurora"

/** Ambient loop for a room whose API is too old to name one. */
const val DEFAULT_AMBIENT_EFFECT = "/effects/room-sparkle.json"

/**
 * Regex used to find emoji codes inside a message when the API does not publish its own.
 *
 * `GET /api/emoji` normally supplies `codePattern` and this client matches with exactly that
 * string; this constant only covers a backend predating migration 0016, and mirrors the
 * expression such a server ships for its seeded codes.
 */
const val FALLBACK_EMOJI_CODE_PATTERN = "\\[[a-z0-9][a-z0-9-]{0,31}\\]"

/** List item from GET /api/rooms. */
data class RoomSummary(
    val id: String,
    val roomNumber: Int,
    val title: String,
    val description: String?,
    val coverUrl: String?,
    val theme: String = DEFAULT_ROOM_THEME,
    val category: RoomCategory,
    /** ISO 639-1 tag the host stated, or null when they never said. */
    val language: String? = null,
    /** ISO 3166-1 alpha-2 the room targets, or null. */
    val region: String? = null,
    /** Host-written house rules; shown to the room, enforced by nobody but the host. */
    val rules: String? = null,
    val type: RoomType,
    val seatCapacity: Int,
    val status: RoomStatus,
    val listenerCount: Int,
    val likeCount: Long = 0,
    val totalGiftValue: Long,
    val host: MiniUser,
)

/**
 * A room look an operator maintains in the database, published by `GET /api/rooms/themes`.
 *
 * The wallpaper is a URL rather than something derived from the slug because a theme added from
 * the admin panel points at `/uploads/<uuid>.png`; a client that built `/themes/<slug>/…` would
 * 404 on art that exists.
 */
data class ThemeCatalogue(
    val themes: List<RoomThemeOption> = emptyList(),
    val defaultTheme: String = DEFAULT_ROOM_THEME,
    /** Entry flourish for every room, or null when the operator retired all of them. */
    val welcome: String? = null,
)

data class RoomThemeOption(
    val slug: String,
    val name: String,
    val accent: String,
    val wallpaper: String,
)

/**
 * One chat emoji, published by `GET /api/emoji` from the `emoji_characters` rows an operator
 * maintains in the admin panel.
 *
 * [code] is the token a message actually contains (`[smile]`), and [url] is where its art is
 * served. A sent message stores only the token — never this URL — so a code whose row was deleted
 * stays readable as plain text instead of breaking history, and the client decides per render
 * whether it has art for a token it is looking at.
 */
data class EmojiOption(
    val key: String,
    val label: String,
    val code: String,
    val url: String,
)

/** The picker grid plus the expression to scan messages with. */
data class EmojiCatalogue(
    val emojis: List<EmojiOption> = emptyList(),
    val codePattern: String = FALLBACK_EMOJI_CODE_PATTERN,
)

/** Full room object (POST /api/rooms, join responses). */
data class Room(
    val id: String,
    val roomNumber: Int,
    val title: String,
    val description: String?,
    val coverUrl: String?,
    val theme: String = DEFAULT_ROOM_THEME,
    val category: RoomCategory,
    val language: String? = null,
    val region: String? = null,
    val rules: String? = null,
    /** Root-relative Lottie URL the server picked for this room's category. */
    val ambientEffect: String = DEFAULT_AMBIENT_EFFECT,
    /**
     * Wallpaper for this room's theme, resolved by the server. Null only against a backend that
     * predates the decoration catalogue; the room then shows its plain gradient rather than a
     * guessed path.
     */
    val themeWallpaper: String? = null,
    val type: RoomType,
    val seatCapacity: Int,
    val status: RoomStatus,
    val listenerCount: Int,
    /** Server-counted likes; the running total arrives on `room:liked`. */
    val likeCount: Long = 0,
    val totalGiftValue: Long,
    val host: MiniUser,
    val seats: List<Seat> = emptyList(),
)

/**
 * Seat bounds from `GET /api/rooms/capacity`, which is where the administrator's policy reaches
 * the client. Counts are total seats: seat 0 is the host, so 16 means one host plus 15 speakers.
 */
data class SeatPolicy(
    val minSeats: Int,
    val defaultSeats: Int,
    val maxSeats: Int,
) {
    /** A form with a reversed or empty range has nothing to offer; send the server default instead. */
    val isUsable: Boolean get() = minSeats >= 2 && maxSeats >= minSeats && defaultSeats in minSeats..maxSeats
}

/** `livekit` field on join responses / POST /api/rooms/:id/livekit-token. */
data class LiveKitCredentials(
    val url: String,
    val token: String,
    val roomName: String,
    val identity: String,
    val canPublish: Boolean,
)

/** Static snapshot returned by GET /api/rooms/:id. */
data class RoomDetail(
    val room: Room,
    val seats: List<Seat>,
    val audience: List<MiniUser>,
    val chat: List<ChatMessage>,
)

/** Returned by POST /api/rooms/:id/join (adds LiveKit credentials). */
data class RoomJoinResult(
    val room: Room,
    val seats: List<Seat>,
    val audience: List<MiniUser>,
    val livekit: LiveKitCredentials,
)

enum class MessageType { TEXT, GIFT, SYSTEM }

data class ChatMessage(
    val id: String,
    val user: MiniUser?,
    val content: String,
    val type: MessageType,
    /** ISO-8601 timestamp string straight from the wire. */
    val createdAt: String,
)

/** How loudly a gift plays: one row in the ticker column, or the whole screen. */
enum class GiftEffectKind { TICKER, FULLSCREEN }

/** Gift catalogue row (gifts table / GET /api/gifts). */
data class Gift(
    val id: String,
    val name: String,
    val iconUrl: String,
    val animationUrl: String?,
    /** Short audio played with the overlay; null falls back to silence. */
    val soundUrl: String? = null,
    val diamondPrice: Int,
    val rCoinValue: Int,
    /** ROSE | SPECIAL | LUXURY | EVENT. */
    val category: String,
    /** 0 is unlocked; above it the sender needs at least this users.vip_level. */
    val minVipLevel: Int = 0,
    /** Panel order, cheapest first; the server sorts, the client only trusts it. */
    val sortOrder: Int = 0,
    /** Set by the operator per gift — not inferred from whether art exists. */
    val effectKind: GiftEffectKind = GiftEffectKind.TICKER,
) {
    val isTakeover: Boolean get() = effectKind == GiftEffectKind.FULLSCREEN
}

/** Which side of a gift transaction a ranking board counts. */
enum class RankBoard { SENDERS, RECEIVERS }

/** One row of GET /api/users/top. */
data class RankRow(val user: MiniUser, val earned: Long)

/** A ranked board. `window` is the query key that produced it ("day"/"week"/"month"). */
data class Leaderboard(val window: String, val board: RankBoard, val rows: List<RankRow>)

/** Transaction ledger entry (transactions table). */
data class Transaction(
    val id: String,
    /** GIFT_SENT | RECHARGE | WITHDRAWAL | ADMIN_ADJUSTMENT | AGENCY_COMMISSION | SEAT_FEE. */
    val type: String,
    val amountDiamonds: Int,
    val amountRCoins: Int,
    val giftName: String?,
    val sender: MiniUser?,
    val receiver: MiniUser?,
    val createdAt: String,
)

data class WalletStats(
    val diamondsSpent: Long,
    val rCoinsEarned: Long,
    val giftsSent: Long,
)

data class WalletSnapshot(
    val user: User,
    val transactions: List<Transaction>,
    val stats: WalletStats,
)

data class Withdrawal(
    val id: String,
    val amountRCoins: Int,
    val status: String,
    val payoutMethod: String,
)

// ---------------------------------------------------------------------------
// Cosmetic store (GET /api/store, migration 0019)
// ---------------------------------------------------------------------------

/** The three catalogues one shop lists: rings a member wears, themes a room wears, entry flourishes. */
enum class StoreItemKind { FRAME, THEME, EFFECT }

/**
 * One purchasable row, already annotated by the server with what *this* caller holds.
 *
 * [owned] becomes false when a rental lapses, and [expiresAt] is null for a purchase that never
 * does. What is [equipped] is likewise the server's answer — a theme can never be, because a
 * theme decorates a room.
 */
data class StoreItem(
    val kind: StoreItemKind,
    val key: String,
    val name: String,
    val art: String,
    val accent: String?,
    val priceDiamonds: Int,
    /** Rental length in days; null means the purchase never expires. */
    val periodDays: Int?,
    val owned: Boolean,
    val expiresAt: String?,
    val equipped: Boolean,
) {
    val id: String get() = "${kind.name}:$key"

    /** A theme is picked by a host in the room settings; it is never worn by an account. */
    val wearable: Boolean get() = kind != StoreItemKind.THEME
}

/** What the member already holds — including items retired from sale, which stay theirs. */
data class OwnedStoreItem(
    val kind: StoreItemKind,
    val key: String,
    val name: String,
    val art: String,
    val onSale: Boolean,
    val expiresAt: String?,
    val acquiredVia: String,
)

data class StoreSnapshot(
    val items: List<StoreItem>,
    val owned: List<OwnedStoreItem>,
) {
    fun itemsOf(kind: StoreItemKind): List<StoreItem> = items.filter { it.kind == kind }
}

/** The result of one purchase: the row as it now stands, plus the wallet that paid for it. */
data class StorePurchase(
    val item: StoreItem?,
    val user: User?,
)

// ---------------------------------------------------------------------------
// Socket.IO payload models (server -> client emits). Each carries roomId so
// the room ViewModel can filter events to the room it currently renders.
// ---------------------------------------------------------------------------

data class RoomChatEvent(val roomId: String, val message: ChatMessage)

data class SeatUpdateEvent(
    val roomId: String,
    val seats: List<Seat>,
    val audience: List<MiniUser>,
)

data class ListenerCountEvent(val roomId: String, val count: Int)

data class UserJoinedEvent(val roomId: String, val user: MiniUser)

data class UserLeftEvent(val roomId: String, val userId: String)

data class MicToggleEvent(val roomId: String, val seatIndex: Int, val muted: Boolean)

data class RoomClosedEvent(val roomId: String)

/**
 * `room:theme_changed`: the room's wallpaper/accent was swapped under our feet.
 * The wallpaper URL comes along because the client must not rebuild it from the slug.
 */
data class ThemeChangedEvent(
    val roomId: String,
    val theme: String,
    val wallpaper: String? = null,
)

/**
 * `room:profile_updated`: the host edited title, description, category or the profile text.
 * Carried as the server's current values, so a null language means the host cleared it.
 */
data class RoomProfileEvent(
    val roomId: String,
    val title: String,
    val description: String?,
    val category: RoomCategory,
    val language: String?,
    val region: String?,
    val rules: String?,
)

/** Private `room:warning`: an operator nudged the host about conduct in this room. */
data class HostWarningEvent(val roomId: String, val message: String)

/** `room:hand_raise`: drives the host's request-to-speak queue. */
data class HandRaiseEvent(val roomId: String, val raised: Boolean, val user: MiniUser)

/** `room:gift_animated` payload driving the full-screen effect overlay. */
data class GiftAnimatedEvent(
    val roomId: String,
    val gift: Gift,
    val sender: MiniUser,
    val receiver: MiniUser,
    val quantity: Int,
    val animationUrl: String?,
    val totalDiamonds: Long,
    val totalRCoins: Long,
    val seatIndex: Int?,
)

/**
 * `room:liked` payload. The server batches taps per second, so `count` is what
 * this window added and `total` is the room's running number — the client never
 * sums its own taps.
 */
data class RoomLikeEvent(val roomId: String, val count: Int, val total: Long, val user: MiniUser?)

/**
 * One request for the heart layer to play. `token` only ever increases, so a
 * recomposition that does not change it does not restart the animation; `hearts`
 * is how many to release (own tap = 1, an inbound batch = a small puff).
 */
data class HeartSignal(val hearts: Int, val token: Long)
