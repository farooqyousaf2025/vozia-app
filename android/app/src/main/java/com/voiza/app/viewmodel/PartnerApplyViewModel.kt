package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.AgencyOption
import com.voiza.app.domain.model.ApplicationFieldInput
import com.voiza.app.domain.model.ApplicationForm
import com.voiza.app.domain.model.ApplicationStatus
import com.voiza.app.domain.model.RoleApplication
import com.voiza.app.domain.model.formatPartnerAnswer
import com.voiza.app.domain.repository.RoleApplicationRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * One partner application form, drawn from the server's spec.
 *
 * The screen sends every question it was given, in the widget the spec named, and validates none of
 * them. That is deliberate: `normaliseForm` is the only place an answer is given a shape, so a
 * required question, a two-letter country or an unchecked confirmation arrives back as the server's
 * own sentence about it rather than a message this build invented — and a field added to the form
 * tomorrow is asked here without a release.
 *
 * The role comes in as a string and the applicant never does: it is the bearer token on the request.
 */
class PartnerApplyViewModel(
    private val roleApplicationRepository: RoleApplicationRepository = ServiceLocator.roleApplicationRepository,
) : ViewModel() {

    data class PartnerApplyUiState(
        val form: ApplicationForm? = null,
        val agencies: List<AgencyOption> = emptyList(),
        /** The live row for this role, whatever state it is in: null when nothing has been filed. */
        val openApplication: RoleApplication? = null,
        val answers: Map<String, Any?> = emptyMap(),
        val loading: Boolean = false,
        val submitting: Boolean = false,
        /**
         * Set once the request resolves. The screen stops drawing the form and says what happened;
         * the member leaves when they are ready, because a submission that vanished in one frame is
         * a submission they cannot tell was filed.
         */
        val done: Boolean = false,
        /** Whether [done] came from answering an operator's question rather than filing an application. */
        val doneWasReply: Boolean = false,
        val error: String? = null,
    ) {
        /** Answering a request for more information, not filing a new application. */
        val isReply: Boolean get() = openApplication?.statusEnum == ApplicationStatus.INFO_REQUESTED

        /** Already with an operator and nothing is missing, so there is no submission to make. */
        val inReview: Boolean get() = openApplication?.statusEnum == ApplicationStatus.PENDING

        val roleLabel: String get() = openApplication?.roleLabel ?: form?.title?.removePrefix("Apply as ").orEmpty()
    }

    private val _state = MutableStateFlow(PartnerApplyUiState())
    val state: StateFlow<PartnerApplyUiState> = _state.asStateFlow()

    fun load(role: String) {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            when (val result = roleApplicationRepository.catalogue()) {
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, error = result.message)
                }
                is ApiResult.Success -> {
                    val entry = result.data.entries.firstOrNull { candidate ->
                        candidate.form.role.equals(role, ignoreCase = true)
                    }
                    if (entry == null) {
                        _state.update {
                            it.copy(
                                loading = false,
                                error = "This build does not know the role \"$role\". Open Become a Partner to see what is on offer.",
                            )
                        }
                        return@launch
                    }
                    // An open row starts from what was already filed. For a reply that is what makes
                    // answering one question possible without retyping the rest; for an application
                    // still in review it is the same copy, shown read-only, so the member can see
                    // what the operator is reading.
                    val prefill = if (entry.openApplication?.isOpen == true) {
                        entry.openApplication.answers.mapValues { (_, value) ->
                            if (value is Boolean) value else formatPartnerAnswer(value)
                        }
                    } else {
                        emptyMap()
                    }
                    _state.update {
                        it.copy(
                            form = entry.form,
                            agencies = result.data.agencies,
                            openApplication = entry.openApplication,
                            answers = prefill,
                            loading = false,
                        )
                    }
                }
            }
        }
    }

    /**
     * Record one answer.
     *
     * Text keeps whatever was typed, including something the server will refuse — the refusal is the
     * feedback, and rewriting the value here would hide what the member actually sent.
     */
    fun setAnswer(key: String, value: Any?) {
        _state.update { it.copy(answers = it.answers + (key to value), error = null) }
    }

    fun submit() {
        val form = _state.value.form ?: return
        if (_state.value.submitting || _state.value.inReview) return
        val application = _state.value.openApplication
        val payload = form.fields.associate { field ->
            field.key to when (field.input) {
                ApplicationFieldInput.CHECKBOX -> _state.value.answers[field.key] == true
                else -> _state.value.answers[field.key]?.toString().orEmpty()
            }
        }
        viewModelScope.launch {
            _state.update { it.copy(submitting = true, error = null) }
            val asReply = _state.value.isReply
            val result = if (asReply && application != null) {
                roleApplicationRepository.supplement(application.id, payload)
            } else {
                roleApplicationRepository.submit(form.role, payload)
            }
            when (result) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        submitting = false,
                        done = true,
                        doneWasReply = asReply,
                        openApplication = result.data,
                    )
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(submitting = false, error = result.message)
                }
            }
        }
    }

    /** The screen calls this when the member leaves the confirmation, so a revisit starts clean. */
    fun consumedDone() = _state.update { it.copy(done = false, doneWasReply = false) }
}
