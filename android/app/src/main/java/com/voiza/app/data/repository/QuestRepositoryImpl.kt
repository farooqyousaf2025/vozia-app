package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.SessionManager
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.domain.model.CheckInResult
import com.voiza.app.domain.model.QuestsToday
import com.voiza.app.domain.repository.QuestRepository

/**
 * Daily quests over HTTP. Both calls are the caller's own; checking in returns the account, which
 * is pushed into [SessionManager] so the header shows the new XP (and possibly a new rank) without
 * a second request.
 */
class QuestRepositoryImpl(
    private val api: VoizaApiService,
    private val sessionManager: SessionManager,
) : QuestRepository {

    override suspend fun today(): ApiResult<QuestsToday> =
        apiCall { api.questsToday() }.mapSuccess { it.toDomain() }

    override suspend fun checkIn(): ApiResult<CheckInResult> =
        apiCall { api.checkIn() }.mapSuccess { response ->
            response.user?.let(sessionManager::updateUser)
            response.toDomain()
        }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}
