package com.voiza.app.domain.model

// ---------------------------------------------------------------------------
// Domain models mirroring the fixed API contract. Field names follow the
// backend JSON (camelCase) which in turn follows backend/database/schema.sql.
// ---------------------------------------------------------------------------

/** `MiniUser` in the contract: trimmed user reference embedded in rooms/seats/chat. */
data class MiniUser(
    val id: String,
    val username: String,
    val avatarUrl: String?,
    val diamondBalance: Int? = null,
    /** Only on `room:user_joined`; sizes that user's entry banner. */
    val vipLevel: Int? = null,
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

/** `room:theme_changed`: the room's wallpaper/accent was swapped under our feet. */
data class ThemeChangedEvent(val roomId: String, val theme: String)

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
