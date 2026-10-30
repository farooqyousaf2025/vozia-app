package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.socket.VoizaSocketClient
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.PkBattle
import com.voiza.app.domain.model.PkSettings
import com.voiza.app.domain.model.PkSide
import com.voiza.app.domain.model.RoomStatus
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.domain.model.User
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.PkRepository
import com.voiza.app.domain.repository.RoomRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The PK desk for one room: challenge another host, answer an invitation, or watch the race.
 *
 * Nothing here computes a score. The board is whatever `GET /api/pk/rooms/:id` or `pk:state` last
 * said, and the only arithmetic is the countdown label — decoration on top of a clock the server's
 * sweeper actually enforces. The invitation offers only the durations the operator's settings
 * allow, so a form cannot submit a length the server would refuse.
 */
class PkViewModel(
    private val roomId: String,
    private val pkRepository: PkRepository = ServiceLocator.pkRepository,
    private val roomRepository: RoomRepository = ServiceLocator.roomRepository,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
    private val socket: VoizaSocketClient = ServiceLocator.socketClient,
) : ViewModel() {

    data class PkUiState(
        /** The room this desk belongs to; kept in state so the derived flags can name a side. */
        val roomId: String = "",
        val settings: PkSettings? = null,
        val battle: PkBattle? = null,
        val history: List<PkBattle> = emptyList(),
        /** Open rooms this room could challenge; the room itself is filtered out. */
        val rooms: List<RoomSummary> = emptyList(),
        /** Host of the room this desk belongs to, as the server reports it. */
        val roomHostId: String? = null,
        val roomTitle: String? = null,
        val user: User? = null,
        val selectedOpponentId: String? = null,
        val durationSeconds: Int? = null,
        val nowMs: Long = System.currentTimeMillis(),
        val loading: Boolean = true,
        val loaded: Boolean = false,
        val busy: Boolean = false,
        val error: String? = null,
        val message: String? = null,
    ) {
        val isEnabled: Boolean get() = settings?.isEnabled == true

        /** Only the room's host may challenge, accept, decline or cancel. */
        val isHost: Boolean get() = user?.id != null && user?.id == roomHostId

        val mySide: PkSide? get() = battle?.sideOf(roomId)

        val opponentRooms: List<RoomSummary>
            get() = rooms.filter { it.id != roomId }

        /** Room A sent the invitation; only room B may answer it. */
        val canAccept: Boolean
            get() = isHost && battle?.isInvited == true && mySide == PkSide.B

        val canDecline: Boolean get() = canAccept

        /** Room A may take its own invitation back while it is unanswered. */
        val canCancel: Boolean
            get() = isHost && battle?.isInvited == true && mySide == PkSide.A

        val canInvite: Boolean get() = isHost && battle == null && isEnabled

        val selectedOpponent: RoomSummary?
            get() = opponentRooms.firstOrNull { it.id == selectedOpponentId }

        val remainingMs: Long get() = battle?.remainingAt(nowMs) ?: 0

        val inviteRemainingMs: Long get() = battle?.inviteRemainingAt(nowMs) ?: 0
    }

    private val _state = MutableStateFlow(PkUiState(roomId = roomId))
    val state: StateFlow<PkUiState> = _state.asStateFlow()

    private var loadInFlight = false

    init {
        load()
        viewModelScope.launch {
            authRepository.currentUser.collect { user -> _state.update { it.copy(user = user) } }
        }
        observeSocket()
        startClock()
    }

    fun load() {
        if (loadInFlight) return
        loadInFlight = true
        viewModelScope.launch {
            try {
                loadAll()
            } finally {
                loadInFlight = false
            }
        }
    }

    private suspend fun loadAll() {
        val firstLoad = !_state.value.loaded
        _state.update { it.copy(loading = firstLoad, error = null) }

        when (val result = pkRepository.settings()) {
            is ApiResult.Success -> _state.update { state ->
                state.copy(
                    settings = result.data,
                    durationSeconds = state.durationSeconds ?: result.data.defaultDurationSeconds,
                )
            }
            is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
        }

        when (val result = pkRepository.battleForRoom(roomId)) {
            is ApiResult.Success -> _state.update { it.copy(battle = result.data) }
            is ApiResult.Failure -> _state.update { it.copy(error = it.error ?: result.message) }
        }

        // A footnote, like the game desk's history: the live card is the point.
        when (val result = pkRepository.history(roomId)) {
            is ApiResult.Success -> _state.update { it.copy(history = result.data) }
            is ApiResult.Failure -> Unit
        }

        when (val result = roomRepository.listRooms(category = null, limit = 30)) {
            is ApiResult.Success -> _state.update { state ->
                state.copy(
                    rooms = result.data.filter {
                        it.id != roomId && it.status == RoomStatus.ACTIVE
                    },
                )
            }
            is ApiResult.Failure -> Unit
        }

        // The desk needs to know whether the caller hosts this room, and the server's copy of
        // that fact is the room resource — not a flag this screen could set.
        when (val result = roomRepository.getRoom(roomId)) {
            is ApiResult.Success -> _state.update {
                it.copy(roomHostId = result.data.room.host.id, roomTitle = result.data.room.title)
            }
            is ApiResult.Failure -> Unit
        }

        _state.update { it.copy(loading = false, loaded = true) }
    }

    fun selectOpponent(roomId: String) = _state.update { it.copy(selectedOpponentId = roomId) }

    fun selectDuration(seconds: Int) = _state.update { it.copy(durationSeconds = seconds) }

    fun invite() {
        val target = _state.value.selectedOpponentId ?: return
        mutate({ pkRepository.invite(roomId, target, _state.value.durationSeconds) }) { battle ->
            _state.update { it.copy(battle = battle, message = "Invitation sent") }
        }
    }

    fun accept() {
        val battleId = _state.value.battle?.id ?: return
        mutate({ pkRepository.accept(battleId) }) { battle ->
            _state.update { it.copy(battle = battle, message = "The battle has started") }
        }
    }

    fun decline() {
        val battleId = _state.value.battle?.id ?: return
        mutate({ pkRepository.decline(battleId) }) { battle ->
            _state.update { it.copy(battle = battle, message = "Invitation declined") }
        }
    }

    fun cancel() {
        val battleId = _state.value.battle?.id ?: return
        mutate({ pkRepository.cancel(battleId) }) { battle ->
            _state.update { it.copy(battle = battle, message = "Invitation cancelled") }
        }
    }

    fun consumeMessage() = _state.update { it.copy(message = null) }

    fun clearError() = _state.update { it.copy(error = null) }

    /**
     * One invitation call. The battle the server returns replaces whatever was on screen, and a
     * rejection is shown in the server's own words — it knows why this move was not allowed.
     */
    private fun mutate(
        block: suspend () -> ApiResult<PkBattle>,
        apply: (PkBattle) -> Unit,
    ) {
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            when (val result = block()) {
                is ApiResult.Success -> {
                    apply(result.data)
                    _state.update { it.copy(busy = false) }
                    reloadHistory()
                }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.message) }
            }
        }
    }

    private fun reloadHistory() {
        viewModelScope.launch {
            when (val result = pkRepository.history(roomId)) {
                is ApiResult.Success -> _state.update { it.copy(history = result.data) }
                is ApiResult.Failure -> Unit
            }
        }
    }

    private fun observeSocket() {
        viewModelScope.launch {
            socket.pkStates.collect { battle ->
                if (battle.roomA.id != roomId && battle.roomB.id != roomId) return@collect
                // The private `pk:invited` channel carries the same battle to the challenged host;
                // either event replaces the card, because both are the server's full board.
                val previous = _state.value.battle
                _state.update { it.copy(battle = battle, nowMs = System.currentTimeMillis()) }
                // Every gift pushes a new board; the history only changes when the battle does.
                if (battle.status != previous?.status) reloadHistory()
            }
        }
        viewModelScope.launch {
            socket.pkInvites.collect { battle ->
                if (battle.roomA.id != roomId && battle.roomB.id != roomId) return@collect
                _state.update { it.copy(battle = battle, nowMs = System.currentTimeMillis()) }
            }
        }
    }

    /**
     * The countdown label. It only re-reads the device clock against the end the server sent; the
     * battle itself ends when the server's sweeper says so, never when this number hits zero.
     */
    private fun startClock() {
        viewModelScope.launch {
            while (isActive) {
                _state.update { state ->
                    if (state.battle?.isActive != true) state
                    else state.copy(nowMs = System.currentTimeMillis())
                }
                delay(1_000)
            }
        }
    }
}
