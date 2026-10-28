package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// Socket.IO server->client payload DTOs. Each event carries `roomId`; the
// room ViewModel filters on it. Parsed by Gson from the socket args.
// ---------------------------------------------------------------------------

data class SocketChatDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("id") val id: String,
    @SerializedName("user") val user: MiniUserDto? = null,
    @SerializedName("content") val content: String,
    @SerializedName("type") val type: String = "TEXT",
    @SerializedName("createdAt") val createdAt: String = "",
)

data class SocketSeatUpdateDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("seats") val seats: List<SeatDto> = emptyList(),
    @SerializedName("audience") val audience: List<MiniUserDto> = emptyList(),
)

data class SocketListenerCountDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("count") val count: Int,
)

data class SocketUserJoinedDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("user") val user: MiniUserDto,
)

data class SocketUserLeftDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("userId") val userId: String,
)

data class SocketMicToggleDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("seatIndex") val seatIndex: Int,
    @SerializedName("muted") val muted: Boolean,
)

data class SocketRoomClosedDto(
    @SerializedName("roomId") val roomId: String,
)

/**
 * `room:theme_changed`: host or ops restyled the room, so swap the wallpaper.
 * The server sends the URL with the slug because this client must not build one from it.
 */
data class SocketThemeChangedDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("theme") val theme: String,
    @SerializedName("wallpaper") val wallpaper: String? = null,
)

/**
 * `room:profile_updated`: the host edited the room, and the server sends the profile as it now
 * stands — a null here means that field is empty, not "the edit said nothing about it".
 */
data class SocketRoomProfileDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("title") val title: String,
    @SerializedName("description") val description: String? = null,
    @SerializedName("category") val category: String,
    @SerializedName("language") val language: String? = null,
    @SerializedName("region") val region: String? = null,
    @SerializedName("rules") val rules: String? = null,
)

/** Private `room:kicked` on the user channel: the host removed us from the seat. */
data class SocketKickedDto(
    @SerializedName("roomId") val roomId: String,
)

/** Private `room:warning` on the user channel: an operator addressed the host. */
data class SocketWarningDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("message") val message: String,
)

/** `room:hand_raise`: an audience member raised (or lowered) their hand. */
data class SocketHandRaiseDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("raised") val raised: Boolean = false,
    @SerializedName("user") val user: MiniUserDto? = null,
)

/**
 * Private `wallet:update` on the user channel. The server sends only the side it
 * changed — the sender of a gift gets `diamondBalance`, the receiver `rCoinBalance`,
 * an operator adjustment both — so each field is optional and `null` means "keep the
 * copy we already have".
 */
data class SocketWalletUpdateDto(
    @SerializedName("diamondBalance") val diamondBalance: Int? = null,
    @SerializedName("rCoinBalance") val rCoinBalance: Int? = null,
)

data class SocketGiftAnimatedDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("gift") val gift: GiftDto,
    @SerializedName("sender") val sender: MiniUserDto,
    @SerializedName("receiver") val receiver: MiniUserDto,
    @SerializedName("quantity") val quantity: Int = 1,
    @SerializedName("animationUrl") val animationUrl: String? = null,
    @SerializedName("totalDiamonds") val totalDiamonds: Long = 0,
    @SerializedName("totalRCoins") val totalRCoins: Long = 0,
    @SerializedName("seatIndex") val seatIndex: Int? = null,
)

/**
 * `room:liked`: a counted batch, not one event per tap. `count` is what this
 * window added and `total` is the server's running number for the room, so the
 * client never has to trust — or sum — what its own taps reported.
 */
data class SocketLikeDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("count") val count: Int,
    @SerializedName("total") val total: Long,
    @SerializedName("user") val user: MiniUserDto? = null,
)

/** `game:ended` only names the match; the session itself arrives on `game:update`. */
data class SocketGameEndedDto(
    @SerializedName("sessionId") val sessionId: String,
)
