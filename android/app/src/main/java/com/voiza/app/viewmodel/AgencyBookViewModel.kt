package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.AgencyLiveRoom
import com.voiza.app.domain.model.AgencyHostRow
import com.voiza.app.domain.model.AgencyPosition
import com.voiza.app.domain.model.AgencySettlementRow
import com.voiza.app.domain.model.AgencySubRow
import com.voiza.app.domain.repository.AgencyBookRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The agency's own book, as its owner reads it.
 *
 * `GET /api/agency/position` is the gate: it names the agency, says whether it is a master or a sub,
 * and — because `requireAgencyOwner` resolves the roster from the token — is the call that refuses
 * anybody who does not run one. The other three are read against the position it returned, so a
 * member who cannot open this screen is not served four refusals.
 *
 * A sub-agency does not call `/sub-agencies` at all: the server refuses that route for a sub, and the
 * brief's "verify restricted access to Master Agency settings" is answered here by the position's own
 * `kind`, which the server derives from the parent link rather than from anything this app infers. The
 * refusal stays on the server for anyone who asks that route directly; a screen does not improve on it
 * by provoking it.
 *
 * The three sections fail independently and each keeps its own sentence. A roster the app cannot read
 * is not a reason to hide the money, and the position should still show while an operator's work on a
 * batch is in progress.
 */
class AgencyBookViewModel(
    private val agencyBookRepository: AgencyBookRepository = ServiceLocator.agencyBookRepository,
) : ViewModel() {

    data class AgencyBookUiState(
        val position: AgencyPosition? = null,
        val hosts: List<AgencyHostRow> = emptyList(),
        val activeRooms: List<AgencyLiveRoom> = emptyList(),
        val roomsError: String? = null,
        val subAgencies: List<AgencySubRow> = emptyList(),
        val settlements: List<AgencySettlementRow> = emptyList(),
        val loading: Boolean = false,
        /** The position itself was refused — there is no book to show, and this is the server's reason. */
        val error: String? = null,
        val rosterError: String? = null,
        val allocationError: String? = null,
        val batchesError: String? = null,
    ) {
        /** Nothing readable yet, so the screen has one job left: get the position. */
        val needsPosition: Boolean get() = position == null && error == null
    }

    private val _state = MutableStateFlow(AgencyBookUiState())
    val state: StateFlow<AgencyBookUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            val firstLoad = _state.value.position == null
            _state.update { it.copy(loading = firstLoad, error = null) }
            when (val result = agencyBookRepository.position()) {
                is ApiResult.Failure -> _state.update { it.copy(loading = false, error = result.message) }
                is ApiResult.Success -> {
                    _state.update { it.copy(position = result.data, loading = false) }
                    loadSections(result.data)
                }
            }
        }
    }

    private suspend fun loadSections(position: AgencyPosition) {
        val rooms = agencyBookRepository.activeRooms()
        val roster = agencyBookRepository.hosts()
        // Master-only, and skipped rather than called: the server's own answer for a sub is a refusal.
        val allocations = if (position.isMaster) agencyBookRepository.subAgencies() else null
        val batches = agencyBookRepository.settlements()
        _state.update {
            it.copy(
                activeRooms = (rooms as? ApiResult.Success)?.data ?: it.activeRooms,
                roomsError = (rooms as? ApiResult.Failure)?.message,
                hosts = (roster as? ApiResult.Success)?.data ?: it.hosts,
                rosterError = (roster as? ApiResult.Failure)?.message,
                subAgencies = (allocations as? ApiResult.Success)?.data ?: it.subAgencies,
                allocationError = (allocations as? ApiResult.Failure)?.message,
                settlements = (batches as? ApiResult.Success)?.data ?: it.settlements,
                batchesError = (batches as? ApiResult.Failure)?.message,
            )
        }
    }
}

/**
 * Whether the signed-in member runs an agency, which is the only thing the profile entry needs to know.
 *
 * `users.user_type` cannot answer this. The backend raises that marker when an operator approves an
 * AGENCY application and never lowers it, and an agency created another way leaves it at `USER` — so
 * the column both hides the desk from real owners and keeps showing it to withdrawn ones. The server's
 * own route decides: `GET /api/agency/position` resolves the agency from `agencies.owner_user_id` and
 * re-reads it on every request, which is the same lookup the desk itself is served by.
 *
 * A member is refused only by an answer that came back from the API. A call that never reached it —
 * `httpCode` null — leaves the last answer alone, so a weak signal does not take the desk away from
 * the owner who is looking for it.
 */
class AgencyAccessViewModel(
    private val agencyBookRepository: AgencyBookRepository = ServiceLocator.agencyBookRepository,
) : ViewModel() {

    /** Null until the server has answered. */
    private val _runsAgency = MutableStateFlow<Boolean?>(null)
    val runsAgency: StateFlow<Boolean?> = _runsAgency.asStateFlow()

    fun check() {
        viewModelScope.launch {
            when (val result = agencyBookRepository.position()) {
                is ApiResult.Success -> _runsAgency.value = true
                is ApiResult.Failure -> if (result.httpCode != null) _runsAgency.value = false
            }
        }
    }
}
