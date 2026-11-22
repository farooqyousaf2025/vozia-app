package com.voiza.app.data.remote

import com.voiza.app.data.remote.dto.AuthResponse
import com.voiza.app.data.remote.dto.AgencyAnnouncementBody
import com.voiza.app.data.remote.dto.AgencyAnnouncementsEnvelope
import com.voiza.app.data.remote.dto.AgencyAnnouncementEnvelope
import com.voiza.app.data.remote.dto.AgencyHostAnnouncementsEnvelope
import com.voiza.app.data.remote.dto.AgencyAnnouncementReadEnvelope
import com.voiza.app.data.remote.dto.AgencyLiveRoomsEnvelope
import com.voiza.app.data.remote.dto.AgencyRoomMembersEnvelope
import com.voiza.app.data.remote.dto.AgencyRoomModerationAuditEnvelope
import com.voiza.app.data.remote.dto.AgencyMuteMemberBody
import com.voiza.app.data.remote.dto.AgencyRoomModerationBody
import com.voiza.app.data.remote.dto.AgencyRoomModerationActionEnvelope
import com.voiza.app.data.remote.dto.AgencyHostsEnvelope
import com.voiza.app.data.remote.dto.AgencyHostActivityEnvelope
import com.voiza.app.data.remote.dto.AgencyHostAttendanceEnvelope
import com.voiza.app.data.remote.dto.AgencyHostGoalsEnvelope
import com.voiza.app.data.remote.dto.AgencyHostGoalsUpdateBody
import com.voiza.app.data.remote.dto.AgencyHostRecognitionEnvelope
import com.voiza.app.data.remote.dto.AgencyHostLeaderboardEnvelope
import com.voiza.app.data.remote.dto.AgencyPositionEnvelope
import com.voiza.app.data.remote.dto.AgencySettlementsEnvelope
import com.voiza.app.data.remote.dto.AgencySubsEnvelope
import com.voiza.app.data.remote.dto.AnnouncementBody
import com.voiza.app.data.remote.dto.ApplicationFormDto
import com.voiza.app.data.remote.dto.ApproveSpeakerRequestResponse
import com.voiza.app.data.remote.dto.BannerTrackBody
import com.voiza.app.data.remote.dto.BannersResponse
import com.voiza.app.data.remote.dto.BlockBody
import com.voiza.app.data.remote.dto.BlockResponse
import com.voiza.app.data.remote.dto.CancelOrderBody
import com.voiza.app.data.remote.dto.CheckInResponseDto
import com.voiza.app.data.remote.dto.CheckoutBody
import com.voiza.app.data.remote.dto.CheckoutResponse
import com.voiza.app.data.remote.dto.ConversationsEnvelope
import com.voiza.app.data.remote.dto.DiamondPackagesEnvelope
import com.voiza.app.data.remote.dto.FirstRechargeDto
import com.voiza.app.data.remote.dto.CreateGameBody
import com.voiza.app.data.remote.dto.CreateRechargeOrderBody
import com.voiza.app.data.remote.dto.CreateRoomBody
import com.voiza.app.data.remote.dto.CustomerLookupEnvelope
import com.voiza.app.data.remote.dto.DoNotContactBody
import com.voiza.app.data.remote.dto.DoNotContactEnvelope
import com.voiza.app.data.remote.dto.EmojiCatalogueDto
import com.voiza.app.data.remote.dto.EmptyRequestBody
import com.voiza.app.data.remote.dto.FollowResponse
import com.voiza.app.data.remote.dto.FriendDecisionEnvelope
import com.voiza.app.data.remote.dto.FriendRequestEnvelope
import com.voiza.app.data.remote.dto.FriendRequestsEnvelope
import com.voiza.app.data.remote.dto.FriendsEnvelope
import com.voiza.app.data.remote.dto.FriendLocationSharingBody
import com.voiza.app.data.remote.dto.FriendLocationBody
import com.voiza.app.data.remote.dto.FriendLocationSharingEnvelope
import com.voiza.app.data.remote.dto.FriendLocationUpdateEnvelope
import com.voiza.app.data.remote.dto.FriendDistancesEnvelope
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
import com.voiza.app.data.remote.dto.RankingBoardResponse
import com.voiza.app.data.remote.dto.DiscoveryRankingResponse
import com.voiza.app.data.remote.dto.RankingClaimBody
import com.voiza.app.data.remote.dto.RankingClaimResponse
import com.voiza.app.data.remote.dto.LiveKitTokenDto
import com.voiza.app.data.remote.dto.CreateMarketplaceOrderBody
import com.voiza.app.data.remote.dto.MarketplaceOrderEnvelope
import com.voiza.app.data.remote.dto.MarketplaceOrdersEnvelope
import com.voiza.app.data.remote.dto.MarketplaceReceiptBody
import com.voiza.app.data.remote.dto.MarketplaceReceiptDto
import com.voiza.app.data.remote.dto.MarketplaceSellersEnvelope
import com.voiza.app.data.remote.dto.MarkOrderPaidBody
import com.voiza.app.data.remote.dto.MarkReadEnvelope
import com.voiza.app.data.remote.dto.MessageEnvelope
import com.voiza.app.data.remote.dto.MessagesEnvelope
import com.voiza.app.data.remote.dto.MyApplicationsDto
import com.voiza.app.data.remote.dto.OtpRequestBody
import com.voiza.app.data.remote.dto.OtpResponse
import com.voiza.app.data.remote.dto.OkResponse
import com.voiza.app.data.remote.dto.PartnerDashboardEnvelope
import com.voiza.app.data.remote.dto.PartnerSellersEnvelope
import com.voiza.app.data.remote.dto.PartnerStatementEnvelope
import com.voiza.app.data.remote.dto.PartnerWhoamiEnvelope
import com.voiza.app.data.remote.dto.PkBattleEnvelope
import com.voiza.app.data.remote.dto.PkHistoryResponse
import com.voiza.app.data.remote.dto.PkInviteBody
import com.voiza.app.data.remote.dto.PkSettingsEnvelope
import com.voiza.app.data.remote.dto.QuestsTodayDto
import com.voiza.app.data.remote.dto.ReceiptUploadEnvelope
import com.voiza.app.data.remote.dto.RechargeBody
import com.voiza.app.data.remote.dto.RechargeOrderEnvelope
import com.voiza.app.data.remote.dto.RechargeOrdersEnvelope
import com.voiza.app.data.remote.dto.RechargePackagesEnvelope
import com.voiza.app.data.remote.dto.RechargeResponse
import com.voiza.app.data.remote.dto.RoleApplicationEnvelope
import com.voiza.app.data.remote.dto.RoleCatalogueDto
import com.voiza.app.data.remote.dto.RoomDetailResponse
import com.voiza.app.data.remote.dto.RoomEnvelope
import com.voiza.app.data.remote.dto.RoomsResponse
import com.voiza.app.data.remote.dto.RejectSpeakerRequestResponse
import com.voiza.app.data.remote.dto.RelationshipDto
import com.voiza.app.data.remote.dto.ReportBody
import com.voiza.app.data.remote.dto.ReportResponse
import com.voiza.app.data.remote.dto.SeatInviteBody
import com.voiza.app.data.remote.dto.SeatMuteBody
import com.voiza.app.data.remote.dto.SeatPolicyResponse
import com.voiza.app.data.remote.dto.SeatStatusBody
import com.voiza.app.data.remote.dto.SeatsResponse
import com.voiza.app.data.remote.dto.SellerPayoutsEnvelope
import com.voiza.app.data.remote.dto.SellerReportEnvelope
import com.voiza.app.data.remote.dto.SpeakerCancelResponse
import com.voiza.app.data.remote.dto.SpeakerRequestsResponse
import com.voiza.app.data.remote.dto.SetRoomThemeBody
import com.voiza.app.data.remote.dto.SendGiftBody
import com.voiza.app.data.remote.dto.SendGiftResponse
import com.voiza.app.data.remote.dto.SendMessageBody
import com.voiza.app.data.remote.dto.StoreItemBody
import com.voiza.app.data.remote.dto.SubmitApplicationBody
import com.voiza.app.data.remote.dto.SupplementApplicationBody
import com.voiza.app.data.remote.dto.StorePurchaseResponse
import com.voiza.app.data.remote.dto.StoreResponse
import com.voiza.app.data.remote.dto.TakeSeatResponse
import com.voiza.app.data.remote.dto.ThemeCatalogueDto
import com.voiza.app.data.remote.dto.UnfriendEnvelope
import com.voiza.app.data.remote.dto.UpdateProfileBody
import com.voiza.app.data.remote.dto.UpdateRoomBody
import com.voiza.app.data.remote.dto.UploadReceiptBody
import com.voiza.app.data.remote.dto.UserEnvelope
import com.voiza.app.data.remote.dto.VerifyOtpBody
import com.voiza.app.data.remote.dto.WalletResponse
import com.voiza.app.data.remote.dto.WithdrawBody
import com.voiza.app.data.remote.dto.WithdrawResponse
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.HTTP
import retrofit2.http.Header
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
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

    @PUT("api/auth/me/device-tokens")
    suspend fun setDeviceToken(@Body body: Map<String, String>): OkResponse

    @HTTP(method = "DELETE", path = "api/auth/me/device-tokens", hasBody = true)
    suspend fun clearDeviceToken(
        @Body body: Map<String, String>,
        @Header("Authorization") authorization: String,
    ): OkResponse

    /** Compatibility fallback for registrations made by a pre-multi-device app version. */
    @DELETE("api/auth/me/device-tokens")
    suspend fun clearAllDeviceTokens(@Header("Authorization") authorization: String): OkResponse

    @PATCH("api/auth/me")
    suspend fun updateProfile(@Body body: UpdateProfileBody): UserEnvelope

    // ---- Wallet ------------------------------------------------------------

    @GET("api/wallet")
    suspend fun wallet(): WalletResponse

    /** The active buyer packs in the operator's order; no price is computed on the device. */
    @GET("api/wallet/packages")
    suspend fun walletPackages(): DiamondPackagesEnvelope

    /** The first-recharge gate, derived by the server from completed RECHARGE rows. */
    @GET("api/wallet/first-recharge")
    suspend fun firstRecharge(): FirstRechargeDto

    /**
     * Paid top-up. The server refuses this route in demo mode; with a configured publishable key
     * the wallet uses it for server packs and presents the returned client secret in PaymentSheet.
     */
    @POST("api/wallet/recharge/checkout")
    suspend fun checkout(@Body body: CheckoutBody): CheckoutResponse

    @POST("api/wallet/recharge")
    suspend fun recharge(@Body body: RechargeBody): RechargeResponse

    @POST("api/wallet/withdraw")
    suspend fun withdraw(@Body body: WithdrawBody): WithdrawResponse

    // ---- Member coin-seller marketplace ------------------------------------
    // Buyer-scoped projections: the seller's contact details, owner and commission rules are not
    // part of these answers. The member's own id is never a body field; the server reads the token.

    /** Approved active sellers and the packages each may sell, with server-owned prices. */
    @GET("api/marketplace/sellers")
    suspend fun marketplaceSellers(): MarketplaceSellersEnvelope

    @GET("api/marketplace/orders")
    suspend fun marketplaceOrders(): MarketplaceOrdersEnvelope

    @POST("api/marketplace/orders")
    suspend fun marketplaceCreateOrder(@Body body: CreateMarketplaceOrderBody): MarketplaceOrderEnvelope

    /** `data` is a base64 (or data-URL) image/pdf; the returned document is proof, not credit. */
    @POST("api/marketplace/orders/{id}/receipt")
    suspend fun marketplaceUploadReceipt(
        @Path("id") orderId: String,
        @Body body: MarketplaceReceiptBody,
    ): MarketplaceReceiptDto

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

    /**
     * Host-only restyle. A theme the shop sells is refused unless the caller owns it — the check is
     * in `assertMayWearTheme`, so this call carries no proof of purchase for a client to forge.
     */
    @POST("api/rooms/{id}/theme")
    suspend fun setRoomTheme(@Path("id") roomId: String, @Body body: SetRoomThemeBody): RoomEnvelope

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
    suspend fun takeSeat(@Path("id") roomId: String, @Body seatIndexBody: Map<String, Int>): TakeSeatResponse

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

    @POST("api/rooms/{id}/seat/{index}/kick")
    suspend fun kickFromSeat(
        @Path("id") roomId: String,
        @Path("index") seatIndex: Int,
        @Body body: EmptyRequestBody,
    ): SeatsResponse

    /**
     * A host seats a member who is already in the audience. The server does the seating and grants
     * the microphone before answering, so the member learns about it on the private
     * `room:seat_invited` channel rather than from this response.
     */
    @POST("api/rooms/{id}/seat/{index}/invite")
    suspend fun inviteToSeat(
        @Path("id") roomId: String,
        @Path("index") seatIndex: Int,
        @Body body: SeatInviteBody,
    ): SeatsResponse

    // ---- Speaker approval queue ---------------------------------------------

    /** Host-only; a member who calls it gets 403, which is why the queue is read by the host. */
    @GET("api/rooms/{id}/speaker-requests")
    suspend fun speakerRequests(@Path("id") roomId: String): SpeakerRequestsResponse

    /** Clears the caller's own pending request — the way out of a queue nobody answers. */
    @POST("api/rooms/{id}/speaker-requests/cancel")
    suspend fun cancelSpeakerRequest(
        @Path("id") roomId: String,
        @Body body: EmptyRequestBody,
    ): SpeakerCancelResponse

    /** Approval also mints the publisher token; it travels on the private event, not this body. */
    @POST("api/rooms/{id}/speaker-requests/{requestId}/approve")
    suspend fun approveSpeakerRequest(
        @Path("id") roomId: String,
        @Path("requestId") requestId: String,
    ): ApproveSpeakerRequestResponse

    @POST("api/rooms/{id}/speaker-requests/{requestId}/reject")
    suspend fun rejectSpeakerRequest(
        @Path("id") roomId: String,
        @Path("requestId") requestId: String,
    ): RejectSpeakerRequestResponse

    /** One-line notice pinned above the seats. An empty [AnnouncementBody] clears it. */
    @POST("api/rooms/{id}/announcement")
    suspend fun setAnnouncement(
        @Path("id") roomId: String,
        @Body body: AnnouncementBody,
    ): RoomEnvelope

    @POST("api/rooms/{id}/hand-raise")
    suspend fun handRaise(@Path("id") roomId: String, @Body body: HandRaiseBody): HandRaiseResponse

    @POST("api/rooms/{id}/close")
    suspend fun closeRoom(@Path("id") roomId: String): OkResponse

    @POST("api/rooms/{id}/livekit-token")
    suspend fun livekitToken(@Path("id") roomId: String): LiveKitTokenDto

    // ---- Gifts -------------------------------------------------------------

    @GET("api/gifts")
    suspend fun gifts(): GiftsResponse

    // ---- Promotional banners ------------------------------------------------

    /**
     * What the operator is running on the wall right now. Public like `api/emoji`: a splash banner is
     * drawn before a signed-out member has anything to authenticate with, and the answer carries no
     * member data. A null `placement` asks for all four surfaces in one call, which is why a phone
     * that is about to show a splash, a home strip and a gift-panel card does not make three requests.
     */
    @GET("api/banners")
    suspend fun banners(@Query("placement") placement: String?): BannersResponse

    /**
     * One counted look at, or one tap on, one banner. Authenticated on purpose: these two counters are
     * the operator's only answer to "did that campaign work", so a call an anonymous script can make
     * would be a number nobody can believe.
     */
    @POST("api/banners/track")
    suspend fun trackBanner(@Body body: BannerTrackBody): OkResponse

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

    /**
     * The landing boards. Public; the auth interceptor attaches the session when one exists, so
     * the same call answers a guest with the list and a member with their own row and reward.
     * `settled` = "true" reads the finished window; omitted reads the live one.
     */
    @GET("api/rankings/discovery")
    suspend fun discoveryRankings(
        @Query("kind") kind: String,
        @Query("region") region: String?,
        @Query("limit") limit: Int = 10,
    ): DiscoveryRankingResponse

    @GET("api/rankings")
    suspend fun rankings(
        @Query("board") board: String,
        @Query("period") period: String,
        @Query("settled") settled: String? = null,
    ): RankingBoardResponse

    /** Collect a finished window's podium reward. Only the board and period are sent. */
    @POST("api/rankings/claim")
    suspend fun claimRanking(@Body body: RankingClaimBody): RankingClaimResponse

    // ---- Social moderation ---------------------------------------------------

    /**
     * How this member relates to one other account. Read before the card is drawn so the sheet
     * offers the follow button the server would honour rather than the one it would refuse.
     */
    @GET("api/users/{id}/relationship")
    suspend fun relationship(@Path("id") userId: String): RelationshipDto

    @POST("api/users/{id}/follow")
    suspend fun follow(@Path("id") userId: String): FollowResponse

    @DELETE("api/users/{id}/follow")
    suspend fun unfollow(@Path("id") userId: String): FollowResponse

    /**
     * A block closes the interaction both ways, so the server refuses gifts and follows between the
     * pair whichever side tapped first. It does not refuse a report.
     */
    @POST("api/users/{id}/block")
    suspend fun block(@Path("id") userId: String, @Body body: BlockBody): BlockResponse

    @DELETE("api/users/{id}/block")
    suspend fun unblock(@Path("id") userId: String): BlockResponse

    /**
     * File a complaint for an operator to review. Answers 201 with the queue row; a second open
     * report against the same member is refused, so this is not a button to press twice.
     */
    @POST("api/users/{id}/report")
    suspend fun reportUser(@Path("id") userId: String, @Body body: ReportBody): ReportResponse

    // ---- Friends and direct messages ----------------------------------------

    /**
     * Ask a member to be a friend. The body is deliberately empty: the requester comes from the
     * token, and the target is the path — a client cannot send somebody else's id in a field.
     */
    @POST("api/users/{id}/friend-request")
    suspend fun sendFriendRequest(@Path("id") userId: String): FriendRequestEnvelope

    @GET("api/friends")
    suspend fun friends(
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 50,
    ): FriendsEnvelope

    /** `incoming` or `outgoing`; the server also filters to pending requests only. */
    @GET("api/friends/location-sharing") suspend fun friendLocationSharingStatus(): FriendLocationSharingEnvelope
    @POST("api/friends/location-sharing") suspend fun setFriendLocationSharing(@Body body: FriendLocationSharingBody): FriendLocationSharingEnvelope
    @POST("api/friends/location") suspend fun updateFriendLocation(@Body body: FriendLocationBody): FriendLocationUpdateEnvelope
    @GET("api/friends/locations") suspend fun friendDistances(): FriendDistancesEnvelope

    @GET("api/friends/requests")
    suspend fun friendRequests(
        @Query("direction") direction: String = "incoming",
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 20,
    ): FriendRequestsEnvelope

    /** Only the addressee may accept, and only while the row is still pending. */
    @POST("api/friends/requests/{id}/accept")
    suspend fun acceptFriendRequest(@Path("id") requestId: String): FriendDecisionEnvelope

    @POST("api/friends/requests/{id}/decline")
    suspend fun declineFriendRequest(@Path("id") requestId: String): FriendDecisionEnvelope

    @DELETE("api/friends/{userId}")
    suspend fun unfriend(@Path("userId") userId: String): UnfriendEnvelope

    /**
     * Set the caller's own "do not contact" flag. Clearing it sends `value = false` on the same
     * route; the server ignores anything else in the body.
     */
    @POST("api/friends/{userId}/do-not-contact")
    suspend fun setDoNotContact(
        @Path("userId") userId: String,
        @Body body: DoNotContactBody,
    ): DoNotContactEnvelope

    /** Conversations are keyed by the pair on the server; the route names the other member. */
    @GET("api/dm/conversations")
    suspend fun conversations(): ConversationsEnvelope

    @GET("api/dm/conversations/{userId}/messages")
    suspend fun messages(
        @Path("userId") userId: String,
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 50,
    ): MessagesEnvelope

    /** The server trims and caps the text (2000 characters) and refuses non-friends with 403. */
    @POST("api/dm/conversations/{userId}/messages")
    suspend fun sendMessage(
        @Path("userId") userId: String,
        @Body body: SendMessageBody,
    ): MessageEnvelope

    @POST("api/dm/conversations/{userId}/read")
    suspend fun markRead(@Path("userId") userId: String): MarkReadEnvelope

    // ---- Store -------------------------------------------------------------

    /**
     * The cosmetic shop: what is on sale and what *this* caller owns or wears. Reading it needs a
     * member, because "owned" and "equipped" are answers about the caller.
     */
    @GET("api/store")
    suspend fun store(): StoreResponse

    /**
     * A purchase. The body carries a kind and a key and never a price: the server reads the price
     * inside the transaction, so a client that edits its copy of this screen cannot change what it
     * pays.
     */
    @POST("api/store/purchase")
    suspend fun purchaseItem(@Body body: StoreItemBody): StorePurchaseResponse

    /** Wear an owned frame or entry flourish. A theme is worn by a room, so it is refused here. */
    @POST("api/store/equip")
    suspend fun equipItem(@Body body: StoreItemBody): UserEnvelope

    /** Take it off; the key is not part of this call because only one item of a kind is worn. */
    @POST("api/store/unequip")
    suspend fun unequipItem(@Body body: StoreItemBody): UserEnvelope

    // ---- Daily quests ------------------------------------------------------

    /**
     * Today's quests, the day in the platform's reset timezone, and this member's check-in state.
     * Progress is read-only here: only a gift that posted in the ledger or a chat row the room
     * service stored can move it.
     */
    @GET("api/quests")
    suspend fun questsToday(): QuestsTodayDto

    /**
     * Claim today's check-in. The body is empty on purpose — the reward, the streak and whether
     * today is still open are all decided inside the server's transaction.
     */
    @POST("api/quests/checkin")
    suspend fun checkIn(): CheckInResponseDto

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

    // ---- PK battles --------------------------------------------------------

    /**
     * The operator's dials this member is allowed to see: whether battles are on, how long one may
     * last and what the winning room's top spender earns. The invitation form reads its duration
     * choices from here so it cannot offer a length the server would refuse.
     */
    @GET("api/pk/settings")
    suspend fun pkSettings(): PkSettingsEnvelope

    /**
     * The battle this room is in — invited or running — or null. A battle whose clock has run out
     * comes back settled, so a screen opened right after the buzzer never counts up.
     */
    @GET("api/pk/rooms/{roomId}")
    suspend fun pkBattleForRoom(@Path("roomId") roomId: String): PkBattleEnvelope

    /** Finished, declined, cancelled and expired battles, newest first. */
    @GET("api/pk/rooms/{roomId}/history")
    suspend fun pkHistory(
        @Path("roomId") roomId: String,
        @Query("limit") limit: Int,
    ): PkHistoryResponse

    /**
     * Challenge another host's room. The body is two room ids and an optional duration; a score,
     * a winner or an XP figure in this body would be ignored by the server.
     */
    @POST("api/pk/invites")
    suspend fun pkInvite(@Body body: PkInviteBody): PkBattleEnvelope

    @POST("api/pk/battles/{id}/accept")
    suspend fun pkAccept(@Path("id") battleId: String): PkBattleEnvelope

    @POST("api/pk/battles/{id}/decline")
    suspend fun pkDecline(@Path("id") battleId: String): PkBattleEnvelope

    @POST("api/pk/battles/{id}/cancel")
    suspend fun pkCancel(@Path("id") battleId: String): PkBattleEnvelope

    // ---- Become a Partner ---------------------------------------------------

    /**
     * The four role forms, and where this account stands against each.
     *
     * Nothing in this section names an account: the applicant is the bearer token, and no body
     * carries a role to be granted. Filing is a request; the grant is an operator's decision made on
     * `/api/admin/partner-applications`, which this app has no credential for.
     */
    @GET("api/role-applications/roles")
    suspend fun partnerCatalogue(): RoleCatalogueDto

    /** One spec alone, for a client that already knows which role it draws. */
    @GET("api/role-applications/form/{role}")
    suspend fun partnerForm(@Path("role") role: String): ApplicationFormDto

    @GET("api/role-applications/mine")
    suspend fun myRoleApplications(): MyApplicationsDto

    @POST("api/role-applications")
    suspend fun applyForRole(@Body body: SubmitApplicationBody): RoleApplicationEnvelope

    /** Answers for a request for more information — only the questions being replied to. */
    @POST("api/role-applications/{id}/supplement")
    suspend fun supplementApplication(
        @Path("id") applicationId: String,
        @Body body: SupplementApplicationBody,
    ): RoleApplicationEnvelope

    /** Withdraw an open application. The body is empty because the row is found by the caller's token. */
    @POST("api/role-applications/{id}/cancel")
    suspend fun cancelRoleApplication(
        @Path("id") applicationId: String,
        @Body body: EmptyRequestBody,
    ): RoleApplicationEnvelope

    // ---- The agency's own book ------------------------------------------------

    /**
     * What the roster of hosts this member runs has earned, and what the platform owes it.
     *
     * Four GETs, and the member's token is the only argument. `requireAgencyOwner` resolves the agency
     * from `agencies.owner_user_id`, so nothing here can be pointed at another member's book, and a
     * member who runs nothing is refused with the server's own sentence rather than an empty payload.
     * [agencySubAgencies] is master-only: a sub-agency has none, and `requireMasterAgency` says so.
     */
    @GET("api/agency/announcements")
    suspend fun agencyAnnouncements(): AgencyAnnouncementsEnvelope

    @POST("api/agency/announcements")
    suspend fun publishAgencyAnnouncement(@Body body: AgencyAnnouncementBody): AgencyAnnouncementEnvelope

    @GET("api/agency/announcements/inbox")
    suspend fun myAgencyAnnouncements(): AgencyHostAnnouncementsEnvelope

    @POST("api/agency/announcements/{id}/read")
    suspend fun markAgencyAnnouncementRead(@Path("id") id: String): AgencyAnnouncementReadEnvelope

    @GET("api/agency/position")
    suspend fun agencyPosition(): AgencyPositionEnvelope

    @GET("api/agency/rooms")
    suspend fun agencyActiveRooms(): AgencyLiveRoomsEnvelope

    @GET("api/agency/rooms/{id}/members")
    suspend fun agencyRoomMembers(@Path("id") roomId: String): AgencyRoomMembersEnvelope

    @GET("api/agency/rooms/{id}/moderation-audit")
    suspend fun agencyRoomModerationAudit(
        @Path("id") roomId: String,
        @Query("limit") limit: Int = 50,
    ): AgencyRoomModerationAuditEnvelope

    @POST("api/agency/rooms/{id}/mute")
    suspend fun agencyMuteMember(@Path("id") roomId: String, @Body body: AgencyMuteMemberBody): AgencyRoomModerationActionEnvelope

    @POST("api/agency/rooms/{id}/kick/{userId}")
    suspend fun agencyKickMember(@Path("id") roomId: String, @Path("userId") userId: String, @Body body: AgencyRoomModerationBody): AgencyRoomModerationActionEnvelope

    @POST("api/agency/rooms/{id}/ban/{userId}")
    suspend fun agencyBanMember(@Path("id") roomId: String, @Path("userId") userId: String, @Body body: AgencyRoomModerationBody): AgencyRoomModerationActionEnvelope

    @DELETE("api/agency/rooms/{id}/ban/{userId}")
    suspend fun agencyUnbanMember(@Path("id") roomId: String, @Path("userId") userId: String): AgencyRoomModerationActionEnvelope

    @GET("api/agency/activity")
    suspend fun agencyHostActivity(@Query("days") days: Int = 7): AgencyHostActivityEnvelope

    @GET("api/agency/attendance")
    suspend fun agencyHostAttendance(@Query("days") days: Int = 7): AgencyHostAttendanceEnvelope

    @GET("api/agency/goals")
    suspend fun agencyHostGoals(): AgencyHostGoalsEnvelope

    @GET("api/agency/recognition")
    suspend fun agencyHostRecognition(): AgencyHostRecognitionEnvelope

    @GET("api/agency/leaderboard")
    suspend fun agencyHostLeaderboard(@Query("days") days: Int = 7): AgencyHostLeaderboardEnvelope

    @PUT("api/agency/goals")
    suspend fun updateAgencyHostGoals(@Body body: AgencyHostGoalsUpdateBody): AgencyHostGoalsEnvelope

    @GET("api/agency/hosts")
    suspend fun agencyHosts(@Query("limit") limit: Int? = null): AgencyHostsEnvelope

    @GET("api/agency/sub-agencies")
    suspend fun agencySubAgencies(): AgencySubsEnvelope

    @GET("api/agency/settlements")
    suspend fun agencySettlements(@Query("limit") limit: Int? = null): AgencySettlementsEnvelope

    // ---- The partner desk (seller / BD) ---------------------------------------

    /**
     * The business panel's surfaces, served against the member's own session.
     *
     * `requireBusinessOwner` resolves the account from `business_accounts.owner_user_id` on every
     * request and re-checks its kind and status, so no call here carries an account id and a member
     * who runs no active partner account is refused by all of them. The writes are the same payloads
     * the business panel sends: an order names a phone and a package key — the server prices it — and
     * marking paid only claims the money arrived; crediting stays with finance.
     */
    @GET("api/partner/me")
    suspend fun partnerWhoami(): PartnerWhoamiEnvelope

    @GET("api/partner/dashboard")
    suspend fun partnerDashboard(): PartnerDashboardEnvelope

    @GET("api/partner/packages")
    suspend fun partnerPackages(): RechargePackagesEnvelope

    @POST("api/partner/orders")
    suspend fun partnerCreateOrder(@Body body: CreateRechargeOrderBody): RechargeOrderEnvelope

    @POST("api/partner/orders/{id}/mark-paid")
    suspend fun partnerMarkOrderPaid(
        @Path("id") orderId: String,
        @Body body: MarkOrderPaidBody,
    ): RechargeOrderEnvelope

    @POST("api/partner/orders/{id}/cancel")
    suspend fun partnerCancelOrder(
        @Path("id") orderId: String,
        @Body body: CancelOrderBody,
    ): RechargeOrderEnvelope

    @GET("api/partner/orders")
    suspend fun partnerOrders(
        @Query("page") page: Int? = null,
        @Query("limit") limit: Int? = null,
    ): RechargeOrdersEnvelope

    @GET("api/partner/orders/{id}")
    suspend fun partnerOrder(@Path("id") orderId: String): RechargeOrderEnvelope

    @GET("api/partner/customers/lookup")
    suspend fun partnerLookupCustomer(@Query("phone") phone: String): CustomerLookupEnvelope

    @GET("api/partner/statement")
    suspend fun partnerStatement(
        @Query("page") page: Int? = null,
        @Query("limit") limit: Int? = null,
    ): PartnerStatementEnvelope

    @GET("api/partner/payouts")
    suspend fun partnerPayouts(
        @Query("page") page: Int? = null,
        @Query("limit") limit: Int? = null,
    ): SellerPayoutsEnvelope

    @POST("api/partner/receipts")
    suspend fun partnerUploadReceipt(@Body body: UploadReceiptBody): ReceiptUploadEnvelope

    @GET("api/partner/sellers")
    suspend fun partnerSellers(): PartnerSellersEnvelope

    @GET("api/partner/sellers/{id}/report")
    suspend fun partnerSellerReport(@Path("id") sellerId: String): SellerReportEnvelope
}
