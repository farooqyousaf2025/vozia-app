package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.BuildConfig
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.User
import com.voiza.app.domain.repository.AuthRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Login (OTP) + profile state. Also owns edit-profile and logout for the
 * Profile screen, keeping a single source of truth for [User].
 */
class AuthViewModel(
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
) : ViewModel() {

    data class AuthUiState(
        val step: Step = Step.PHONE,
        val phone: String = "",
        val countryCode: String = "+1",
        val code: String = "",
        val username: String = "",
        val devCode: String? = null,
        val loading: Boolean = false,
        val error: String? = null,
        val loggedInUser: User? = null,
        val profileSaved: Boolean = false,
    ) {
        enum class Step { PHONE, CODE, LOGGED_IN }

        /**
         * The number the backend keys an account on. The `+` is added here rather than kept in the
         * field, because that field filters down to digits the moment the member edits it — and a
         * phone sent without its prefix is a second account to the server, not the same one dialled
         * differently.
         */
        fun e164(): String = "+${countryCode.filter { it.isDigit() }}${phone.filter { it.isDigit() }}"
    }

    private val _state = MutableStateFlow(AuthUiState())
    val state: StateFlow<AuthUiState> = _state.asStateFlow()

    init {
        // Hydrate from a persisted session if the app cold-starts logged in.
        viewModelScope.launch {
            authRepository.currentUser.collect { user ->
                _state.update {
                    it.copy(loggedInUser = user)
                }
            }
        }
    }

    // ---- Phone step ----------------------------------------------------------

    fun onCountryCodeChange(code: String) =
        _state.update { it.copy(countryCode = code.filter { c -> c.isDigit() }.take(4)) }

    fun onPhoneChange(phone: String) =
        _state.update { it.copy(phone = phone.filter { c -> c.isDigit() }.take(14)) }

    fun onUsernameChange(name: String) =
        _state.update { it.copy(username = name.take(40)) }

    fun onCodeChange(code: String) =
        _state.update {
            it.copy(code = code.filter { c -> c.isDigit() }.take(6))
        }

    fun clearError() = _state.update { it.copy(error = null) }

    fun requestOtp() {
        val phone = _state.value.e164()
        if (phone.length < 9) {
            _state.update { it.copy(error = "Enter a valid phone number") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            when (val result = authRepository.requestOtp(phone)) {
                is ApiResult.Success -> _state.update {
                    // A release build never auto-fills a code, even when it is pointed at a dev
                    // backend that hands one out: this convenience is the one thing in the flow
                    // that would skip the OTP step entirely.
                    val devCode = if (BuildConfig.DEBUG) result.data.devCode else null
                    it.copy(
                        loading = false,
                        step = AuthUiState.Step.CODE,
                        devCode = devCode,
                        code = devCode ?: it.code,
                    )
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, error = result.message)
                }
            }
        }
    }

    fun verifyOtp() {
        val snapshot = _state.value
        if (snapshot.code.length != 6) {
            _state.update { it.copy(error = "Enter the 6-digit code") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            val username = snapshot.username.trim().takeIf { it.isNotEmpty() }
            when (val result = authRepository.verifyOtp(
                phone = snapshot.e164(),
                code = snapshot.code,
                username = username,
            )) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        loading = false,
                        step = AuthUiState.Step.LOGGED_IN,
                        loggedInUser = result.data,
                    )
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, error = result.message)
                }
            }
        }
    }

    fun backToPhone() = _state.update {
        it.copy(step = AuthUiState.Step.PHONE, code = "", error = null, devCode = null)
    }

    // ---- Profile (edit / logout) ----------------------------------------------

    fun updateProfile(username: String?, avatarUrl: String?, bio: String?) {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            when (val result = authRepository.updateProfile(username, avatarUrl, bio)) {
                is ApiResult.Success -> _state.update {
                    it.copy(loading = false, loggedInUser = result.data, profileSaved = true)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, error = result.message)
                }
            }
        }
    }

    fun acknowledgeProfileSaved() = _state.update { it.copy(profileSaved = false) }

    fun refreshMe() {
        viewModelScope.launch { authRepository.refreshMe() }
    }

    fun logout() {
        authRepository.logout()
        _state.update { AuthUiState() }
    }
}
