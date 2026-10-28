package com.voiza.app.data.socket

import com.google.gson.Gson
import com.voiza.app.data.remote.NetworkModule
import com.voiza.app.data.remote.SessionManager
import com.voiza.app.data.remote.dto.SocketChatDto
import com.voiza.app.data.remote.dto.SocketGameEndedDto
import com.voiza.app.data.remote.dto.GameSessionDto
import com.voiza.app.data.remote.dto.SocketGiftAnimatedDto
import com.voiza.app.data.remote.dto.SocketHandRaiseDto
import com.voiza.app.data.remote.dto.SocketKickedDto
import com.voiza.app.data.remote.dto.SocketLikeDto
import com.voiza.app.data.remote.dto.SocketListenerCountDto
import com.voiza.app.data.remote.dto.SocketMicToggleDto
import com.voiza.app.data.remote.dto.SocketRoomClosedDto
import com.voiza.app.data.remote.dto.SocketRoomProfileDto
import com.voiza.app.data.remote.dto.SocketSeatUpdateDto
import com.voiza.app.data.remote.dto.SocketThemeChangedDto
import com.voiza.app.data.remote.dto.SocketUserJoinedDto
import com.voiza.app.data.remote.dto.SocketUserLeftDto
import com.voiza.app.data.remote.dto.SocketWalletUpdateDto
import com.voiza.app.data.remote.dto.SocketWarningDto
import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.mapper.toDomainOrNull
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.domain.model.GameSession
import com.voiza.app.domain.model.HostWarningEvent
import com.voiza.app.domain.model.HandRaiseEvent
import com.voiza.app.domain.model.ListenerCountEvent
import com.voiza.app.domain.model.MicToggleEvent
import com.voiza.app.domain.model.RoomChatEvent
import com.voiza.app.domain.model.RoomClosedEvent
import com.voiza.app.domain.model.RoomLikeEvent
import com.voiza.app.domain.model.RoomProfileEvent
import com.voiza.app.domain.model.SeatUpdateEvent
import com.voiza.app.domain.model.ThemeChangedEvent
import com.voiza.app.domain.model.UserJoinedEvent
import com.voiza.app.domain.model.UserLeftEvent
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Owns exactly one Socket.IO connection, authenticated with the current JWT.
 *
 * Server events are exposed as cold-friendly MutableSharedFlows (extraBuffer
 * + DROP_OLDEST so bursts of chat never suspend the socket thread). Client
 * emits are fire-and-forget helpers per the contract:
 *   room:join / room:leave / room:chat / room:raise_hand / room:like
 *
 * Reconnect: a token change (login/logout/refresh) tears the socket down and
 * re-dials with the new auth payload automatically.
 */
class VoizaSocketClient(
    private val sessionManager: SessionManager,
    private val gson: Gson = NetworkModule.gson,
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var socket: Socket? = null

    @Volatile
    private var dialledToken: String? = null

    private val _isConnected = MutableStateFlow(false)
    val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

    // ---- Server event flows -------------------------------------------------

    private val _chatMessages = MutableSharedFlow<RoomChatEvent>(
        replay = 0, extraBufferCapacity = 128, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val chatMessages: SharedFlow<RoomChatEvent> = _chatMessages.asSharedFlow()

    private val _giftAnimated = MutableSharedFlow<GiftAnimatedEvent>(
        replay = 0, extraBufferCapacity = 32, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val giftAnimated: SharedFlow<GiftAnimatedEvent> = _giftAnimated.asSharedFlow()

    private val _seatUpdates = MutableSharedFlow<SeatUpdateEvent>(
        replay = 0, extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val seatUpdates: SharedFlow<SeatUpdateEvent> = _seatUpdates.asSharedFlow()

    /**
     * `room:liked` batches: the server already coalesced a burst of taps into one
     * counted event, so a small buffer is all the heart layer needs.
     */
    private val _likes = MutableSharedFlow<RoomLikeEvent>(
        replay = 0, extraBufferCapacity = 32, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val likes: SharedFlow<RoomLikeEvent> = _likes.asSharedFlow()

    private val _listenerCounts = MutableSharedFlow<ListenerCountEvent>(
        replay = 0, extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val listenerCounts: SharedFlow<ListenerCountEvent> = _listenerCounts.asSharedFlow()

    private val _userJoined = MutableSharedFlow<UserJoinedEvent>(
        replay = 0, extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val userJoined: SharedFlow<UserJoinedEvent> = _userJoined.asSharedFlow()

    private val _userLeft = MutableSharedFlow<UserLeftEvent>(
        replay = 0, extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val userLeft: SharedFlow<UserLeftEvent> = _userLeft.asSharedFlow()

    private val _micToggles = MutableSharedFlow<MicToggleEvent>(
        replay = 0, extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val micToggles: SharedFlow<MicToggleEvent> = _micToggles.asSharedFlow()

    private val _roomClosed = MutableSharedFlow<RoomClosedEvent>(
        replay = 0, extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val roomClosed: SharedFlow<RoomClosedEvent> = _roomClosed.asSharedFlow()

    private val _handRaises = MutableSharedFlow<HandRaiseEvent>(
        replay = 0, extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val handRaises: SharedFlow<HandRaiseEvent> = _handRaises.asSharedFlow()

    private val _themeChanges = MutableSharedFlow<ThemeChangedEvent>(
        replay = 0, extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val themeChanges: SharedFlow<ThemeChangedEvent> = _themeChanges.asSharedFlow()

    private val _profileUpdates = MutableSharedFlow<RoomProfileEvent>(
        replay = 0, extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val profileUpdates: SharedFlow<RoomProfileEvent> = _profileUpdates.asSharedFlow()

    /** Room id we were kicked from, delivered on the private `user:<id>` channel. */
    private val _kickedFrom = MutableSharedFlow<String>(
        replay = 0, extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val kickedFrom: SharedFlow<String> = _kickedFrom.asSharedFlow()

    /** Operator warnings, delivered privately on the `user:<id>` channel. */
    private val _hostWarnings = MutableSharedFlow<HostWarningEvent>(
        replay = 0, extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val hostWarnings: SharedFlow<HostWarningEvent> = _hostWarnings.asSharedFlow()

    /**
     * `game:update`: the whole session as the engine just wrote it, broadcast to the room.
     * A full board per change is deliberate — a diff would let a client that missed one
     * emit keep a board the server no longer has, and the board is what players trust.
     */
    private val _gameUpdates = MutableSharedFlow<GameSession>(
        replay = 0, extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val gameUpdates: SharedFlow<GameSession> = _gameUpdates.asSharedFlow()

    /** `game:ended`: the match left the table, so the room's game strip can drop it. */
    private val _gamesEnded = MutableSharedFlow<String>(
        replay = 0, extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val gamesEnded: SharedFlow<String> = _gamesEnded.asSharedFlow()

    init {
        // Re-dial whenever the auth token changes (login, re-login, logout).
        scope.launch {
            sessionManager.token.collectLatest { token ->
                if (token.isNullOrBlank()) disconnect() else connect(token)
            }
        }
    }

    // ---- Connection lifecycle ----------------------------------------------

    fun connect(token: String) {
        if (dialledToken == token && socket != null) return
        teardownSocket()

        val options = IO.Options().apply {
            path = "/socket.io"
            transports = arrayOf("websocket", "polling")
            reconnection = true
            reconnectionDelay = 2_000L
            auth = mapOf("token" to token)
        }

        val newSocket = try {
            IO.socket(NetworkModule.socketBaseUrl(), options)
        } catch (e: Exception) {
            android.util.Log.e(TAG, "Failed to create socket", e)
            return
        }

        newSocket.on(Socket.EVENT_CONNECT) {
            _isConnected.value = true
        }.on(Socket.EVENT_DISCONNECT) {
            _isConnected.value = false
        }.on(Socket.EVENT_CONNECT_ERROR) {
            _isConnected.value = false
        }

        bindHandler(newSocket, EVENT_CHAT) { args ->
            parse<SocketChatDto>(args)?.let { _chatMessages.tryEmit(it.toDomain()) }
        }
        bindHandler(newSocket, EVENT_GIFT) { args ->
            parse<SocketGiftAnimatedDto>(args)?.let { _giftAnimated.tryEmit(it.toDomain()) }
        }
        bindHandler(newSocket, EVENT_SEATS) { args ->
            parse<SocketSeatUpdateDto>(args)?.let { _seatUpdates.tryEmit(it.toDomain()) }
        }
        bindHandler(newSocket, EVENT_LIKED) { args ->
            parse<SocketLikeDto>(args)?.let { _likes.tryEmit(it.toDomain()) }
        }
        bindHandler(newSocket, EVENT_LISTENERS) { args ->
            parse<SocketListenerCountDto>(args)?.let {
                _listenerCounts.tryEmit(ListenerCountEvent(it.roomId, it.count))
            }
        }
        bindHandler(newSocket, EVENT_USER_JOINED) { args ->
            parse<SocketUserJoinedDto>(args)?.let { _userJoined.tryEmit(it.toDomain()) }
        }
        bindHandler(newSocket, EVENT_USER_LEFT) { args ->
            parse<SocketUserLeftDto>(args)?.let {
                _userLeft.tryEmit(UserLeftEvent(it.roomId, it.userId))
            }
        }
        bindHandler(newSocket, EVENT_MIC_TOGGLE) { args ->
            parse<SocketMicToggleDto>(args)?.let { _micToggles.tryEmit(it.toDomain()) }
        }
        bindHandler(newSocket, EVENT_ROOM_CLOSED) { args ->
            parse<SocketRoomClosedDto>(args)?.let { _roomClosed.tryEmit(RoomClosedEvent(it.roomId)) }
        }
        bindHandler(newSocket, EVENT_HAND_RAISE) { args ->
            parse<SocketHandRaiseDto>(args)?.toDomainOrNull()?.let { _handRaises.tryEmit(it) }
        }
        bindHandler(newSocket, EVENT_THEME_CHANGED) { args ->
            parse<SocketThemeChangedDto>(args)?.let {
                _themeChanges.tryEmit(ThemeChangedEvent(it.roomId, it.theme, it.wallpaper))
            }
        }
        bindHandler(newSocket, EVENT_PROFILE_UPDATED) { args ->
            parse<SocketRoomProfileDto>(args)?.let { _profileUpdates.tryEmit(it.toDomain()) }
        }
        bindHandler(newSocket, EVENT_KICKED) { args ->
            parse<SocketKickedDto>(args)?.let { _kickedFrom.tryEmit(it.roomId) }
        }
        bindHandler(newSocket, EVENT_WARNING) { args ->
            parse<SocketWarningDto>(args)?.let {
                _hostWarnings.tryEmit(HostWarningEvent(it.roomId, it.message))
            }
        }
        bindHandler(newSocket, EVENT_GAME_UPDATE) { args ->
            parse<GameSessionDto>(args)?.let { _gameUpdates.tryEmit(it.toDomain()) }
        }
        bindHandler(newSocket, EVENT_GAME_ENDED) { args ->
            parse<SocketGameEndedDto>(args)?.let { _gamesEnded.tryEmit(it.sessionId) }
        }
        bindHandler(newSocket, EVENT_WALLET) { args ->
            parse<SocketWalletUpdateDto>(args)?.let { update ->
                sessionManager.applyWalletUpdate(update.diamondBalance, update.rCoinBalance)
            }
        }

        dialledToken = token
        socket = newSocket
        newSocket.connect()
    }

    fun disconnect() {
        teardownSocket()
        _isConnected.value = false
        dialledToken = null
    }

    // ---- Client emits (contract) -------------------------------------------

    fun joinRoom(roomId: String) = emit(EVENT_EMIT_JOIN, JSONObject().put("roomId", roomId))

    fun leaveRoom(roomId: String) = emit(EVENT_EMIT_LEAVE, JSONObject().put("roomId", roomId))

    fun sendChat(roomId: String, message: String) =
        emit(EVENT_EMIT_CHAT, JSONObject().put("roomId", roomId).put("message", message))

    fun raiseHand(roomId: String, raise: Boolean) =
        emit(EVENT_EMIT_RAISE_HAND, JSONObject().put("roomId", roomId).put("raise", raise))

    /**
     * `room:like` reports how many taps accumulated since the last emit; the server
     * counts them, so a client that never fires cannot inflate the room's total.
     */
    fun sendLike(roomId: String, count: Int) =
        emit(EVENT_EMIT_LIKE, JSONObject().put("roomId", roomId).put("count", count))

    // ---- Internals -----------------------------------------------------------

    private fun emit(event: String, payload: JSONObject) {
        socket?.emit(event, payload)
    }

    private fun bindHandler(socket: Socket, event: String, block: (Array<*>) -> Unit) {
        socket.on(event) { args ->
            runCatching { block(args) }
                .onFailure { android.util.Log.w(TAG, "Handler for $event failed", it) }
        }
    }

    /** Socket.IO hands us org.json values; re-serialize through Gson to DTOs. */
    private inline fun <reified T> parse(args: Array<*>): T? {
        val first = args.firstOrNull() ?: return null
        return runCatching { gson.fromJson(first.toString(), T::class.java) }.getOrNull()
    }

    private fun teardownSocket() {
        socket?.let { old ->
            old.off()
            old.disconnect()
        }
        socket = null
    }

    private companion object {
        const val TAG = "VoizaSocket"

        // Server -> client
        const val EVENT_CHAT = "room:chat_message"
        const val EVENT_GIFT = "room:gift_animated"
        const val EVENT_LIKED = "room:liked"
        const val EVENT_SEATS = "room:seat_update"
        const val EVENT_LISTENERS = "room:listener_count"
        const val EVENT_USER_JOINED = "room:user_joined"
        const val EVENT_USER_LEFT = "room:user_left"
        const val EVENT_MIC_TOGGLE = "room:mic_toggle"
        const val EVENT_ROOM_CLOSED = "room:closed"
        const val EVENT_HAND_RAISE = "room:hand_raise"
        const val EVENT_THEME_CHANGED = "room:theme_changed"
        const val EVENT_PROFILE_UPDATED = "room:profile_updated"
        const val EVENT_KICKED = "room:kicked"
        const val EVENT_WARNING = "room:warning"
        const val EVENT_WALLET = "wallet:update"
        const val EVENT_GAME_UPDATE = "game:update"
        const val EVENT_GAME_ENDED = "game:ended"

        // Client -> server
        const val EVENT_EMIT_JOIN = "room:join"
        const val EVENT_EMIT_LEAVE = "room:leave"
        const val EVENT_EMIT_CHAT = "room:chat"
        const val EVENT_EMIT_RAISE_HAND = "room:raise_hand"
        const val EVENT_EMIT_LIKE = "room:like"
    }
}
