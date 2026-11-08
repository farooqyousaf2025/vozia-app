package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// Wire DTOs for the REST contract. Gson maps JSON onto these; data/mapper
// converts them to domain models. All property names follow the backend
// JSON (camelCase) already; @SerializedName only marks fields whose Kotlin
// name differs (e.g. `type` enums kept as raw strings).
// ---------------------------------------------------------------------------

data class OtpRequestBody(@SerializedName("phone") val phone: String)

data class OtpResponse(
    @SerializedName("sent") val sent: Boolean,
    @SerializedName("devCode") val devCode: String? = null,
)

data class VerifyOtpBody(
    @SerializedName("phone") val phone: String,
    @SerializedName("code") val code: String,
    @SerializedName("username") val username: String? = null,
)

/**
 * The avatar ring a member paid for, resolved server-side from the worn key and its expiry.
 *
 * `art` is the exact URL a phone draws — a ring PNG with a transparent middle — and `accent` is
 * the colour to fall back on while that file loads, so a slow CDN shows a plain circle rather than
 * a hole. Neither may be derived from [key].
 */
data class FrameArtDto(
    @SerializedName("key") val key: String? = null,
    @SerializedName("name") val name: String? = null,
    @SerializedName("art") val art: String? = null,
    @SerializedName("accent") val accent: String? = null,
)

data class MiniUserDto(
    @SerializedName("id") val id: String,
    @SerializedName("username") val username: String,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("diamondBalance") val diamondBalance: Int? = null,
    // Only present on the payloads that size an effect from it (room:user_joined).
    @SerializedName("vipLevel") val vipLevel: Int? = null,
    // Only present where the query read `users.xp`; absent means "not shipped", never "level 0".
    @SerializedName("rank") val rank: RankDto? = null,
    // Present only where the query read the decoration columns; null means "wearing nothing".
    @SerializedName("profileFrame") val profileFrame: FrameArtDto? = null,
    // The paid entry flourish URL on join payloads; null means the room's free default.
    @SerializedName("entryEffect") val entryEffect: String? = null,
    // The ride on the join payload, from the same SELECT that reads the decoration columns. Null
    // for a member who owns none, and absent on every lean roster that never asked for it.
    @SerializedName("entryRide") val entryRide: RideArtDto? = null,
)

/**
 * The entrance cinematic a member arrives with, as both the account DTO and `room:user_joined`
 * spell it (migration 0026).
 *
 * The two field names that matter are `url` and `format`: the shop row for the same purchase calls
 * them `art` and `animationFormat`, so a mapper that reused one shape would silently read nulls.
 * `durationMs` is nullable by the Gson rule — an absent key stays null through Unsafe, and the
 * mapper decides the fallback. 0 is not that fallback: it is the operator saying "the clip's own
 * length", which is why it survives mapping instead of becoming null.
 */
data class RideArtDto(
    @SerializedName("key") val key: String? = null,
    @SerializedName("name") val name: String? = null,
    @SerializedName("url") val url: String? = null,
    @SerializedName("format") val format: String? = null,
    @SerializedName("durationMs") val durationMs: Int? = null,
)

/** A rung of the earned ladder, resolved server-side from the member's XP. */
data class RankDto(
    @SerializedName("level") val level: Int = 0,
    @SerializedName("name") val name: String? = null,
    @SerializedName("badge") val badge: String? = null,
    @SerializedName("accent") val accent: String? = null,
)

data class UserDto(
    @SerializedName("id") val id: String,
    @SerializedName("phone") val phone: String,
    @SerializedName("username") val username: String,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("bio") val bio: String? = null,
    @SerializedName("gender") val gender: String? = null,
    @SerializedName("countryCode") val countryCode: String? = null,
    @SerializedName("diamondBalance") val diamondBalance: Int = 0,
    // Nullable because Gson leaves a missing key at null rather than at the default below it, so a
    // backend that predates the bonus pocket cannot produce a half-parsed user.
    @SerializedName("promoDiamondBalance") val promoDiamondBalance: Int? = null,
    @SerializedName("rCoinBalance") val rCoinBalance: Int = 0,
    @SerializedName("totalGiftsSent") val totalGiftsSent: Long = 0,
    @SerializedName("totalGiftsReceived") val totalGiftsReceived: Long = 0,
    @SerializedName("userType") val userType: String = "USER",
    @SerializedName("status") val status: String = "ACTIVE",
    @SerializedName("isVerified") val isVerified: Boolean = false,
    @SerializedName("vipLevel") val vipLevel: Int = 0,
    @SerializedName("xp") val xp: Long = 0,
    @SerializedName("rank") val rank: RankDto? = null,
    // The account's own worn decoration, so the profile header draws what the server says.
    @SerializedName("profileFrame") val profileFrame: FrameArtDto? = null,
    @SerializedName("entryEffect") val entryEffect: String? = null,
    // The account's own ride, always sent on this DTO (null when nothing is worn or the copy
    // lapsed) — the profile screen previews it so the owner sees what the room will see.
    @SerializedName("entryRide") val entryRide: RideArtDto? = null,
)

data class AuthResponse(
    @SerializedName("token") val token: String,
    @SerializedName("user") val user: UserDto,
)

data class UserEnvelope(@SerializedName("user") val user: UserDto)

data class SeatDto(
    @SerializedName("seatIndex") val seatIndex: Int,
    @SerializedName("status") val status: String,
    @SerializedName("isMuted") val isMuted: Boolean = false,
    @SerializedName("isSpeaker") val isSpeaker: Boolean = false,
    @SerializedName("user") val user: MiniUserDto? = null,
)

data class RoomSummaryDto(
    @SerializedName("id") val id: String,
    @SerializedName("roomNumber") val roomNumber: Int,
    @SerializedName("title") val title: String,
    @SerializedName("description") val description: String? = null,
    @SerializedName("coverUrl") val coverUrl: String? = null,
    @SerializedName("theme") val theme: String? = null,
    @SerializedName("category") val category: String,
    // The room's own profile text. Null means the host never said — the lobby shows nothing
    // rather than inventing a language or a rule line.
    @SerializedName("language") val language: String? = null,
    @SerializedName("region") val region: String? = null,
    @SerializedName("rules") val rules: String? = null,
    @SerializedName("type") val type: String,
    // Required: the count is the server's policy, never a number this file may guess.
    @SerializedName("seatCapacity") val seatCapacity: Int,
    @SerializedName("status") val status: String = "ACTIVE",
    @SerializedName("listenerCount") val listenerCount: Int = 0,
    @SerializedName("likeCount") val likeCount: Long? = null,
    @SerializedName("totalGiftValue") val totalGiftValue: Long = 0,
    @SerializedName("host") val host: MiniUserDto,
)

data class RoomDto(
    @SerializedName("id") val id: String,
    @SerializedName("roomNumber") val roomNumber: Int,
    @SerializedName("title") val title: String,
    @SerializedName("description") val description: String? = null,
    @SerializedName("coverUrl") val coverUrl: String? = null,
    @SerializedName("theme") val theme: String? = null,
    @SerializedName("category") val category: String,
    @SerializedName("language") val language: String? = null,
    @SerializedName("region") val region: String? = null,
    @SerializedName("rules") val rules: String? = null,
    // The pinned notice. Both keys are absent — not empty — on a backend that predates them, and
    // Gson leaves an absent key null even with a default written here.
    @SerializedName("announcement") val announcement: String? = null,
    @SerializedName("announcementUpdatedAt") val announcementUpdatedAt: String? = null,
    @SerializedName("speakerApprovalRequired") val speakerApprovalRequired: Boolean? = null,
    // Which ambient loop breathes behind this room. Sent by the API so the look is
    // the server's call; null on an older backend means "use the shipped default".
    @SerializedName("ambientEffect") val ambientEffect: String? = null,
    // …and the wallpaper for its theme, for the same reason: an operator's theme is art in the
    // upload store, so the path is published rather than derived from the slug here.
    @SerializedName("themeWallpaper") val themeWallpaper: String? = null,
    @SerializedName("type") val type: String,
    // Required: the count is the server's policy, never a number this file may guess.
    @SerializedName("seatCapacity") val seatCapacity: Int,
    @SerializedName("status") val status: String = "ACTIVE",
    @SerializedName("listenerCount") val listenerCount: Int = 0,
    @SerializedName("likeCount") val likeCount: Long? = null,
    @SerializedName("totalGiftValue") val totalGiftValue: Long = 0,
    @SerializedName("host") val host: MiniUserDto,
    // The API never nests seats inside `room` (they are a sibling key in the
    // envelope), and Gson leaves absent keys null rather than running the
    // default initializers — so this must be nullable, not `= emptyList()`.
    @SerializedName("seats") val seats: List<SeatDto>? = null,
)

data class RoomsResponse(@SerializedName("rooms") val rooms: List<RoomSummaryDto>)

data class RoomEnvelope(@SerializedName("room") val room: RoomDto)

data class RoomDetailResponse(
    @SerializedName("room") val room: RoomDto,
    @SerializedName("seats") val seats: List<SeatDto> = emptyList(),
    @SerializedName("audience") val audience: List<MiniUserDto> = emptyList(),
    @SerializedName("chat") val chat: List<ChatMessageDto> = emptyList(),
    // Nullable: Gson skips the default initializer for an absent key.
    @SerializedName("handRaises") val handRaises: List<ParticipantDto>? = null,
)

/** `room_participants` row as embedded in GET /api/rooms/:id handRaises[]. */
data class ParticipantDto(
    @SerializedName("seatIndex") val seatIndex: Int? = null,
    @SerializedName("role") val role: String = "AUDIENCE",
    @SerializedName("handRaised") val handRaised: Boolean = false,
    @SerializedName("user") val user: MiniUserDto? = null,
)

data class CreateRoomBody(
    @SerializedName("title") val title: String,
    @SerializedName("description") val description: String? = null,
    @SerializedName("category") val category: String? = null,
    @SerializedName("type") val type: String? = null,
    @SerializedName("password") val password: String? = null,
    @SerializedName("seatCapacity") val seatCapacity: Int? = null,
    @SerializedName("language") val language: String? = null,
    @SerializedName("region") val region: String? = null,
    @SerializedName("rules") val rules: String? = null,
)

/**
 * `PATCH /api/rooms/:id`. A null field is left alone and an empty string clears it, which is
 * the server's convention — the client must not send a field it did not touch.
 */
data class UpdateRoomBody(
    @SerializedName("title") val title: String? = null,
    @SerializedName("description") val description: String? = null,
    @SerializedName("category") val category: String? = null,
    @SerializedName("coverUrl") val coverUrl: String? = null,
    @SerializedName("language") val language: String? = null,
    @SerializedName("region") val region: String? = null,
    @SerializedName("rules") val rules: String? = null,
    /**
     * The microphone gate. This is the only way to write it: the approval queue has no route of its
     * own, and the pinned notice has one (`POST /api/rooms/:id/announcement`) precisely so this body
     * does not grow a second write path for a field a phone changes rarely.
     */
    @SerializedName("speakerApprovalRequired") val speakerApprovalRequired: Boolean? = null,
)

data class JoinRoomBody(@SerializedName("password") val password: String? = null)

/** `POST /api/rooms/:id/theme` — the slug only; the server resolves its own wallpaper URL. */
data class SetRoomThemeBody(@SerializedName("theme") val theme: String)

/**
 * `GET /api/rooms/capacity` — the seat policy the administrator owns.
 *
 * The create-room form reads its range from here instead of picking a number, so raising the
 * platform default to 20 speaker seats needs no client release.
 */
data class SeatCapacityDto(
    @SerializedName("min") val min: Int,
    @SerializedName("default") val defaultCapacity: Int,
    @SerializedName("max") val max: Int,
)

data class SeatPolicyResponse(
    @SerializedName("seatCapacity") val seatCapacity: SeatCapacityDto,
    @SerializedName("speakerSeats") val speakerSeats: Int,
    @SerializedName("maxSpeakerSeats") val maxSpeakerSeats: Int,
)

/**
 * `GET /api/rooms/themes` — the decoration catalogue, i.e. the rows an operator maintains in
 * `room_themes` / `visual_effects` (migration 0015).
 *
 * Nothing here is a slug the client turns into a path: `wallpaper` and `welcome` are the exact
 * URLs the API serves, which is what lets a theme added from the admin panel work on a phone that
 * was built before it existed.
 */
data class RoomThemeDto(
    @SerializedName("slug") val slug: String,
    @SerializedName("name") val name: String,
    @SerializedName("accent") val accent: String,
    @SerializedName("wallpaper") val wallpaper: String,
)

data class ThemeCatalogueDto(
    @SerializedName("themes") val themes: List<RoomThemeDto> = emptyList(),
    @SerializedName("defaultTheme") val defaultTheme: String? = null,
    @SerializedName("welcome") val welcome: String? = null,
    @SerializedName("effects") val effects: List<String> = emptyList(),
)

/**
 * `GET /api/emoji` — the chat emoji rows (`emoji_characters`, migration 0016).
 *
 * `codePattern` is the regular expression the server expects a client to scan messages with, so
 * the set of recognisable codes has one owner. Every field is nullable because Gson allocates
 * these data classes without running the constructor, which means a default here would never fire
 * and an absent key arrives as null — the mapper, not the type, decides what a missing field means.
 */
data class EmojiOptionDto(
    @SerializedName("key") val key: String?,
    @SerializedName("label") val label: String?,
    @SerializedName("code") val code: String?,
    @SerializedName("url") val url: String?,
)

data class EmojiCatalogueDto(
    @SerializedName("codePattern") val codePattern: String? = null,
    @SerializedName("emojis") val emojis: List<EmojiOptionDto>? = null,
)

data class LiveKitTokenDto(
    @SerializedName("url") val url: String,
    @SerializedName("token") val token: String,
    @SerializedName("roomName") val roomName: String,
    @SerializedName("identity") val identity: String,
    @SerializedName("canPublish") val canPublish: Boolean = false,
)

data class JoinRoomResponse(
    @SerializedName("room") val room: RoomDto,
    @SerializedName("seats") val seats: List<SeatDto> = emptyList(),
    @SerializedName("audience") val audience: List<MiniUserDto> = emptyList(),
    @SerializedName("livekit") val livekit: LiveKitTokenDto,
)

data class SeatsResponse(@SerializedName("seats") val seats: List<SeatDto>)

/**
 * `POST /api/rooms/:id/seat` — the only seat route with two answers.
 *
 * An approval-enabled room replies 202 `{requested, request}` and seats nobody, so both keys are
 * nullable here and the mapper decides which half of [com.voiza.app.domain.model.SeatTakeResult]
 * the body describes. Reading `seats` out of a 202 the way the other seat routes do would hand the
 * caller a list that is null because it was never sent.
 */
data class TakeSeatResponse(
    @SerializedName("seats") val seats: List<SeatDto>? = null,
    @SerializedName("livekit") val livekit: LiveKitTokenDto? = null,
    @SerializedName("requested") val requested: Boolean? = null,
    @SerializedName("request") val request: SpeakerRequestDto? = null,
)

/**
 * One line of the host's speaker queue. `user` is nullable the way every wire user is here: an
 * account deleted after the request was filed still has a row, and the queue must show it rather
 * than drop it.
 */
data class SpeakerRequestDto(
    @SerializedName("id") val id: String,
    @SerializedName("roomId") val roomId: String,
    @SerializedName("seatIndex") val seatIndex: Int,
    @SerializedName("status") val status: String = "PENDING",
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("user") val user: MiniUserDto? = null,
)

/** `GET /api/rooms/:id/speaker-requests`, already in the server's first-come order. */
data class SpeakerRequestsResponse(
    // Nullable, not `= emptyList()`: Gson leaves an absent key null and never runs the default,
    // so an empty queue that the server omitted entirely has to read as empty here.
    @SerializedName("requests") val requests: List<SpeakerRequestDto>? = null,
)

/** `POST /api/rooms/:id/speaker-requests/:requestId/approve` — the seat list follows the decision. */
data class ApproveSpeakerRequestResponse(
    @SerializedName("request") val request: SpeakerRequestDto? = null,
    @SerializedName("seats") val seats: List<SeatDto>? = null,
)

/** `POST /api/rooms/:id/speaker-requests/:requestId/reject`. */
data class RejectSpeakerRequestResponse(
    @SerializedName("request") val request: SpeakerRequestDto? = null,
)

data class SpeakerCancelResponse(
    @SerializedName("ok") val ok: Boolean = true,
    @SerializedName("cancelled") val cancelled: Int = 0,
)

/** `POST /api/rooms/:id/seat/:index/invite` — a host seats a member already in the audience. */
data class SeatInviteBody(@SerializedName("userId") val userId: String)

/**
 * `POST /api/rooms/:id/announcement`. An empty string clears the notice; the route exists so a
 * phone can change one line without resending the whole room profile.
 */
data class AnnouncementBody(@SerializedName("announcement") val announcement: String)

data class SeatStatusBody(@SerializedName("locked") val locked: Boolean)

data class SeatMuteBody(@SerializedName("muted") val muted: Boolean)

data class HandRaiseBody(@SerializedName("raise") val raise: Boolean)

data class HandRaiseResponse(
    @SerializedName("ok") val ok: Boolean,
    @SerializedName("raised") val raised: Boolean,
)

data class OkResponse(@SerializedName("ok") val ok: Boolean)

/**
 * OkHttp refuses a `POST` that carries no body at all, so a POST the server reads only from the
 * token still has to send one. Gson writes this class as `{}`, which those routes ignore.
 */
class EmptyRequestBody

data class UpdateProfileBody(
    @SerializedName("username") val username: String? = null,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("bio") val bio: String? = null,
)

data class GiftDto(
    @SerializedName("id") val id: String,
    @SerializedName("name") val name: String,
    @SerializedName("iconUrl") val iconUrl: String,
    @SerializedName("animationUrl") val animationUrl: String? = null,
    @SerializedName("diamondPrice") val diamondPrice: Int,
    @SerializedName("rCoinValue") val rCoinValue: Int,
    @SerializedName("category") val category: String = "SPECIAL",
    @SerializedName("soundUrl") val soundUrl: String? = null,
    @SerializedName("minVipLevel") val minVipLevel: Int = 0,
    @SerializedName("sortOrder") val sortOrder: Int? = null,
    // TICKER | FULLSCREEN — how loud the gift plays. Nullable: Gson skips the
    // default initializer for an absent key, and an old backend omits it entirely.
    @SerializedName("effectKind") val effectKind: String? = null,
    /** LOTTIE | SVGA | MP4 — which renderer opens [animationUrl]. */
    @SerializedName("animationFormat") val animationFormat: String? = null,
    @SerializedName("durationMs") val durationMs: Int? = null,
    @SerializedName("displayPriority") val displayPriority: Int? = null,
    @SerializedName("comboEnabled") val comboEnabled: Boolean? = null,
    @SerializedName("comboWindowMs") val comboWindowMs: Int? = null,
    /**
     * Present only on a box, and absent — not `false` — on every other gift, which is how a device
     * tells "this gift rolls nothing" from "this box has no prizes configured".
     */
    @SerializedName("isLuckyBox") val isLuckyBox: Boolean? = null,
    @SerializedName("receiverShareBps") val receiverShareBps: Int? = null,
    /** The published odds. Only the operator's own catalogue route adds `weight`; this one cannot. */
    @SerializedName("boxOutcomes") val boxOutcomes: List<GiftBoxOutcomeDto>? = null,
)

/** One disclosed prize of a lucky box. */
data class GiftBoxOutcomeDto(
    @SerializedName("label") val label: String = "",
    @SerializedName("multiplierBps") val multiplierBps: Int = 0,
    @SerializedName("chanceBps") val chanceBps: Int = 0,
)

/** One prize that came up in a draw, counted. */
data class LuckyPrizeDto(
    @SerializedName("label") val label: String = "",
    @SerializedName("multiplierBps") val multiplierBps: Int = 0,
    @SerializedName("chanceBps") val chanceBps: Int? = null,
    @SerializedName("count") val count: Int? = null,
)

/**
 * `lucky` on a gift event, a replay and the ledger row's `meta`: the draw that set this gift's
 * credit. Every field is nullable because Gson's `Unsafe` allocator does not run the Kotlin
 * initialiser for a key the server left out, and a `0` read as a payout would be a lie about money.
 */
data class LuckyRollDto(
    @SerializedName("outcomes") val outcomes: List<LuckyPrizeDto>? = null,
    @SerializedName("headline") val headline: LuckyPrizeDto? = null,
    @SerializedName("grossRCoins") val grossRCoins: Long? = null,
    @SerializedName("receiverRCoins") val receiverRCoins: Long? = null,
    @SerializedName("platformTaxRCoins") val platformTaxRCoins: Long? = null,
    @SerializedName("receiverShareBps") val receiverShareBps: Int? = null,
)

data class GiftsResponse(
    @SerializedName("gifts") val gifts: List<GiftDto>,
    /**
     * The operator-managed shelves from migration 0025, already sorted by `sortOrder`. Nullable
     * because an older server omits the key entirely and Gson's Unsafe allocator skips the Kotlin
     * default for absent keys — callers read null as "no shelf list" and derive tabs from [gifts].
     */
    @SerializedName("categories") val categories: List<GiftCategoryDto>? = null,
)

/**
 * One gift shelf as the operator maintains it. Every field is nullable for the same reason:
 * a key Gson does not see stays at the JVM zero value, never at a Kotlin default.
 */
data class GiftCategoryDto(
    @SerializedName("key") val key: String? = null,
    @SerializedName("name") val name: String? = null,
    @SerializedName("sortOrder") val sortOrder: Int? = null,
)

/**
 * `POST /api/gifts/send`.
 *
 * [idempotencyKey] is generated once per Send tap and reused by every retry of that tap, so the
 * server can answer a request whose response was lost with the gift it already bought instead of
 * buying a second one. Absent means "no replay protection", which is what an app built before the
 * gift engine sends.
 */
data class SendGiftBody(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("receiverId") val receiverId: String,
    @SerializedName("giftId") val giftId: String,
    @SerializedName("quantity") val quantity: Int,
    @SerializedName("idempotencyKey") val idempotencyKey: String? = null,
)

/** The server's combo tally for the gift that was just paid for. */
data class GiftComboDto(
    @SerializedName("comboId") val comboId: String? = null,
    @SerializedName("count") val count: Int = 1,
)

data class SendGiftResponse(
    @SerializedName("transaction") val transaction: TransactionDto,
    @SerializedName("sender") val sender: MiniUserDto,
    @SerializedName("receiver") val receiver: MiniUserDto,
    @SerializedName("gift") val gift: GiftDto? = null,
    /** TRUE when the server answered an existing transaction rather than buying a new one. */
    @SerializedName("replayed") val replayed: Boolean? = null,
    @SerializedName("combo") val combo: GiftComboDto? = null,
)

data class TransactionDto(
    @SerializedName("id") val id: String,
    @SerializedName("type") val type: String,
    @SerializedName("amountDiamonds") val amountDiamonds: Int = 0,
    @SerializedName("amountRCoins") val amountRCoins: Int = 0,
    @SerializedName("giftName") val giftName: String? = null,
    @SerializedName("sender") val sender: MiniUserDto? = null,
    @SerializedName("receiver") val receiver: MiniUserDto? = null,
    @SerializedName("createdAt") val createdAt: String = "",
)

/**
 * One row of `GET /api/rooms/:id/gifts` — the gifts a room has just animated.
 *
 * Same idea as [com.voiza.app.data.remote.dto.SocketGiftAnimatedDto] but without the combo tally
 * (a window that has closed is not worth counting) and with no `roomId`, because the room is what
 * the URL already said. [eventId] is the transaction id, which is exactly the id the socket event
 * for the same gift carried, so a device that saw it live can drop this row.
 */
data class RoomGiftEventDto(
    @SerializedName("eventId") val eventId: String,
    @SerializedName("gift") val gift: GiftDto,
    @SerializedName("sender") val sender: MiniUserDto,
    @SerializedName("receiver") val receiver: MiniUserDto,
    @SerializedName("seatIndex") val seatIndex: Int? = null,
    @SerializedName("quantity") val quantity: Int = 1,
    @SerializedName("totalDiamonds") val totalDiamonds: Long = 0,
    @SerializedName("totalRCoins") val totalRCoins: Long = 0,
    @SerializedName("createdAt") val createdAt: String = "",
    /** What the box rolled for this row, read off the ledger row the same way the socket event has it. */
    @SerializedName("lucky") val lucky: LuckyRollDto? = null,
)

data class WalletStatsDto(
    @SerializedName("diamondsSpent") val diamondsSpent: Long = 0,
    @SerializedName("rCoinsEarned") val rCoinsEarned: Long = 0,
    @SerializedName("giftsSent") val giftsSent: Long = 0,
)

data class WalletResponse(
    @SerializedName("user") val user: UserDto,
    @SerializedName("transactions") val transactions: List<TransactionDto> = emptyList(),
    @SerializedName("stats") val stats: WalletStatsDto = WalletStatsDto(),
    @SerializedName("withdrawalPolicy") val withdrawalPolicy: WithdrawalPolicyDto? = null,
    @SerializedName("promo") val promo: PromoSnapshotDto? = null,
)

/**
 * The bonus pocket as the server owns it: the grants behind the number and what the operator lets
 * them buy. Absent on an older backend, which is why every field below is optional.
 */
data class PromoSnapshotDto(
    @SerializedName("grants") val grants: List<PromoGrantDto> = emptyList(),
    @SerializedName("policy") val policy: PromoPolicyDto = PromoPolicyDto(),
)

data class PromoGrantDto(
    @SerializedName("remaining") val remaining: Int = 0,
    @SerializedName("status") val status: String = "",
    @SerializedName("sourceKind") val sourceKind: String = "",
    @SerializedName("reason") val reason: String = "",
    @SerializedName("expiresAt") val expiresAt: String = "",
)

/** `accounts.promotional`, as far as this screen needs it: which purchases take bonus coins. */
data class PromoPolicyDto(
    @SerializedName("usableFor") val usableFor: List<String> = emptyList(),
)

/** The operator's cash-out dial (`accounts.withdrawal`), as the ledger reads it. Absent on an older backend. */
data class WithdrawalPolicyDto(
    @SerializedName("minRCoins") val minRCoins: Int? = null,
    @SerializedName("feeBps") val feeBps: Int? = null,
)

data class RechargeBody(@SerializedName("amountDiamonds") val amountDiamonds: Int)

data class RechargeResponse(
    @SerializedName("transaction") val transaction: TransactionDto,
    @SerializedName("user") val user: UserDto,
)

data class WithdrawBody(
    @SerializedName("amountRCoins") val amountRCoins: Int,
    @SerializedName("payoutMethod") val payoutMethod: String,
    @SerializedName("payoutDetails") val payoutDetails: Map<String, String>,
)

data class WithdrawalDto(
    @SerializedName("id") val id: String,
    @SerializedName("amountRCoins") val amountRCoins: Int = 0,
    /** What the platform keeps of this request. The server decides it when the request is made. */
    @SerializedName("feeRCoins") val feeRCoins: Int = 0,
    /** What the host is paid. Sent, never added up here. */
    @SerializedName("netRCoins") val netRCoins: Int = 0,
    @SerializedName("status") val status: String = "PENDING",
    @SerializedName("payoutMethod") val payoutMethod: String = "BANK",
)

data class WithdrawResponse(@SerializedName("withdrawal") val withdrawal: WithdrawalDto)

data class ChatMessageDto(
    @SerializedName("id") val id: String,
    @SerializedName("user") val user: MiniUserDto? = null,
    @SerializedName("content") val content: String,
    @SerializedName("type") val type: String = "TEXT",
    @SerializedName("createdAt") val createdAt: String = "",
)

/** One row of GET /api/users/top; `earned` is r-coins or diamonds per board. */
data class LeaderEntryDto(
    @SerializedName("id") val id: String,
    @SerializedName("username") val username: String,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("earned") val earned: Long? = null,
    @SerializedName("rank") val rank: RankDto? = null,
)

data class LeaderboardResponse(
    @SerializedName("window") val window: String? = null,
    /** receivers = who earned, senders = who spent. */
    @SerializedName("role") val role: String? = null,
    @SerializedName("leaders") val leaders: List<LeaderEntryDto>? = null,
)

/**
 * One row of `GET /api/store`, i.e. what is on sale plus what *this* member holds.
 *
 * `owned` and `equipped` are per-caller answers from the server, never derived here: a modified
 * client that flips them changes only what it draws. `expiresAt` is null for a purchase that
 * never runs out, and `equipped` is only ever true for a frame, an effect or a ride — a theme is
 * worn by a room, not by an account.
 */
data class StoreItemDto(
    @SerializedName("kind") val kind: String? = null,
    @SerializedName("key") val key: String? = null,
    @SerializedName("name") val name: String? = null,
    @SerializedName("art") val art: String? = null,
    @SerializedName("accent") val accent: String? = null,
    @SerializedName("priceDiamonds") val priceDiamonds: Int = 0,
    @SerializedName("periodDays") val periodDays: Int? = null,
    @SerializedName("owned") val owned: Boolean = false,
    @SerializedName("expiresAt") val expiresAt: String? = null,
    @SerializedName("equipped") val equipped: Boolean = false,
    // Nullable by project rule: Gson runs with Unsafe, so an absent key takes the JVM zero value,
    // NOT these Kotlin defaults. The mapper applies the real fallback (`?: 0` / `?: false`), so an
    // older backend that omits these reads as "anybody can buy, not recommended" rather than a lie.
    @SerializedName("minVipLevel") val minVipLevel: Int? = null,
    @SerializedName("recommended") val recommended: Boolean? = null,
    // RIDE rows only, and nullable for both reasons: the other three catalogues never send them,
    // and Gson's Unsafe allocator leaves an absent key null rather than running the Kotlin
    // default. The mapper owns the fallbacks (LOTTIE for an unknown/missing format, 0 for a
    // missing duration), so an older backend that has no rides still parses every row it does send.
    @SerializedName("animationFormat") val animationFormat: String? = null,
    @SerializedName("durationMs") val durationMs: Int? = null,
)

/** What the member holds, including rows an operator has since retired from the shop. */
data class OwnedStoreItemDto(
    @SerializedName("kind") val kind: String? = null,
    @SerializedName("key") val key: String? = null,
    @SerializedName("name") val name: String? = null,
    @SerializedName("art") val art: String? = null,
    @SerializedName("onSale") val onSale: Boolean = false,
    @SerializedName("expiresAt") val expiresAt: String? = null,
    @SerializedName("acquiredVia") val acquiredVia: String? = null,
)

data class StoreResponse(
    @SerializedName("items") val items: List<StoreItemDto>? = null,
    @SerializedName("owned") val owned: List<OwnedStoreItemDto>? = null,
)

/** The only two fields the purchase/equip routes accept: a kind and a key, never a price. */
data class StoreItemBody(
    @SerializedName("kind") val kind: String,
    @SerializedName("key") val key: String? = null,
)

/** 201 from POST /api/store/purchase: the deed, the receipt, and the wallet that paid. */
data class StorePurchaseResponse(
    @SerializedName("item") val item: StoreItemDto? = null,
    @SerializedName("transaction") val transaction: TransactionDto? = null,
    @SerializedName("wallet") val wallet: UserDto? = null,
)

// ---------------------------------------------------------------------------
// Promotional banners (GET /api/banners, migration 0028)
// ---------------------------------------------------------------------------

/**
 * One live campaign row.
 *
 * Every field is nullable because Gson allocates these data classes without running the constructor,
 * so a key the server omits stays at the JVM zero value rather than a Kotlin default — the mapper
 * decides what an absent field means, and a row missing the two things it cannot be drawn or counted
 * without is dropped rather than guessed at.
 */
data class BannerDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("key") val key: String? = null,
    /** SPLASH | HOME | GIFT | GAME. */
    @SerializedName("placement") val placement: String? = null,
    @SerializedName("title") val title: String? = null,
    @SerializedName("subtitle") val subtitle: String? = null,
    @SerializedName("url") val url: String? = null,
    /** PNG | GIF | WEBP | JPEG | LOTTIE | SVGA | MP4 — which renderer opens [url]. */
    @SerializedName("format") val format: String? = null,
    @SerializedName("durationMs") val durationMs: Int? = null,
    /** NONE | INTERNAL | ROOM | URL — the verb [ctaValue] belongs to. Never read without it. */
    @SerializedName("ctaType") val ctaType: String? = null,
    @SerializedName("ctaValue") val ctaValue: String? = null,
)

data class BannersResponse(
    @SerializedName("banners") val banners: List<BannerDto>? = null,
)

/** POST /api/banners/track. One look or one tap on one row; the server owns both counters. */
data class BannerTrackBody(
    @SerializedName("id") val id: String,
    /** IMPRESSION | TAP. */
    @SerializedName("event") val event: String,
)

// ---------------------------------------------------------------------------
// Social moderation: follows, blocks and reports between two members
// (GET/POST/DELETE /api/users/:id/…).
//
// Every field here is nullable that the server may omit, and the mapper decides what an omission
// means. Gson builds these without running the defaults, so a key that is not in the body arrives
// as null rather than as the value written below.
// ---------------------------------------------------------------------------

/**
 * `GET /api/users/:id/relationship` — how the caller stands to one member.
 *
 * [interactionBlocked] is the server's own conclusion that either side blocked the other. It is
 * read rather than re-derived from the two flags because the rule about which interactions a block
 * stops lives in the backend, not here.
 */
data class RelationshipDto(
    @SerializedName("following") val following: Boolean? = null,
    @SerializedName("blockedByMe") val blockedByMe: Boolean? = null,
    @SerializedName("blockedByThem") val blockedByThem: Boolean? = null,
    @SerializedName("interactionBlocked") val interactionBlocked: Boolean? = null,
)

/**
 * `POST`/`DELETE /api/users/:id/follow`. Only the new state is read; the counts the server also
 * sends belong to a profile screen this app does not have.
 */
data class FollowResponse(
    @SerializedName("following") val following: Boolean? = null,
)

/** `POST`/`DELETE /api/users/:id/block`, same shape as the follow answer. */
data class BlockResponse(
    @SerializedName("blocked") val blocked: Boolean? = null,
)

/**
 * `POST /api/users/:id/block`. [reason] is the blocker's private note for their own list — the
 * blocked member is told only that the interaction closed, never why — and blank means no note.
 */
data class BlockBody(
    @SerializedName("reason") val reason: String? = null,
)

/**
 * `POST /api/users/:id/report`. [reason] is one of the six strings the server accepts and refuses
 * anything else; [roomId] is where it happened, so the operator's queue can open the room.
 */
data class ReportBody(
    @SerializedName("reason") val reason: String,
    @SerializedName("details") val details: String? = null,
    @SerializedName("roomId") val roomId: String? = null,
)

/**
 * The row the report endpoint writes. Nothing on this screen shows it — the phone's answer is the
 * 201 itself — but the envelope is modelled so the call has a real type to parse into instead of a
 * shape it invented.
 */
data class ReportDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("reason") val reason: String? = null,
    /** PENDING until an operator moves it. A report is never an automatic ban. */
    @SerializedName("status") val status: String? = null,
)

data class ReportResponse(
    @SerializedName("report") val report: ReportDto? = null,
)
