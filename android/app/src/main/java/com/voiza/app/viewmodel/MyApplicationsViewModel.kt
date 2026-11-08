package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.ApplicationFieldInput
import com.voiza.app.domain.model.ApplicationForm
import com.voiza.app.domain.model.RoleApplication
import com.voiza.app.domain.model.formatPartnerAnswer
import com.voiza.app.domain.repository.RoleApplicationRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * My Applications: what this account asked for, and what came of it.
 *
 * The rows are the server's history, including the ones that ended badly — a declined application and
 * a revoked role stay here with the operator's sentence attached, because the member is the only
 * person who cannot otherwise read why.
 *
 * The form specs are fetched alongside the rows to label them. An answer is stored under its field
 * key, so without the spec this screen would have to show `preferredAgencyId: 7f3c…`, which is the
 * applicant's uuid and not the agency they chose.
 */
class MyApplicationsViewModel(
    private val roleApplicationRepository: RoleApplicationRepository = ServiceLocator.roleApplicationRepository,
) : ViewModel() {

    data class MyApplicationsUiState(
        val applications: List<RoleApplication> = emptyList(),
        val activeRoles: List<String> = emptyList(),
        val formsByRole: Map<String, ApplicationForm> = emptyMap(),
        val agencyNames: Map<String, String> = emptyMap(),
        val loading: Boolean = false,
        /** The row a withdraw is running for, so only that row spins. */
        val busyId: String? = null,
        val error: String? = null,
        val message: String? = null,
    )

    private val _state = MutableStateFlow(MyApplicationsUiState())
    val state: StateFlow<MyApplicationsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            val firstLoad = _state.value.applications.isEmpty()
            _state.update { it.copy(loading = firstLoad, error = null) }
            when (val mine = roleApplicationRepository.mine()) {
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, error = mine.message)
                }
                is ApiResult.Success -> {
                    // The labels are a convenience, not a dependency: with the catalogue unread the
                    // screen still lists every row, keyed by its field name rather than its question.
                    val catalogue = (roleApplicationRepository.catalogue() as? ApiResult.Success)?.data
                    _state.update {
                        it.copy(
                            applications = mine.data.applications,
                            activeRoles = mine.data.activeRoles,
                            formsByRole = catalogue?.entries
                                ?.associate { entry -> entry.form.role.uppercase() to entry.form }
                                ?: it.formsByRole,
                            agencyNames = catalogue?.agencies?.associate { agency -> agency.id to agency.name }
                                ?: it.agencyNames,
                            loading = false,
                        )
                    }
                }
            }
        }
    }

    /**
     * The answers of one row, as `question / what was given`.
     *
     * Ordered by the form that asked them, with anything the current spec no longer mentions kept at
     * the end under its raw key: a form version 1 row still holds an answer a version 2 form dropped,
     * and dropping it from the history would hide what the member actually said.
     */
    fun answerLines(application: RoleApplication): List<Pair<String, String>> {
        val form = _state.value.formsByRole[application.role.uppercase()]
        val lines = form?.fields?.mapNotNull { field ->
            if (!application.answers.containsKey(field.key)) return@mapNotNull null
            val raw = application.answers[field.key]
            val shown = when {
                field.input == ApplicationFieldInput.AGENCY -> _state.value.agencyNames[raw?.toString()]
                    ?: "Agency ${raw?.toString()?.take(8) ?: ""} (no longer listed)"
                else -> formatPartnerAnswer(raw)
            }
            if (shown.isBlank()) null else field.label to shown
        }.orEmpty().toMutableList()
        val named = form?.fields?.map { it.key }.orEmpty().toSet()
        application.answers.keys.filter { it !in named }.forEach { key ->
            val shown = formatPartnerAnswer(application.answers[key])
            if (shown.isNotBlank()) lines += key to shown
        }
        return lines
    }

    /** Take an open application out of the queue. The row stays in the history as `CANCELLED`. */
    fun withdraw(applicationId: String) {
        if (_state.value.busyId != null) return
        viewModelScope.launch {
            _state.update { it.copy(busyId = applicationId, error = null) }
            when (val result = roleApplicationRepository.cancel(applicationId)) {
                is ApiResult.Success -> _state.update { state ->
                    state.copy(
                        busyId = null,
                        message = "Withdrawn. The application stays in your history.",
                        applications = state.applications.map { if (it.id == result.data.id) result.data else it },
                    )
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(busyId = null, error = result.message)
                }
            }
        }
    }

    fun consumeMessage() = _state.update { it.copy(message = null) }

    fun clearError() = _state.update { it.copy(error = null) }
}
