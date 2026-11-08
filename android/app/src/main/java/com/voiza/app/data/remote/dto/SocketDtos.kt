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
    // These three arrived with the pinned notice and the approval switch. A profile edit from an
    // older server omits them, and the room keeps what it already showed rather than blanking it.
    @SerializedName("announcement") val announcement: String? = null,
    @SerializedName("announcementUpdatedAt") val announcementUpdatedAt: String? = null,
    @SerializedName("speakerApprovalRequired") val speakerApprovalRequired: Boolean? = null,
)

/**
 * `room:announcement`, also emitted when an operator pins from the admin panel. A null `announcement`
 * is the notice being cleared, which is why this is its own event rather than a profile field.
 */
data class SocketAnnouncementDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("announcement") val announcement: String? = null,
    @SerializedName("updatedAt") val updatedAt: String? = null,
)

/**
 * Private `room:seat_invited`. The host's invitation already seated us and granted the microphone;
 * `livekit` is the publisher token that goes with it, so the app never has to ask whether it may
 * open the mic.
 */
data class SocketSeatInvitedDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("seatIndex") val seatIndex: Int,
    @SerializedName("livekit") val livekit: LiveKitTokenDto? = null,
)

/**
 * Private `room:speaker_decision`: the host answered our request to speak. `livekit` rides along on
 * an approval and is absent on a rejection, because a rejected member has no seat to publish from.
 */
data class SocketSpeakerDecisionDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("status") val status: String = "PENDING",
    @SerializedName("request") val request: SpeakerRequestDto? = null,
    @SerializedName("seatIndex") val seatIndex: Int? = null,
    @SerializedName("livekit") val livekit: LiveKitTokenDto? = null,
)

/**
 * `room:speaker_request` (a request was just filed) and `room:speaker_request_updated` (one was
 * decided or cancelled), both to the room. The client treats them the same way: the queue it holds
 * is stale, so the host re-reads the server's list rather than editing its own copy.
 */
data class SocketSpeakerRequestChangedDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("request") val request: SpeakerRequestDto? = null,
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
    /** Sent when an operator mints bonus diamonds; null keeps the copy already on the phone. */
    @SerializedName("promoDiamondBalance") val promoDiamondBalance: Int? = null,
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
    /** The paid transaction's id: the key this event and the room's history agree on. */
    @SerializedName("eventId") val eventId: String? = null,
    @SerializedName("comboId") val comboId: String? = null,
    @SerializedName("comboCount") val comboCount: Int? = null,
    /** The draw that set [totalRCoins] when the gift is a lucky box; null for every other gift. */
    @SerializedName("lucky") val lucky: LuckyRollDto? = null,
)

/**
 * `room:gift_history`: the gifts this device missed while its socket was down, addressed to it
 * alone when it joins a room. Rows carry the same [RoomGiftEventDto.eventId] the live
 * `room:gift_animated` events used, so a gift that arrived twice — once here, once live — is
 * recognised as one gift and animates once.
 */
data class SocketGiftHistoryDto(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("gifts") val gifts: List<RoomGiftEventDto>,
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

/**
 * `room:reaction`: one of the operator's chat emoji, flown across the room for a second and then
 * forgotten. The art is the server's, not the tap's — the emitting device sends only the `key`, and
 * what everyone animates is the row `emoji_characters` holds for it at that moment. Every field is
 * nullable because Gson leaves an absent key null, and an emit missing its art is a reaction nobody
 * can draw.
 */
data class SocketReactionDto(
    @SerializedName("roomId") val roomId: String? = null,
    @SerializedName("userId") val userId: String? = null,
    @SerializedName("key") val key: String? = null,
    @SerializedName("code") val code: String? = null,
    @SerializedName("url") val url: String? = null,
    @SerializedName("label") val label: String? = null,
)

/** `game:ended` only names the match; the session itself arrives on `game:update`. */
data class SocketGameEndedDto(
    @SerializedName("sessionId") val sessionId: String,
)
