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

data class MiniUserDto(
    @SerializedName("id") val id: String,
    @SerializedName("username") val username: String,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("diamondBalance") val diamondBalance: Int? = null,
    // Only present on the payloads that size an effect from it (room:user_joined).
    @SerializedName("vipLevel") val vipLevel: Int? = null,
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
)

data class LeaderboardResponse(
    @SerializedName("window") val window: String? = null,
    /** receivers = who earned, senders = who spent. */
    @SerializedName("role") val role: String? = null,
    @SerializedName("leaders") val leaders: List<LeaderEntryDto>? = null,
)
