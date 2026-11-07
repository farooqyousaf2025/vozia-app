package com.voiza.app.domain.repository

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.BannerPlacement
import com.voiza.app.domain.model.ChatMessage
import com.voiza.app.domain.model.CheckInResult
import com.voiza.app.domain.model.EmojiCatalogue
import com.voiza.app.domain.model.GameDefinition
import com.voiza.app.domain.model.GameHistoryRow
import com.voiza.app.domain.model.GameSession
import com.voiza.app.domain.model.GiftCatalogue
import com.voiza.app.domain.model.Leaderboard
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.PkBattle
import com.voiza.app.domain.model.PkSettings
import com.voiza.app.domain.model.PromoBanner
import com.voiza.app.domain.model.QuestsToday
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.Relationship
import com.voiza.app.domain.model.ReportReason
import com.voiza.app.domain.model.Room
import com.voiza.app.domain.model.RoomJoinResult
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatPolicy
import com.voiza.app.domain.model.SeatTakeResult
import com.voiza.app.domain.model.SpeakerRequest
import com.voiza.app.domain.model.SendGiftOutcome
import com.voiza.app.domain.model.StoreItemKind
import com.voiza.app.domain.model.StorePurchase
import com.voiza.app.domain.model.StoreSnapshot
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
        speakerApprovalRequired: Boolean? = null,
    ): ApiResult<Room>

    /** Eligible rooms only: closed, and with no member or ledger history to erase. */
    suspend fun deleteRoom(roomId: String): ApiResult<Boolean>

    suspend fun getRoom(roomId: String): ApiResult<RoomDetailBundle>
    suspend fun joinRoom(roomId: String, password: String?): ApiResult<RoomJoinResult>
    suspend fun leaveRoom(roomId: String): ApiResult<Boolean>

    /**
     * Tap a seat. In a room with approval switched on the server answers 202 and files a request
     * instead of seating anyone, so the caller must handle both — see [SeatTakeResult].
     */
    suspend fun takeSeat(roomId: String, seatIndex: Int): ApiResult<SeatTakeResult>
    suspend fun leaveSeat(roomId: String, seatIndex: Int): ApiResult<List<Seat>>
    suspend fun lockSeat(roomId: String, seatIndex: Int, locked: Boolean): ApiResult<List<Seat>>
    suspend fun muteSeat(roomId: String, seatIndex: Int, muted: Boolean): ApiResult<List<Seat>>
    suspend fun kickFromSeat(roomId: String, seatIndex: Int): ApiResult<List<Seat>>

    /**
     * Host only: seat a member who is already in the audience without waiting for them to ask.
     * The server seats them as part of this call and tells them over the socket.
     */
    suspend fun inviteToSeat(roomId: String, seatIndex: Int, userId: String): ApiResult<List<Seat>>

    suspend fun raiseHand(roomId: String, raise: Boolean): ApiResult<Boolean>

    /**
     * The host's speaker queue, already in the order the requests arrived. Host-only: a member who
     * asks gets 403, so this is never called for anyone else's screen.
     */
    suspend fun speakerRequests(roomId: String): ApiResult<List<SpeakerRequest>>

    /** Seat the requester and hand them the microphone. The token itself comes on the socket. */
    suspend fun approveSpeakerRequest(roomId: String, requestId: String): ApiResult<List<Seat>>

    suspend fun rejectSpeakerRequest(roomId: String, requestId: String): ApiResult<Boolean>

    /** Drop the caller's own pending request; `cancelled` is the server's count, not our guess. */
    suspend fun cancelSpeakerRequest(roomId: String): ApiResult<Boolean>

    /** Pin one line above the seats for everyone in the room. An empty [text] clears it. */
    suspend fun setAnnouncement(roomId: String, text: String): ApiResult<Room>

    suspend fun closeRoom(roomId: String): ApiResult<Boolean>

    /**
     * Host-only restyle. A theme the shop sells is only accepted when the host owns a live copy, and
     * the server decides that from `user_items` — this call cannot claim ownership.
     */
    suspend fun setTheme(roomId: String, theme: String): ApiResult<Room>

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
    /** The catalogue rows plus the operator's shelves, both in the order the server sent them. */
    suspend fun getGifts(): ApiResult<GiftCatalogue>

    /**
     * [idempotencyKey] is one random value per Send tap, resent unchanged while that tap's outcome
     * is unknown. The server claims it before touching any balance, so a retry answers the gift it
     * already bought rather than buying another; omitting it asks for no replay protection at all.
     */
    suspend fun sendGift(
        roomId: String,
        receiverId: String,
        giftId: String,
        quantity: Int,
        idempotencyKey: String? = null,
    ): ApiResult<SendGiftOutcome>

    /**
     * GET /api/users/top. `window` is day | week | month; the board selects
     * whether the room ranks spenders or earners.
     */
    suspend fun getLeaderboard(window: String, board: RankBoard): ApiResult<Leaderboard>
}

/**
 * The cosmetic shop (GET /api/store). Every call is the member's own: the shop rows carry
 * "do you hold this" and "are you wearing this", which belong to the caller's account.
 *
 * None of these take a price. Buying sends a kind and a key; the server reads the price inside
 * the purchase transaction, so the number on the screen is a label and never an input.
 */
interface StoreRepository {
    suspend fun catalogue(): ApiResult<StoreSnapshot>

    /** A purchase, with the wallet the ledger debited. */
    suspend fun purchase(kind: StoreItemKind, key: String): ApiResult<StorePurchase>

    /** Wear an owned frame, entry flourish or entrance ride; the updated account comes back. */
    suspend fun equip(kind: StoreItemKind, key: String): ApiResult<User>

    /** Take off whatever of this kind is worn. */
    suspend fun unequip(kind: StoreItemKind): ApiResult<User>
}

/**
 * Daily activity (migration 0020). Both calls are the member's own.
 *
 * Nothing here takes a progress value, a reward or an experience total: a quest advances only when
 * a gift posts or a chat row is stored, and the check-in reward is a column the server reads inside
 * its transaction.
 */
interface QuestRepository {
    /** Today's quests, the day in the reset timezone, and the check-in state. */
    suspend fun today(): ApiResult<QuestsToday>

    /** Claim today's check-in; the response carries the refreshed status and the account. */
    suspend fun checkIn(): ApiResult<CheckInResult>
}

/**
 * PK battles (migration 0021). The score, the winner and the prize are the server's; this
 * interface cannot send any of them. [invite] only names the two rooms and a duration from the
 * operator's range, and [accept]/[decline]/[cancel] are refused by the server unless the caller
 * hosts the side they answer for.
 */
interface PkRepository {
    /** The duration range and the prize the invitation form must quote. */
    suspend fun settings(): ApiResult<PkSettings>

    /** The battle this room is invited to or fighting, or null when it is free. */
    suspend fun battleForRoom(roomId: String): ApiResult<PkBattle?>

    /** Finished, declined, cancelled and expired battles this room took part in, newest first. */
    suspend fun history(roomId: String, limit: Int = 10): ApiResult<List<PkBattle>>

    suspend fun invite(roomId: String, opponentRoomId: String, durationSeconds: Int?): ApiResult<PkBattle>

    suspend fun accept(battleId: String): ApiResult<PkBattle>

    suspend fun decline(battleId: String): ApiResult<PkBattle>

    suspend fun cancel(battleId: String): ApiResult<PkBattle>
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

/**
 * Operator-run promotional art (`GET /api/banners`, migration 0028).
 *
 * Reading it takes no session and counting it takes one, and that asymmetry is the whole contract: a
 * splash banner is drawn for a member who has not signed in yet, while the two figures an operator
 * judges a campaign by only mean anything if anonymous traffic cannot inflate them.
 */
interface BannerRepository {
    /** The live rows for one surface, or for all four when [placement] is null. */
    suspend fun live(placement: BannerPlacement? = null): ApiResult<List<PromoBanner>>

    /**
     * One impression or one tap. Signed out this is a no-op that reports success rather than an
     * error, because nothing on screen depends on the answer and a campaign nobody counted is still
     * the campaign the member saw.
     */
    suspend fun track(bannerId: String, event: BannerEvent): ApiResult<Boolean>
}

/** The two counters the server keeps beside a banner row. */
enum class BannerEvent { IMPRESSION, TAP }

/** GET /api/games?roomId=: the catalogue the host may open, and the room's live matches. */
data class GameLobbyBundle(
    val games: List<GameDefinition>,
    val sessions: List<GameSession>,
)

/**
 * Follows, blocks and reports between two members (`/api/users/:id/…`).
 *
 * Nothing here takes a count, a status or a verdict. The caller names the other member and, for a
 * report, one of six reasons; the server writes the edge or the queue row and answers with the new
 * state. In particular a report is a complaint to staff and not an action: filing one cannot ban,
 * mute or remove anybody, and only an operator's review can change that.
 */
interface SocialRepository {
    /** What the server says about this pair. Read before the card is drawn so the buttons match. */
    suspend fun relationship(targetUserId: String): ApiResult<Relationship>

    /** The edge, as the server answered it — true is following, false is not. */
    suspend fun follow(targetUserId: String): ApiResult<Boolean>

    suspend fun unfollow(targetUserId: String): ApiResult<Boolean>

    /**
     * [reason] is the blocker's own note, stored for their list and never sent to the member
     * blocked. Blank means no note.
     */
    suspend fun block(targetUserId: String, reason: String? = null): ApiResult<Boolean>

    suspend fun unblock(targetUserId: String): ApiResult<Boolean>

    /**
     * File a report. [roomId] is where it happened when the complaint is about a room, so the
     * operator's queue can open it; null is a complaint about the account alone.
     */
    suspend fun report(
        targetUserId: String,
        reason: ReportReason,
        details: String?,
        roomId: String? = null,
    ): ApiResult<Unit>
}
