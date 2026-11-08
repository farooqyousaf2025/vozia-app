package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.PartnerCatalogue
import com.voiza.app.domain.model.PartnerRoleEntry
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.RoleApplicationRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The Become a Partner hub.
 *
 * Everything on this screen is the server's answer: the four roles come from
 * `GET /api/role-applications/roles`, and whether one is held or already asked for is that row's
 * status — never a guess from `users.user_type`, which the room service has long written for anyone
 * who opened a room and so says nothing about a grant.
 */
class PartnerViewModel(
    private val roleApplicationRepository: RoleApplicationRepository = ServiceLocator.roleApplicationRepository,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
) : ViewModel() {

    data class PartnerUiState(
        val catalogue: PartnerCatalogue? = null,
        val loading: Boolean = false,
        val error: String? = null,
        val isGuest: Boolean = false,
    ) {
        val entries: List<PartnerRoleEntry> get() = catalogue?.entries.orEmpty()

        /** Roles with an `APPROVED` row, in the order the platform lists them. */
        val grantedRoles: List<PartnerRoleEntry> get() = entries.filter { it.granted }
    }

    private val _state = MutableStateFlow(PartnerUiState())
    val state: StateFlow<PartnerUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            // The first load owns the spinner; returning from a submitted form must not blank the hub.
            val firstLoad = _state.value.catalogue == null
            if (authRepository.currentUser.value == null) {
                _state.update { it.copy(loading = false, isGuest = true) }
                return@launch
            }
            _state.update { it.copy(loading = firstLoad, error = null, isGuest = false) }
            when (val result = roleApplicationRepository.catalogue()) {
                is ApiResult.Success -> _state.update {
                    it.copy(catalogue = result.data, loading = false, error = null)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, error = result.message)
                }
            }
        }
    }

    /** Re-read after a screen the member could have filed from comes back into view. */
    fun refresh() {
        if (_state.value.catalogue == null) return
        load()
    }
}
