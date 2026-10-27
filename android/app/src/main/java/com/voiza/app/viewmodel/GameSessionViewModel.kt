package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.socket.VoizaSocketClient
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.GameBoard
import com.voiza.app.domain.model.GameSession
import com.voiza.app.domain.model.GameStatus
import com.voiza.app.domain.model.LudoBoard
import com.voiza.app.domain.model.QuizBoard
import com.voiza.app.domain.model.TicTacToeBoard
import com.voiza.app.domain.model.User
import com.voiza.app.domain.model.remainingSeconds
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.GameRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * One match, from the lobby seat to the settlement card.
 *
 * The board is only ever what the server last said. A tap posts its coordinate and
 * waits: nothing is drawn as moved until `game:update` or the POST's own response
 * confirms it, so a rejected move cannot leave a phantom piece on the table for the
 * player who made it.
 */
class GameSessionViewModel(
    private val sessionId: String,
    private val gameRepository: GameRepository = ServiceLocator.gameRepository,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
    private val socket: VoizaSocketClient = ServiceLocator.socketClient,
) : ViewModel() {

    data class UiState(
        val session: GameSession? = null,
        val user: User? = null,
        val loading: Boolean = false,
        val busy: Boolean = false,
        val error: String? = null,
        /** Ticked once a second so the turn countdown moves without a socket event per second. */
        val nowMs: Long = System.currentTimeMillis(),
    ) {
        val myId: String? get() = user?.id
        val isMine: Boolean get() = session?.turnOwnerId == user?.id
        val secondsLeft: Int? get() = remainingSeconds(session?.turnDeadlineAtMs, nowMs)
        val isOver: Boolean get() = session?.isOver == true || session?.status == GameStatus.DISPUTED
        val seatOfMine: Int? get() = session?.participant(user?.id)?.position
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        load()
        viewModelScope.launch {
            authRepository.currentUser.collect { user -> _state.update { it.copy(user = user) } }
        }
        observeSocket()
        startClock()
    }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            when (val result = gameRepository.session(sessionId)) {
                is ApiResult.Success -> _state.update { it.copy(session = result.data, loading = false) }
                is ApiResult.Failure -> _state.update { it.copy(loading = false, error = result.message) }
            }
        }
    }

    fun clearError() {
        _state.update { it.copy(error = null) }
    }

    // ---- Moves -------------------------------------------------------------

    fun playCell(cell: Int) = act("MOVE", mapOf("cell" to cell))

    fun answer(optionIndex: Int) =
        act("ANSWER", mapOf("questionIndex" to (_state.value.session?.board as? QuizBoard)?.index, "optionIndex" to optionIndex))

    /** The engine rolls; the client only asks, and never sends a number it would like. */
    fun rollDice() = act("ROLL", emptyMap())

    fun movePiece(piece: Int) = act("MOVE", mapOf("piece" to piece))

    fun ready() = call { gameRepository.setReady(sessionId) }

    fun start() = call { gameRepository.start(sessionId) }

    fun leave() = call { gameRepository.leave(sessionId) }

    fun cancel() = call { gameRepository.cancel(sessionId, "Closed by the host from the match screen") }

    /**
     * Freezes the payout for an operator. The claim is recorded with the session's rules
     * version, so what gets reviewed is the version that was actually in force.
     */
    fun dispute(reason: String) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            when (val result = gameRepository.dispute(sessionId, reason)) {
                is ApiResult.Success -> load()
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.message) }
            }
        }
    }

    private fun act(type: String, payload: Map<String, Any?>) = call {
        gameRepository.action(sessionId, type, payload)
    }

    private fun call(block: suspend () -> ApiResult<GameSession>) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            when (val result = block()) {
                is ApiResult.Success -> _state.update { it.copy(session = result.data, busy = false) }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.message) }
            }
        }
    }

    // ---- Derived board views ----------------------------------------------

    fun ticTacToe(): TicTacToeBoard? = _state.value.session?.board as? TicTacToeBoard
    fun quiz(): QuizBoard? = _state.value.session?.board as? QuizBoard
    fun ludo(): LudoBoard? = _state.value.session?.board as? LudoBoard

    val isUnsupportedBoard: Boolean
        get() = _state.value.session?.board is GameBoard.Unsupported

    private fun observeSocket() {
        viewModelScope.launch {
            socket.gameUpdates.collect { session ->
                if (session.id != sessionId) return@collect
                _state.update { it.copy(session = session, loading = false) }
            }
        }
    }

    private fun startClock() {
        viewModelScope.launch {
            while (true) {
                kotlinx.coroutines.delay(1_000L)
                _state.update { it.copy(nowMs = System.currentTimeMillis()) }
            }
        }
    }
}
