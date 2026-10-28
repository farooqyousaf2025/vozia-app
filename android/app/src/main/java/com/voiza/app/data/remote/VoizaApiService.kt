package com.voiza.app.data.remote

import com.voiza.app.data.remote.dto.AuthResponse
import com.voiza.app.data.remote.dto.CreateGameBody
import com.voiza.app.data.remote.dto.CreateRoomBody
import com.voiza.app.data.remote.dto.EmojiCatalogueDto
import com.voiza.app.data.remote.dto.GameActionBody
import com.voiza.app.data.remote.dto.GameCatalogResponse
import com.voiza.app.data.remote.dto.GameDisputeEnvelope
import com.voiza.app.data.remote.dto.GameHistoryResponse
import com.voiza.app.data.remote.dto.GameReasonBody
import com.voiza.app.data.remote.dto.GameSessionEnvelope
import com.voiza.app.data.remote.dto.GiftsResponse
import com.voiza.app.data.remote.dto.HandRaiseBody
import com.voiza.app.data.remote.dto.HandRaiseResponse
import com.voiza.app.data.remote.dto.JoinRoomBody
import com.voiza.app.data.remote.dto.JoinRoomResponse
import com.voiza.app.data.remote.dto.LeaderboardResponse
import com.voiza.app.data.remote.dto.LiveKitTokenDto
import com.voiza.app.data.remote.dto.OtpRequestBody
import com.voiza.app.data.remote.dto.OtpResponse
import com.voiza.app.data.remote.dto.OkResponse
import com.voiza.app.data.remote.dto.RechargeBody
import com.voiza.app.data.remote.dto.RechargeResponse
import com.voiza.app.data.remote.dto.RoomDetailResponse
import com.voiza.app.data.remote.dto.RoomEnvelope
import com.voiza.app.data.remote.dto.RoomsResponse
import com.voiza.app.data.remote.dto.SeatMuteBody
import com.voiza.app.data.remote.dto.SeatPolicyResponse
import com.voiza.app.data.remote.dto.SeatStatusBody
import com.voiza.app.data.remote.dto.SeatsResponse
import com.voiza.app.data.remote.dto.SendGiftBody
import com.voiza.app.data.remote.dto.SendGiftResponse
import com.voiza.app.data.remote.dto.ThemeCatalogueDto
import com.voiza.app.data.remote.dto.UpdateProfileBody
import com.voiza.app.data.remote.dto.UpdateRoomBody
import com.voiza.app.data.remote.dto.UserEnvelope
import com.voiza.app.data.remote.dto.VerifyOtpBody
import com.voiza.app.data.remote.dto.WalletResponse
import com.voiza.app.data.remote.dto.WithdrawBody
import com.voiza.app.data.remote.dto.WithdrawResponse
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.HTTP
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * Retrofit surface covering the entire fixed Voiza API contract.
 * Base URL comes from BuildConfig.VOIZA_API_BASE_URL (see NetworkModule).
 */
interface VoizaApiService {

    // ---- Auth / app --------------------------------------------------------

    @POST("api/auth/request-otp")
    suspend fun requestOtp(@Body body: OtpRequestBody): OtpResponse

    @POST("api/auth/verify-otp")
    suspend fun verifyOtp(@Body body: VerifyOtpBody): AuthResponse

    @GET("api/auth/me")
    suspend fun me(): UserEnvelope

    @PATCH("api/auth/me")
    suspend fun updateProfile(@Body body: UpdateProfileBody): UserEnvelope

    // ---- Wallet ------------------------------------------------------------

    @GET("api/wallet")
    suspend fun wallet(): WalletResponse

    @POST("api/wallet/recharge")
    suspend fun recharge(@Body body: RechargeBody): RechargeResponse

    @POST("api/wallet/withdraw")
    suspend fun withdraw(@Body body: WithdrawBody): WithdrawResponse

    // ---- Rooms -------------------------------------------------------------

    @GET("api/rooms")
    suspend fun rooms(
        @Query("category") category: String?,
        @Query("limit") limit: Int?,
        @Query("search") search: String?,
        @Query("sort") sort: String?,
        @Query("language") language: String?,
        @Query("region") region: String?,
    ): RoomsResponse

    /** Quick Join: one open public room this member may walk into. */
    @GET("api/rooms/quick-join")
    suspend fun roomQuickJoin(): RoomEnvelope

    /** My Room: the rooms the caller hosts, open first. */
    @GET("api/rooms/mine")
    suspend fun myRooms(@Query("limit") limit: Int?): RoomsResponse

    @POST("api/rooms")
    suspend fun createRoom(@Body body: CreateRoomBody): RoomEnvelope

    @PATCH("api/rooms/{id}")
    suspend fun updateRoom(@Path("id") roomId: String, @Body body: UpdateRoomBody): RoomEnvelope

    @DELETE("api/rooms/{id}")
    suspend fun deleteRoom(@Path("id") roomId: String): OkResponse

    /** The administrator's seat bounds, so the create-room form never guesses a capacity. */
    @GET("api/rooms/capacity")
    suspend fun roomCapacity(): SeatPolicyResponse

    /**
     * Themes and effects an operator maintains in the database. Everything needed to restyle a room
     * arrives as a URL, so a theme added after this APK was built still renders.
     */
    @GET("api/rooms/themes")
    suspend fun themeCatalogue(): ThemeCatalogueDto

    /**
     * Chat emoji an operator maintains in the admin panel, and the pattern a message is scanned
     * with. Loaded once per session rather than per room: a picker is not part of a room resource.
     */
    @GET("api/emoji")
    suspend fun emojiCatalogue(): EmojiCatalogueDto

    @GET("api/rooms/{id}")
    suspend fun room(@Path("id") roomId: String): RoomDetailResponse

    @POST("api/rooms/{id}/join")
    suspend fun joinRoom(@Path("id") roomId: String, @Body body: JoinRoomBody): JoinRoomResponse

    @POST("api/rooms/{id}/leave")
    suspend fun leaveRoom(@Path("id") roomId: String): OkResponse

    @POST("api/rooms/{id}/seat")
    suspend fun takeSeat(@Path("id") roomId: String, @Body seatIndexBody: Map<String, Int>): SeatsResponse

    @POST("api/rooms/{id}/seat/{index}/leave")
    suspend fun leaveSeat(@Path("id") roomId: String, @Path("index") seatIndex: Int): SeatsResponse

    @POST("api/rooms/{id}/seat/{index}/lock")
    suspend fun lockSeat(
        @Path("id") roomId: String,
        @Path("index") seatIndex: Int,
        @Body body: SeatStatusBody,
    ): SeatsResponse

    @POST("api/rooms/{id}/seat/{index}/mute")
    suspend fun muteSeat(
        @Path("id") roomId: String,
        @Path("index") seatIndex: Int,
        @Body body: SeatMuteBody,
    ): SeatsResponse

    @HTTP(method = "POST", path = "api/rooms/{id}/seat/{index}/kick", hasBody = false)
    suspend fun kickFromSeat(@Path("id") roomId: String, @Path("index") seatIndex: Int): SeatsResponse

    @POST("api/rooms/{id}/hand-raise")
    suspend fun handRaise(@Path("id") roomId: String, @Body body: HandRaiseBody): HandRaiseResponse

    @POST("api/rooms/{id}/close")
    suspend fun closeRoom(@Path("id") roomId: String): OkResponse

    @POST("api/rooms/{id}/livekit-token")
    suspend fun livekitToken(@Path("id") roomId: String): LiveKitTokenDto

    // ---- Gifts -------------------------------------------------------------

    @GET("api/gifts")
    suspend fun gifts(): GiftsResponse

    @POST("api/gifts/send")
    suspend fun sendGift(@Body body: SendGiftBody): SendGiftResponse

    // ---- Rankings ----------------------------------------------------------

    /** `role`: receivers = hosts by coin earned, senders = gifters by diamonds spent. */
    @GET("api/users/top")
    suspend fun leaderboard(
        @Query("window") window: String,
        @Query("role") role: String,
        @Query("limit") limit: Int,
    ): LeaderboardResponse

    // ---- Games -------------------------------------------------------------

    /**
     * With a `roomId` this also carries the matches running in that room; without one
     * it is the catalogue alone. A session cannot exist outside a room, so the lobby
     * always asks with one.
     */
    @GET("api/games")
    suspend fun gameCatalog(@Query("roomId") roomId: String?): GameCatalogResponse

    @GET("api/games/me/history")
    suspend fun gameHistory(@Query("limit") limit: Int): GameHistoryResponse

    @GET("api/games/{id}")
    suspend fun gameSession(@Path("id") sessionId: String): GameSessionEnvelope

    @POST("api/games")
    suspend fun createGame(@Body body: CreateGameBody): GameSessionEnvelope

    @POST("api/games/{id}/join")
    suspend fun joinGame(@Path("id") sessionId: String): GameSessionEnvelope

    @POST("api/games/{id}/ready")
    suspend fun readyGame(@Path("id") sessionId: String): GameSessionEnvelope

    @POST("api/games/{id}/start")
    suspend fun startGame(@Path("id") sessionId: String): GameSessionEnvelope

    /** One move. The engine validates the payload; nothing here decides a result. */
    @POST("api/games/{id}/action")
    suspend fun gameAction(@Path("id") sessionId: String, @Body body: GameActionBody): GameSessionEnvelope

    @POST("api/games/{id}/leave")
    suspend fun leaveGame(@Path("id") sessionId: String): GameSessionEnvelope

    @POST("api/games/{id}/cancel")
    suspend fun cancelGame(@Path("id") sessionId: String, @Body body: GameReasonBody): GameSessionEnvelope

    /** Claim that a finished match was mis-settled; freezes payout for an operator. */
    @POST("api/games/{id}/dispute")
    suspend fun disputeGame(@Path("id") sessionId: String, @Body body: GameReasonBody): GameDisputeEnvelope
}
