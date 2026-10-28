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

data class SeatStatusBody(@SerializedName("locked") val locked: Boolean)

data class SeatMuteBody(@SerializedName("muted") val muted: Boolean)

data class HandRaiseBody(@SerializedName("raise") val raise: Boolean)

data class HandRaiseResponse(
    @SerializedName("ok") val ok: Boolean,
    @SerializedName("raised") val raised: Boolean,
)

data class OkResponse(@SerializedName("ok") val ok: Boolean)

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
)

data class GiftsResponse(@SerializedName("gifts") val gifts: List<GiftDto>)

data class SendGiftBody(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("receiverId") val receiverId: String,
    @SerializedName("giftId") val giftId: String,
    @SerializedName("quantity") val quantity: Int,
)

data class SendGiftResponse(
    @SerializedName("transaction") val transaction: TransactionDto,
    @SerializedName("sender") val sender: MiniUserDto,
    @SerializedName("receiver") val receiver: MiniUserDto,
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

data class WalletStatsDto(
    @SerializedName("diamondsSpent") val diamondsSpent: Long = 0,
    @SerializedName("rCoinsEarned") val rCoinsEarned: Long = 0,
    @SerializedName("giftsSent") val giftsSent: Long = 0,
)

data class WalletResponse(
    @SerializedName("user") val user: UserDto,
    @SerializedName("transactions") val transactions: List<TransactionDto> = emptyList(),
    @SerializedName("stats") val stats: WalletStatsDto = WalletStatsDto(),
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
 * never runs out, and `equipped` is only ever true for a frame or an effect — a theme is worn by
 * a room, not by an account.
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
