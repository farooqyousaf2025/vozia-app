package com.voiza.app.domain.repository

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.ChatMessage
import com.voiza.app.domain.model.EmojiCatalogue
import com.voiza.app.domain.model.GameDefinition
import com.voiza.app.domain.model.GameHistoryRow
import com.voiza.app.domain.model.GameSession
import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.Leaderboard
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.Room
import com.voiza.app.domain.model.RoomJoinResult
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatPolicy
import com.voiza.app.domain.model.ThemeCatalogue
import com.voiza.app.domain.model.Transaction
import com.voiza.app.domain.model.User
import com.voiza.app.domain.model.WalletSnapshot
import com.voiza.app.domain.model.Withdrawal
import kotlinx.coroutines.flow.StateFlow

// ---------------------------------------------------------------------------
// Repository contracts (implemented in data/repository/, wired manually in
// di/ServiceLocator). ViewModels consume use cases / these interfaces only.
// ---------------------------------------------------------------------------

interface AuthRepository {
    /** Live session user (null while logged out). */
    val currentUser: StateFlow<User?>

    suspend fun requestOtp(phone: String): ApiResult<OtpChallenge>
    suspend fun verifyOtp(phone: String, code: String, username: String?): ApiResult<User>
    suspend fun refreshMe(): ApiResult<User>
    suspend fun updateProfile(
        username: String? = null,
        avatarUrl: String? = null,
        bio: String? = null,
    ): ApiResult<User>

    fun logout()
}

/** POST /api/auth/request-otp result. devCode present in backend dev mode. */
data class OtpChallenge(val sent: Boolean, val devCode: String?)

interface RoomRepository {
    /**
     * The lobby list. Filters and ordering are query parameters because the server owns them:
     * a client that sorted 40 fetched rooms locally would show each phone a different "trending".
     */
    suspend fun listRooms(
        category: String?,
        limit: Int?,
        search: String? = null,
        sort: String? = null,
        language: String? = null,
        region: String? = null,
    ): ApiResult<List<RoomSummary>>

    /**
     * The seat bounds the administrator owns. A failure here is not an error the host needs to
     * see: the form then sends no capacity and the server applies its own default.
     */
    suspend fun seatPolicy(): ApiResult<SeatPolicy>

    /**
     * The decoration catalogue the operator owns: theme wallpapers, and the Lottie flourish a room
     * plays when someone joins. A failure is not worth showing the member either — the room simply
     * wears the wallpaper the server already named for it and plays no flourish.
     */
    suspend fun themeCatalogue(): ApiResult<ThemeCatalogue>

    /**
     * The chat emoji an operator maintains in the admin panel, plus the expression a message is
     * scanned with. Again not an error worth showing: with no catalogue the picker is empty and
     * a typed `[code]` simply stays text.
     */
    suspend fun emojiCatalogue(): ApiResult<EmojiCatalogue>

    /** Quick Join: one open public room the caller is allowed to enter, chosen by the server. */
    suspend fun quickJoin(): ApiResult<Room>

    /** My Room: the rooms this member hosts, open ones first. */
    suspend fun myRooms(limit: Int? = null): ApiResult<List<RoomSummary>>

    suspend fun createRoom(
        title: String,
        description: String?,
        category: String?,
        type: String?,
        password: String?,
        seatCapacity: Int?,
        language: String? = null,
        region: String? = null,
        rules: String? = null,
    ): ApiResult<Room>

    /**
     * Host-only edit. A null argument is left alone; an empty string clears that field.
     * Language and region are normalized (and refused) by the server, not by this client.
     */
    suspend fun updateRoom(
        roomId: String,
        title: String? = null,
        description: String? = null,
        category: String? = null,
        coverUrl: String? = null,
        language: String? = null,
        region: String? = null,
        rules: String? = null,
    ): ApiResult<Room>

    /** Eligible rooms only: closed, and with no member or ledger history to erase. */
    suspend fun deleteRoom(roomId: String): ApiResult<Boolean>

    suspend fun getRoom(roomId: String): ApiResult<RoomDetailBundle>
    suspend fun joinRoom(roomId: String, password: String?): ApiResult<RoomJoinResult>
    suspend fun leaveRoom(roomId: String): ApiResult<Boolean>

    suspend fun takeSeat(roomId: String, seatIndex: Int): ApiResult<List<Seat>>
    suspend fun leaveSeat(roomId: String, seatIndex: Int): ApiResult<List<Seat>>
    suspend fun lockSeat(roomId: String, seatIndex: Int, locked: Boolean): ApiResult<List<Seat>>
    suspend fun muteSeat(roomId: String, seatIndex: Int, muted: Boolean): ApiResult<List<Seat>>
    suspend fun kickFromSeat(roomId: String, seatIndex: Int): ApiResult<List<Seat>>

    suspend fun raiseHand(roomId: String, raise: Boolean): ApiResult<Boolean>
    suspend fun closeRoom(roomId: String): ApiResult<Boolean>
    suspend fun fetchLiveKitToken(roomId: String): ApiResult<com.voiza.app.domain.model.LiveKitCredentials>

    suspend fun sendChat(roomId: String, message: String)
}

/** Static GET /api/rooms/:id snapshot. */
data class RoomDetailBundle(
    val room: Room,
    val seats: List<Seat>,
    val audience: List<MiniUser>,
    val chat: List<ChatMessage>,
    /** Audience members currently in the request-to-speak queue. */
    val handRaises: List<MiniUser> = emptyList(),
)

interface WalletRepository {
    suspend fun getWallet(): ApiResult<WalletSnapshot>
    suspend fun recharge(amountDiamonds: Int): ApiResult<Transaction>
    suspend fun withdraw(amountRCoins: Int, payoutMethod: String, payoutDetails: Map<String, String>): ApiResult<Withdrawal>
}

interface GiftRepository {
    suspend fun getGifts(): ApiResult<List<Gift>>
    suspend fun sendGift(
        roomId: String,
        receiverId: String,
        giftId: String,
        quantity: Int,
    ): ApiResult<Transaction>

    /**
     * GET /api/users/top. `window` is day | week | month; the board selects
     * whether the room ranks spenders or earners.
     */
    suspend fun getLeaderboard(window: String, board: RankBoard): ApiResult<Leaderboard>
}

/**
 * Games. A session always belongs to a room — the backend requires a `roomId` when
 * one is opened, because the entry fee, the host's rules version and the settlement
 * are all decided inside that room.
 */
interface GameRepository {
    /** What may be played, plus the matches already running in this room. */
    suspend fun lobby(roomId: String): ApiResult<GameLobbyBundle>

    suspend fun session(sessionId: String): ApiResult<GameSession>
    suspend fun history(limit: Int = 20): ApiResult<List<GameHistoryRow>>

    suspend fun create(gameKey: String, roomId: String): ApiResult<GameSession>
    suspend fun join(sessionId: String): ApiResult<GameSession>
    suspend fun setReady(sessionId: String): ApiResult<GameSession>
    suspend fun start(sessionId: String): ApiResult<GameSession>

    /** A move: `type` is MOVE / ANSWER / ROLL, and `payload` carries only its coordinates. */
    suspend fun action(sessionId: String, type: String, payload: Map<String, Any?>): ApiResult<GameSession>

    suspend fun leave(sessionId: String): ApiResult<GameSession>
    suspend fun cancel(sessionId: String, reason: String): ApiResult<GameSession>
    suspend fun dispute(sessionId: String, reason: String): ApiResult<Boolean>
}

/** GET /api/games?roomId=: the catalogue the host may open, and the room's live matches. */
data class GameLobbyBundle(
    val games: List<GameDefinition>,
    val sessions: List<GameSession>,
)
