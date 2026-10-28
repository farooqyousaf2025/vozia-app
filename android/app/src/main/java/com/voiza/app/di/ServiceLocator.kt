package com.voiza.app.di

import android.content.Context
import com.voiza.app.data.livekit.LiveKitRoomManager
import com.voiza.app.data.notifications.VoizaNotifier
import com.voiza.app.data.remote.NetworkModule
import com.voiza.app.data.remote.SessionManager
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.repository.AuthRepositoryImpl
import com.voiza.app.data.repository.GameRepositoryImpl
import com.voiza.app.data.repository.GiftRepositoryImpl
import com.voiza.app.data.repository.RoomRepositoryImpl
import com.voiza.app.data.repository.StoreRepositoryImpl
import com.voiza.app.data.repository.WalletRepositoryImpl
import com.voiza.app.data.socket.VoizaSocketClient
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.GiftRepository
import com.voiza.app.domain.repository.GameRepository
import com.voiza.app.domain.repository.RoomRepository
import com.voiza.app.domain.repository.StoreRepository
import com.voiza.app.domain.repository.WalletRepository
import com.voiza.app.domain.usecase.JoinRoomUseCase
import com.voiza.app.domain.usecase.RechargeWalletUseCase
import com.voiza.app.domain.usecase.SendGiftUseCase
import com.voiza.app.domain.usecase.TakeSeatUseCase
import com.voiza.app.domain.usecase.ToggleMuteUseCase

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
    lateinit var gameRepository: GameRepository
        private set
    lateinit var storeRepository: StoreRepository
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

    fun init(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return

            val appContext = context.applicationContext

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
            gameRepository = GameRepositoryImpl(apiService)
            storeRepository = StoreRepositoryImpl(apiService, sessionManager)

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
