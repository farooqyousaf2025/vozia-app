package com.voiza.app.di

import android.content.Context
import com.stripe.android.PaymentConfiguration
import com.voiza.app.BuildConfig
import com.voiza.app.data.livekit.LiveKitRoomManager
import com.voiza.app.data.notifications.VoizaNotifier
import com.voiza.app.data.notifications.FcmTokenRegistrar
import com.voiza.app.data.remote.NetworkModule
import com.voiza.app.data.remote.SessionManager
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.repository.AgencyBookRepositoryImpl
import com.voiza.app.data.repository.AuthRepositoryImpl
import com.voiza.app.data.repository.BannerRepositoryImpl
import com.voiza.app.data.repository.FriendsRepositoryImpl
import com.voiza.app.data.repository.GameRepositoryImpl
import com.voiza.app.data.repository.GiftRepositoryImpl
import com.voiza.app.data.repository.MarketplaceRepositoryImpl
import com.voiza.app.data.repository.PartnerDeskRepositoryImpl
import com.voiza.app.data.repository.PkRepositoryImpl
import com.voiza.app.data.repository.QuestRepositoryImpl
import com.voiza.app.data.repository.RankingsRepositoryImpl
import com.voiza.app.data.repository.RoleApplicationRepositoryImpl
import com.voiza.app.data.repository.RoomRepositoryImpl
import com.voiza.app.data.repository.SocialRepositoryImpl
import com.voiza.app.data.repository.StoreRepositoryImpl
import com.voiza.app.data.repository.WalletRepositoryImpl
import com.voiza.app.data.socket.VoizaSocketClient
import com.voiza.app.domain.repository.AgencyBookRepository
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.BannerRepository
import com.voiza.app.domain.repository.FriendsRepository
import com.voiza.app.domain.repository.GiftRepository
import com.voiza.app.domain.repository.GameRepository
import com.voiza.app.domain.repository.MarketplaceRepository
import com.voiza.app.domain.repository.PartnerDeskRepository
import com.voiza.app.domain.repository.PkRepository
import com.voiza.app.domain.repository.QuestRepository
import com.voiza.app.domain.repository.RankingsRepository
import com.voiza.app.domain.repository.RoleApplicationRepository
import com.voiza.app.domain.repository.RoomRepository
import com.voiza.app.domain.repository.SocialRepository
import com.voiza.app.domain.repository.StoreRepository
import com.voiza.app.domain.repository.WalletRepository
import com.voiza.app.domain.usecase.BannersStore
import com.voiza.app.domain.usecase.JoinRoomUseCase
import com.voiza.app.domain.usecase.RechargeWalletUseCase
import com.voiza.app.domain.usecase.SendGiftUseCase
import com.voiza.app.domain.usecase.TakeSeatUseCase
import com.voiza.app.domain.usecase.ToggleMuteUseCase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Hand-written dependency container (no Hilt/Koin by design — see README).
 * Everything is a lazily-created singleton scoped to the process; ViewModels
 * read from here via their factories.
 */
object ServiceLocator {

    @Volatile
    private var initialized = false

    lateinit var sessionManager: SessionManager
        private set
    lateinit var socketClient: VoizaSocketClient
        private set
    lateinit var liveKitRoomManager: LiveKitRoomManager
        private set

    lateinit var apiService: VoizaApiService
        private set

    lateinit var authRepository: AuthRepository
        private set
    lateinit var roomRepository: RoomRepository
        private set
    lateinit var walletRepository: WalletRepository
        private set
    lateinit var giftRepository: GiftRepository
        private set
    lateinit var bannerRepository: BannerRepository
        private set
    lateinit var gameRepository: GameRepository
        private set
    lateinit var storeRepository: StoreRepository
        private set
    lateinit var questRepository: QuestRepository
        private set
    lateinit var pkRepository: PkRepository
        private set

    /** Become a Partner: the four applications this account can file, and what they are waiting on. */
    lateinit var roleApplicationRepository: RoleApplicationRepository
        private set

    /** The book of the agency this member runs, if any: earnings, the split, roster and batches. */
    lateinit var agencyBookRepository: AgencyBookRepository
        private set

    /** The seller/BD desk of the partner account this member runs, if any: orders, cash book, territory. */
    lateinit var partnerDeskRepository: PartnerDeskRepository
        private set

    /** The member's view of the coin-seller market: approved sellers, own orders, own receipts. */
    lateinit var marketplaceRepository: MarketplaceRepository
        private set

    /** Follows, blocks and reports between members — the card opened from a roster row or a chat line. */
    lateinit var socialRepository: SocialRepository
        private set

    /** Friends, requests and one-to-one messages (migration 0049). */
    lateinit var friendsRepository: FriendsRepository
        private set

    /** The landing rankings: three boards over the ledger, and the podium reward a member collects. */
    lateinit var rankingsRepository: RankingsRepository
        private set

    /** The live campaigns, read once per session and drawn by four surfaces. */
    lateinit var bannersStore: BannersStore
        private set

    lateinit var joinRoomUseCase: JoinRoomUseCase
        private set
    lateinit var takeSeatUseCase: TakeSeatUseCase
        private set
    lateinit var sendGiftUseCase: SendGiftUseCase
        private set
    lateinit var toggleMuteUseCase: ToggleMuteUseCase
        private set
    lateinit var rechargeWalletUseCase: RechargeWalletUseCase
        private set
    lateinit var notifier: VoizaNotifier
        private set

    /**
     * Whether a real Stripe publishable key was supplied at build time. When false the wallet
     * keeps the simulated top-up path and never asks the server for a PaymentIntent.
     */
    var stripeConfigured: Boolean = false
        private set

    fun init(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return

            val appContext = context.applicationContext

            // PaymentSheet reads this global configuration when it is created. A blank key means
            // this stack has no Stripe account, so the wallet stays on the simulated top-up path.
            val publishableKey = BuildConfig.VOIZA_STRIPE_PUBLISHABLE_KEY.trim()
            stripeConfigured = publishableKey.startsWith("pk_")
            if (stripeConfigured) PaymentConfiguration.init(appContext, publishableKey)

            sessionManager = SessionManager(appContext)
            apiService = NetworkModule.buildRetrofit(
                NetworkModule.buildOkHttp(sessionManager)
            ).create(VoizaApiService::class.java)

            socketClient = VoizaSocketClient(sessionManager, NetworkModule.gson)
            liveKitRoomManager = LiveKitRoomManager(appContext)

            authRepository = AuthRepositoryImpl(apiService, sessionManager)
            roomRepository = RoomRepositoryImpl(apiService, socketClient)
            walletRepository = WalletRepositoryImpl(apiService, sessionManager)
            giftRepository = GiftRepositoryImpl(apiService)
            bannerRepository = BannerRepositoryImpl(apiService, sessionManager)
            bannersStore = BannersStore(bannerRepository)
            bannerRepository = BannerRepositoryImpl(apiService, sessionManager)
            gameRepository = GameRepositoryImpl(apiService)
            storeRepository = StoreRepositoryImpl(apiService, sessionManager)
            questRepository = QuestRepositoryImpl(apiService, sessionManager)
            pkRepository = PkRepositoryImpl(apiService)
            roleApplicationRepository = RoleApplicationRepositoryImpl(apiService)
            agencyBookRepository = AgencyBookRepositoryImpl(apiService)
            partnerDeskRepository = PartnerDeskRepositoryImpl(apiService)
            marketplaceRepository = MarketplaceRepositoryImpl(apiService)
            socialRepository = SocialRepositoryImpl(apiService)
            friendsRepository = FriendsRepositoryImpl(apiService)
            rankingsRepository = RankingsRepositoryImpl(apiService)

            joinRoomUseCase = JoinRoomUseCase(roomRepository) { roomId ->
                socketClient.joinRoom(roomId)
            }
            takeSeatUseCase = TakeSeatUseCase(roomRepository)
            sendGiftUseCase = SendGiftUseCase(giftRepository)
            toggleMuteUseCase = ToggleMuteUseCase(roomRepository)
            rechargeWalletUseCase = RechargeWalletUseCase(walletRepository)

            // Observes the process-wide socket, so a notification still lands
            // when no room ViewModel is on screen.
            notifier = VoizaNotifier(appContext, socketClient, sessionManager)

            initialized = true

            // Register a token obtained before sign-in as soon as a member session exists.
            CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
                sessionManager.token.collectLatest { token ->
                    if (!token.isNullOrBlank()) FcmTokenRegistrar.syncPending(appContext)
                }
            }
        }
    }

    /**
     * Session bootstrap used by the auth-gated start destination: if a token
     * is on disk, refresh the cached profile from /api/auth/me — the persisted
     * copy goes stale as soon as another client moves money — and drop the
     * session on 401 rather than looping the UI on a dead JWT.
     */
    suspend fun ensureSessionValid() {
        if (!sessionManager.hasSession) return
        val auth = authRepository as AuthRepositoryImpl
        val result = auth.refreshMe()
        if (result is com.voiza.app.data.remote.ApiResult.Failure && result.httpCode == 401) {
            auth.logout()
        }
    }
}
