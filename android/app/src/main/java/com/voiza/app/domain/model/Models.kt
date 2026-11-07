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
    /**
     * The cinematic this member arrives with on `room:user_joined`, or null for "walks in quietly".
     * Absent on the lean payloads that never read the ride column — which is the server choosing
     * not to ship it, never a hint that the app should show some default ride.
     */
    val entryRide: EntryRide? = null,
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

/**
 * The entrance cinematic a member arrives with (migration 0026), resolved server-side from the
 * worn key plus its expiry — the same shape the account DTO and the `room:user_joined` payload ship.
 *
 * [url] is handed to every device in the room and [format] is the string that names which renderer
 * opens it, because an SVGA container loaded into the Lottie player shows a still frame, not an
 * error. [durationMs] is the operator's ceiling on how long the room hands the screen to the clip
 * and **0 is a real answer** — "play it for its own length" — so a caller must fall back to its
 * own timeout rather than reading 0 as "no duration declared" and cutting the ride short.
 *
 * Note the key names differ from the shop row's: a store item spells the same two facts `art` and
 * `animationFormat`, so nothing here may be read from those.
 */
data class EntryRide(
    val key: String,
    val name: String,
    val url: String,
    /** The container the upload sniffer found, so the device routes instead of guessing. */
    val format: GiftAnimationFormat,
    val durationMs: Int = 0,
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
    /**
     * The ride this member arrives with, or null when they own nothing, their copy lapsed or the
     * operator retired the row. There is no free ride to fall back on: null means walk in quietly.
     */
    val entryRide: EntryRide? = null,
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
    /** Host-pinned notice above the seats. Null or blank means the host pinned nothing. */
    val announcement: String? = null,
    val announcementUpdatedAt: String? = null,
    /** When true, a member's seat tap files a request the host answers instead of seating them. */
    val speakerApprovalRequired: Boolean = false,
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

/**
 * Which player opens the gift's animation file. The backend chooses this from the uploaded bytes,
 * not from a file name, so a gift's format is a promise about the file at `animationUrl`:
 * [LOTTIE] is a Bodymovin scene, [SVGA] a sprite scene, [MP4] a short video.
 */
enum class GiftAnimationFormat { LOTTIE, SVGA, MP4 }

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
    /** Which renderer opens [animationUrl]; a gift with no animation never reaches one. */
    val animationFormat: GiftAnimationFormat = GiftAnimationFormat.LOTTIE,
    /**
     * How long the room hands the screen to this gift. 0 means the catalogue row predates the
     * playback fields, in which case the renderer's own lifetime (the Lottie composition, the
     * video's duration) is the only clock there is.
     */
    val durationMs: Int = 0,
    /** Tie-break when two takeovers arrive together; higher plays first, 0 is unset. */
    val displayPriority: Int = 0,
    /** Whether repeats from one sender to one receiver add up on screen. Computed by the server. */
    val comboEnabled: Boolean = false,
    /** The clock window a combo is counted inside, in ms; the server owns both ends of it. */
    val comboWindowMs: Int = 5_000,
    /**
     * True when the credit is drawn from a prize table instead of being `rCoinValue` × quantity.
     * The price the sender pays never changes with it — only what the receiver banks does.
     */
    val isLuckyBox: Boolean = false,
    /** The odds a box publishes, in the operator's own order. Empty on a gift that rolls nothing. */
    val boxOutcomes: List<GiftBoxOutcome> = emptyList(),
    /**
     * What the receiver keeps of a roll, in ten-thousandths; null on a gift that is not a box.
     * The platform's take is the remainder — there is no second dial to read.
     */
    val receiverShareBps: Int? = null,
) {
    val isTakeover: Boolean get() = effectKind == GiftEffectKind.FULLSCREEN
}

/**
 * One prize of a lucky box as the catalogue discloses it.
 *
 * [chanceBps] is this row's weight against the box's total, divided by the server: a device prints
 * the odds it was given and cannot disagree with the draw that produced them. The weights
 * themselves never leave the backend.
 */
data class GiftBoxOutcome(
    val label: String,
    /** Times the per-unit reward pool this prize is worth, in ten-thousandths (10,000 = the pool). */
    val multiplierBps: Int,
    val chanceBps: Int,
)

/**
 * One gift-panel tab. [key] is the shelf key an operator manages — the string a gift's `category`
 * is compared against when the tab filters — and [name] is the label the operator chose to show.
 * A server that ships no shelf list gets tabs derived from the catalogue's own category strings,
 * where the key is that raw string.
 */
data class GiftCategoryOption(
    val key: String,
    val name: String,
    /** Display order the operator set; the response arrives sorted by it, and derived tabs carry 0. */
    val sortOrder: Int = 0,
)

/** `GET /api/gifts` as the app consumes it: the catalogue rows plus the shelves filing them. */
data class GiftCatalogue(
    val gifts: List<Gift> = emptyList(),
    val categories: List<GiftCategoryOption> = emptyList(),
)

/**
 * The gift-panel tab strip, computed from whatever the catalogue response carried.
 *
 * When the server shipped a shelf list ([categories] non-empty) the tabs are those shelves in the
 * server's own order, keeping only the ones [catalog] actually has a gift under — an empty shelf
 * would otherwise render a tab with nothing behind it. A gift whose category matches no shipped
 * shelf is never dropped here: it stays in [catalog] and is visible under "All".
 *
 * With no shelf list — an older server or a partial payload, which the mapper reads as an empty
 * [categories] — this reproduces the pre-shelf behaviour: one tab per distinct category string in
 * catalogue order, labelled the way the panel always labelled it. That fallback is why the change
 * is safe to ship before the backend is guaranteed present.
 */
fun giftCategoryTabs(
    categories: List<GiftCategoryOption>,
    catalog: List<Gift>,
): List<GiftCategoryOption> {
    if (categories.isEmpty()) {
        return catalog.map { it.category }.distinct().map {
            GiftCategoryOption(key = it, name = giftCategoryFallbackLabel(it))
        }
    }
    return categories.filter { shelf -> catalog.any { it.category == shelf.key } }
}

/** The cosmetic label a raw category string got before shelves existed: underscores to spaces, Title Case. */
fun giftCategoryFallbackLabel(key: String): String =
    key.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }

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
// Cosmetic store (GET /api/store; frames/themes/effects from migration 0019,
// the entrance rides of 0026). All four kinds share one row shape and one
// purchase/equip contract, so they stay in one model.
// ---------------------------------------------------------------------------

/**
 * The four catalogues one shop lists: rings a member wears, themes a room wears, entry flourishes
 * and the full-screen ride a member arrives with. FRAME, EFFECT and RIDE are worn by an account and
 * can be equipped; THEME decorates a room, so a host picks it in room settings instead.
 */
enum class StoreItemKind { FRAME, THEME, EFFECT, RIDE }

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
    /** Lowest VIP level allowed to BUY this row; 0 means anybody. Grants and equips ignore it. */
    val minVipLevel: Int,
    /** Editorial flag; the server already lists recommended rows first, so the app only badges. */
    val recommended: Boolean,
    /**
     * RIDE rows only: which renderer opens [art]. The catalogue stores what the upload sniffer said
     * about the bytes, so a device that guessed from the file extension would open an SVGA
     * container in the Lottie player. The field is absent on every other catalogue, and Gson's
     * Unsafe allocator leaves an absent key null instead of the Kotlin default, so the mapper
     * resolves it to [GiftAnimationFormat.LOTTIE] — the renderer that has always existed, and the
     * same fallback a ride row from a backend predating 0026 gets.
     */
    val animationFormat: GiftAnimationFormat = GiftAnimationFormat.LOTTIE,
    /**
     * RIDE rows only: how long the room hands the screen to this cinematic, in ms.
     *
     * 0 is the operator's answer "play the asset for its own length", **not** a missing number: a
     * caller that treats it as absent and drops its own short default would cut a 20-second arrival
     * in half. A ride that never reports an end still needs the app's ceiling, which is why the
     * value stays exactly what the server sent.
     */
    val durationMs: Int = 0,
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
    /**
     * Null on a backend that predates these three keys, which is why they cannot simply overwrite:
     * a profile edit broadcast that says nothing about the pinned notice must leave the notice the
     * room already showed on screen.
     */
    val announcement: String? = null,
    val announcementUpdatedAt: String? = null,
    val speakerApprovalRequired: Boolean? = null,
)

/** Private `room:warning`: an operator nudged the host about conduct in this room. */
data class HostWarningEvent(val roomId: String, val message: String)

/** `room:hand_raise`: drives the host's request-to-speak queue. */
data class HandRaiseEvent(val roomId: String, val raised: Boolean, val user: MiniUser)

/**
 * `room:announcement`: the pinned notice as the host (or an operator) just set it. A null text is
 * the notice being cleared, not an edit that left it out, so the banner disappears.
 */
data class RoomAnnouncementEvent(
    val roomId: String,
    val announcement: String?,
    val updatedAt: String?,
)

/**
 * Private `room:seat_invited`. The server has already seated us and granted the microphone before
 * this lands, so the event carries the publisher token rather than a choice: the app applies the
 * rights the room's next `room:seat_update` confirms.
 */
data class SeatInviteEvent(
    val roomId: String,
    val seatIndex: Int,
    val livekit: LiveKitCredentials?,
)

/**
 * Private `room:speaker_decision`: the host answered our request. An approval brings the publisher
 * token with it; a rejection brings nothing, because there is no seat to speak from.
 */
data class SpeakerDecisionEvent(
    val roomId: String,
    val status: SpeakerRequestStatus,
    val seatIndex: Int?,
    val livekit: LiveKitCredentials?,
) {
    val approved: Boolean get() = status == SpeakerRequestStatus.APPROVED
}

/** One line of the host's speaker queue (`GET /api/rooms/:id/speaker-requests`). */
data class SpeakerRequest(
    val id: String,
    val roomId: String,
    val seatIndex: Int,
    val status: SpeakerRequestStatus,
    val createdAt: String?,
    val user: MiniUser?,
)

enum class SpeakerRequestStatus { PENDING, APPROVED, REJECTED, CANCELLED, EXPIRED }

/**
 * What `POST /api/rooms/:id/seat` answered. A room with approval switched answers 202 and a queued
 * request instead of a seat, so the caller cannot treat the two as one shape: nothing was seated,
 * no token was minted and the seat list did not change.
 */
sealed interface SeatTakeResult {
    /**
     * We are seated. [livekit] is the publisher token the server minted for the new speaker, and
     * null only against a backend that predates it — the seat list still says who may speak.
     */
    data class Seated(val seats: List<Seat>, val livekit: LiveKitCredentials?) : SeatTakeResult

    /**
     * A request was filed and nobody was seated. [request] carries its id when the server sent one;
     * cancelling does not need it, because the cancel route clears the caller's own request.
     */
    data class Queued(val request: SpeakerRequest?) : SeatTakeResult
}

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
    /**
     * The ledger transaction id, which the server also broadcasts as the event's identity. It is
     * the only key that survives both paths a gift can reach a device by — live socket, and the
     * room's recent-gift list after a reconnect — so it is what the queue deduplicates on.
     * Null only for an event from a backend that predates the gift engine.
     */
    val eventId: String? = null,
    /** Server-owned combo identity: same sender, receiver, gift and clock window, same id. */
    val comboId: String? = null,
    /** How many gifts this event's window holds, as counted by the server. */
    val comboCount: Int = 1,
    /**
     * The draw that produced this gift's credit, or null for every gift that rolls nothing.
     *
     * It is the same object the ledger row carries in `meta.lucky`, so the number on the screen and
     * the number in the sender's receipt were written by one draw. Nothing here is recomputed: a
     * device that re-derived the payout from the prize table would be reporting its own guess about
     * money the server already moved.
     */
    val lucky: LuckyRoll? = null,
)

/** One prize that came up in a send, with how many of the units rolled it. */
data class LuckyPrize(
    val label: String,
    val multiplierBps: Int,
    /** The disclosed odds of this prize, in ten-thousandths — what the box published, not a guess. */
    val chanceBps: Int,
    val count: Int,
)

/**
 * What one lucky-box send rolled, as the ledger recorded it.
 *
 * [receiverRCoins] is the figure that was credited — the same number `totalRCoins` on the event
 * carries — and [platformTaxRCoins] is the remainder of [grossRCoins]. Both come from the server for
 * the same reason the price does: they are facts about money, and a client that computes them is a
 * client that can be wrong in a way that looks like the platform's bookkeeping.
 */
data class LuckyRoll(
    /** Only the prizes that actually came up, best first as the server ordered them. */
    val prizes: List<LuckyPrize>,
    /** The prize worth taking the screen for: the best one this send rolled. */
    val headline: LuckyPrize?,
    val grossRCoins: Long,
    val receiverRCoins: Long,
    val platformTaxRCoins: Long,
    val receiverShareBps: Int,
)

/**
 * What `POST /api/gifts/send` answered for one Send tap.
 *
 * [replayed] is TRUE when the server recognised the idempotency key and returned the gift it had
 * already bought instead of buying a second one — the tap is then already paid for, and the room
 * already saw the animation, so the caller must not add a second effect or adjust a balance.
 * [comboId] and [comboCount] are the server's tally for this send's window; a gift the operator
 * left out of combos reports count 1.
 */
data class SendGiftOutcome(
    val transaction: Transaction,
    val replayed: Boolean,
    val comboId: String?,
    val comboCount: Int,
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

/**
 * `room:reaction` payload: who fired which of the operator's emoji. Nothing is stored behind it —
 * the server's own comment is that a reaction is decoration and not a ledger line — so this event
 * exists only for as long as the art is in the air.
 */
data class RoomReactionEvent(val roomId: String, val userId: String, val emoji: EmojiOption)

/**
 * One request for the reaction layer to fly. Shaped like [HeartSignal] for the same reason: `token`
 * only ever increases, so a recomposition that leaves it alone does not restart a burst, and the
 * emoji travels with the signal because each tap or inbound event can name a different one.
 */
data class ReactionSignal(val emoji: EmojiOption?, val token: Long)

// ---------------------------------------------------------------------------
// Promotional banners (GET /api/banners, migration 0028)
// ---------------------------------------------------------------------------

/**
 * Which surface draws a banner.
 *
 * The server answers a row only for the surface it was filed under, so a device asks for one
 * placement and never has to decide whether an art card belongs on the screen it is standing on.
 */
enum class BannerPlacement { SPLASH, HOME, GIFT, GAME }

/**
 * Which renderer opens a banner's file.
 *
 * Wider than [GiftAnimationFormat] because a banner is usually a poster: the four stills and the two
 * moving containers Coil animates are what an operator uploads most often, and the three scene
 * formats are the ones the gift engine already plays.
 */
enum class BannerFormat { PNG, GIF, WEBP, JPEG, LOTTIE, SVGA, MP4 }

/** The four screens the app can reach without naming a resource — the server's own short list. */
enum class BannerScreen { HOME, STORE, WALLET, PROFILE }

/**
 * What tapping a banner means, as the server named it.
 *
 * A row carries a verb and a value, never a route; joining the two is this type's job and the app's
 * only place where it happens. Anything the app cannot name becomes [BannerTarget.None]: a banner
 * that visibly does nothing is honest, a route guessed from a stray string is not.
 */
sealed interface BannerTarget {
    data object None : BannerTarget
    data class Internal(val screen: BannerScreen) : BannerTarget
    data class Room(val roomId: String) : BannerTarget

    /** A full `https://` link, opened outside the app. Never a URL the client assembled itself. */
    data class Link(val url: String) : BannerTarget
}

/**
 * One live campaign. Art, a headline and a verb — no member data, no price, nothing a client could
 * be tempted to edit.
 */
data class PromoBanner(
    val id: String,
    /** The operator's handle for the row, shown nowhere and useful in every support conversation. */
    val key: String,
    val placement: BannerPlacement,
    val title: String,
    val subtitle: String?,
    /** Root-relative or absolute, exactly as stored; the surface normalises it with `asAssetUrl`. */
    val url: String,
    val format: BannerFormat,
    /** How long the surface holds it. 0 defers to the surface's own dwell, as elsewhere. */
    val durationMs: Int,
    val target: BannerTarget,
)

// ---------------------------------------------------------------------------
// Social moderation: follows, blocks and reports between two members.
// ---------------------------------------------------------------------------

/**
 * How the signed-in member relates to one other account, exactly as the server answered.
 *
 * [interactionBlocked] is read from the wire rather than recomputed here: it is the backend's
 * conclusion that either side blocked the other, and which interactions that closes is its rule,
 * not this app's. A block is not a mute and not a ban — it stops gifts and follows between the
 * pair, and it is the one thing that does not stop a report.
 */
data class Relationship(
    val following: Boolean = false,
    val blockedByMe: Boolean = false,
    val blockedByThem: Boolean = false,
    val interactionBlocked: Boolean = false,
)

/**
 * The six reasons `POST /api/users/:id/report` accepts, with the words a member can read.
 *
 * The wire value is the server's constant and the label is ours; a seventh reason added in the
 * backend arrives as an unknown string and is dropped by [fromWire] rather than guessed at, so the
 * picker can only ever submit something the queue understands.
 */
enum class ReportReason(val wire: String, val label: String) {
    HARASSMENT("HARASSMENT", "Harassment"),
    SPAM("SPAM", "Spam"),
    FRAUD("FRAUD", "Scam or fraud"),
    UNDERAGE("UNDERAGE", "Underage account"),
    VIOLENCE("VIOLENCE", "Violence"),
    OTHER("OTHER", "Something else"),
    ;

    companion object {
        /** Case-insensitive, because the server's own enum parsing is. */
        fun fromWire(value: String?): ReportReason? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}
