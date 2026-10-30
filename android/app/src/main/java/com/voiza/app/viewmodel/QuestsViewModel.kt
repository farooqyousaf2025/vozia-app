package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.QuestsToday
import com.voiza.app.domain.model.User
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.QuestRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The daily quests screen.
 *
 * The status is the server's answer for this member, so after a check-in the whole status is
 * replaced with the copy the server returned (and the account is pushed into the session by the
 * repository) rather than patched here. A quest's progress is never advanced locally: it moves
 * when a gift posts in the ledger or a chat row is stored, and the only way to see that is to ask.
 */
class QuestsViewModel(
    private val questRepository: QuestRepository = ServiceLocator.questRepository,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
) : ViewModel() {

    data class QuestsUiState(
        val snapshot: QuestsToday? = null,
        val user: User? = null,
        val loading: Boolean = false,
        val claiming: Boolean = false,
        val error: String? = null,
        val message: String? = null,
    ) {
        /** A guest has no account to attribute a check-in to; the screen asks them to sign in. */
        val isGuest: Boolean get() = user == null && snapshot == null
    }

    private val _state = MutableStateFlow(QuestsUiState())
    val state: StateFlow<QuestsUiState> = _state.asStateFlow()

    init {
        load()
        viewModelScope.launch {
            authRepository.currentUser.collect { user ->
                _state.update { it.copy(user = user) }
            }
        }
    }

    fun load() {
        // Progress and the check-in belong to an account, so a guest has nothing to read; the
        // screen turns this into a sign-in prompt instead of a 401 from the server.
        if (authRepository.currentUser.value == null) {
            _state.update { it.copy(loading = false, error = null) }
            return
        }
        viewModelScope.launch {
            // The first load owns the spinner; a resume refresh must not blank the list.
            val firstLoad = _state.value.snapshot == null
            _state.update { it.copy(loading = firstLoad, error = null) }
            when (val result = questRepository.today()) {
                is ApiResult.Success -> _state.update {
                    it.copy(snapshot = result.data, loading = false, error = null)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, error = result.message)
                }
            }
        }
    }

    /**
     * Re-read today's status when the screen returns to the front. A gift sent in a room, a chat
     * typed elsewhere, or midnight passing in the reset timezone all change it, and none of those
     * is visible here until the server is asked.
     */
    fun refresh() {
        // The initial load already answers the first visit, and a guest has nothing to re-read.
        if (_state.value.snapshot == null) return
        viewModelScope.launch { authRepository.refreshMe() }
        load()
    }

    /** Claim today's check-in. The xp and the new streak come back from the server, not from here. */
    fun checkIn() {
        if (_state.value.claiming) return
        viewModelScope.launch {
            _state.update { it.copy(claiming = true, error = null) }
            when (val result = questRepository.checkIn()) {
                is ApiResult.Success -> {
                    val status = result.data.status
                    _state.update {
                        it.copy(
                            claiming = false,
                            snapshot = status ?: it.snapshot,
                            message = checkInMessage(result.data.xpAwarded, status?.checkIn?.streakDay),
                        )
                    }
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(claiming = false, error = result.message)
                }
            }
        }
    }

    fun consumeMessage() = _state.update { it.copy(message = null) }

    fun clearError() = _state.update { it.copy(error = null) }

    private fun checkInMessage(xp: Int, streakDay: Int?): String =
        if (streakDay == null) "Checked in — +$xp XP." else "Checked in — +$xp XP, day $streakDay in a row."
}
