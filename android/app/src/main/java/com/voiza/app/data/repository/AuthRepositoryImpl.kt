package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.SessionManager
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.OtpRequestBody
import com.voiza.app.data.remote.dto.UpdateProfileBody
import com.voiza.app.data.remote.dto.VerifyOtpBody
import com.voiza.app.domain.model.User
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.OtpChallenge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class AuthRepositoryImpl(
    private val api: VoizaApiService,
    private val sessionManager: SessionManager,
) : AuthRepository {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _currentUser = MutableStateFlow<User?>(sessionManager.user.value?.toDomain())
    override val currentUser: StateFlow<User?> = _currentUser.asStateFlow()

    init {
        // Mirror session-store writes (e.g. wallet/user refreshes from other
        // repositories) into the domain StateFlow.
        scope.launch {
            sessionManager.user.collectLatest { dto ->
                _currentUser.value = dto?.toDomain()
            }
        }
    }

    override suspend fun requestOtp(phone: String): ApiResult<OtpChallenge> {
        val result = apiCall { api.requestOtp(OtpRequestBody(phone)) }
        return when (result) {
            is ApiResult.Success ->
                ApiResult.Success(OtpChallenge(sent = result.data.sent, devCode = result.data.devCode))
            is ApiResult.Failure -> result
        }
    }

    override suspend fun verifyOtp(
        phone: String,
        code: String,
        username: String?,
    ): ApiResult<User> {
        val result = apiCall { api.verifyOtp(VerifyOtpBody(phone, code, username)) }
        return when (result) {
            is ApiResult.Success -> {
                sessionManager.storeSession(result.data.token, result.data.user)
                val user = result.data.user.toDomain()
                ApiResult.Success(user)
            }
            is ApiResult.Failure -> result
        }
    }

    override suspend fun refreshMe(): ApiResult<User> =
        apiCall { api.me() }.mapSuccess { it.user.also { dto -> sessionManager.updateUser(dto) }.toDomain() }

    override suspend fun updateProfile(
        username: String?,
        avatarUrl: String?,
        bio: String?,
    ): ApiResult<User> {
        val result = apiCall { api.updateProfile(UpdateProfileBody(username, avatarUrl, bio)) }
        return when (result) {
            is ApiResult.Success -> {
                sessionManager.updateUser(result.data.user)
                ApiResult.Success(result.data.user.toDomain())
            }
            is ApiResult.Failure -> result
        }
    }

    override fun logout() {
        sessionManager.clear()
    }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}
