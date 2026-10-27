package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.GameDefinition
import com.voiza.app.domain.model.GameHistoryRow
import com.voiza.app.domain.model.GameSession
import com.voiza.app.domain.model.GameStatus
import com.voiza.app.domain.model.User
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.GameRepository
import com.voiza.app.domain.repository.RoomRepository
import com.voiza.app.data.socket.VoizaSocketClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The room's game desk: what may be opened, what is already running, and what this
 * account has played.
 *
 * The fee line is the reason this screen exists apart from the board. Diamonds leave
 * the wallet on join, they are pinned to the session at that moment, and the pool is
 * what the server later splits — so the lobby shows the definition's price, never a
 * number it computed itself.
 */
class GameLobbyViewModel(
    private val roomId: String,
    private val gameRepository: GameRepository = ServiceLocator.gameRepository,
    private val roomRepository: RoomRepository = ServiceLocator.roomRepository,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
    private val socket: VoizaSocketClient = ServiceLocator.socketClient,
) : ViewModel() {

    data class GameLobbyUiState(
        val definitions: List<GameDefinition> = emptyList(),
        val sessions: List<GameSession> = emptyList(),
        val history: List<GameHistoryRow> = emptyList(),
        val user: User? = null,
        /**
         * The server only lets the room's host open a game, so the desk says so instead
         * of handing out a button that comes back with "not_room_host".
         */
        val roomHostId: String? = null,
        val loading: Boolean = false,
        val busy: Boolean = false,
        val error: String? = null,
    ) {
        val isHost: Boolean get() = user?.id != null && user?.id == roomHostId
        val openSessions: List<GameSession>
            get() = sessions.filter { it.status == GameStatus.WAITING || it.status == GameStatus.READY }
        val liveSessions: List<GameSession>
            get() = sessions.filter { it.status == GameStatus.IN_PROGRESS }
    }

    private val _state = MutableStateFlow(GameLobbyUiState())
    val state: StateFlow<GameLobbyUiState> = _state.asStateFlow()

    init {
        load()
        viewModelScope.launch {
            authRepository.currentUser.collect { user -> _state.update { it.copy(user = user) } }
        }
        observeSocket()
    }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            when (val result = gameRepository.lobby(roomId)) {
                is ApiResult.Success -> _state.update {
                    it.copy(definitions = result.data.games, sessions = result.data.sessions, loading = false)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, error = result.message)
                }
            }
        }
        loadHistory()
        resolveHost()
    }

    private fun resolveHost() {
        viewModelScope.launch {
            when (val result = roomRepository.getRoom(roomId)) {
                is ApiResult.Success -> _state.update { it.copy(roomHostId = result.data.room.host.id) }
                is ApiResult.Failure -> Unit
            }
        }
    }

    private fun loadHistory() {
        viewModelScope.launch {
            when (val result = gameRepository.history()) {
                is ApiResult.Success -> _state.update { it.copy(history = result.data) }
                is ApiResult.Failure -> Unit // the tabs below it are the point; history is a footnote
            }
        }
    }

    fun create(gameKey: String) = mutate({ gameRepository.create(gameKey, roomId) }) { session ->
        upsert(session)
    }

    /** Joining is the move that costs money, so the balance is re-read after it. */
    fun join(sessionId: String) {
        mutate({ gameRepository.join(sessionId) }) { session -> upsert(session) }
        viewModelScope.launch { authRepository.refreshMe() }
    }

    fun ready(sessionId: String) = mutate({ gameRepository.setReady(sessionId) }) { upsert(it) }

    fun start(sessionId: String) = mutate({ gameRepository.start(sessionId) }) { upsert(it) }

    fun leave(sessionId: String) = mutate({ gameRepository.leave(sessionId) }) { upsert(it) }

    fun cancel(sessionId: String) =
        mutate({ gameRepository.cancel(sessionId, "Closed from the room's game desk") }) { upsert(it) }

    /**
     * Runs one session call. `block` performs the request, `apply` adopts the session the
     * server returned, and a rejection is shown in the server's own words — the engine
     * already knows why this move was not allowed.
     */
    private fun mutate(
        block: suspend () -> ApiResult<GameSession>,
        apply: (GameSession) -> Unit,
    ) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            when (val result = block()) {
                is ApiResult.Success -> {
                    apply(result.data)
                    _state.update { it.copy(busy = false) }
                }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.message) }
            }
        }
    }

    private fun upsert(session: GameSession) {
        _state.update { st ->
            val others = st.sessions.filterNot { it.id == session.id }
            st.copy(sessions = (others + session).sortedByDescending { it.createdAt })
        }
    }

    private fun observeSocket() {
        viewModelScope.launch {
            socket.gameUpdates.collect { session ->
                if (session.roomId != roomId) return@collect
                upsert(session)
            }
        }
        viewModelScope.launch {
            socket.gamesEnded.collect { sessionId ->
                _state.update { it.copy(sessions = it.sessions.filterNot { s -> s.id == sessionId }) }
            }
        }
    }
}
