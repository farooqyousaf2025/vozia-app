package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.BlockBody
import com.voiza.app.data.remote.dto.ReportBody
import com.voiza.app.domain.model.Relationship
import com.voiza.app.domain.model.ReportReason
import com.voiza.app.domain.repository.SocialRepository

/**
 * Follows, blocks and reports over HTTP.
 *
 * The only things this class sends are an account id, a boolean verb chosen by which row was
 * tapped, one of six reason constants and a free-text note. It never sends a count, a status or a
 * verdict: the server writes the edge and answers with what the edge is now, and a report goes to
 * an operator's queue where a human decides what it means.
 */
class SocialRepositoryImpl(
    private val api: VoizaApiService,
) : SocialRepository {

    override suspend fun relationship(targetUserId: String): ApiResult<Relationship> =
        apiCall { api.relationship(targetUserId) }.mapSuccess { it.toDomain() }

    override suspend fun follow(targetUserId: String): ApiResult<Boolean> =
        apiCall { api.follow(targetUserId) }.mapSuccess { it.following == true }

    override suspend fun unfollow(targetUserId: String): ApiResult<Boolean> =
        apiCall { api.unfollow(targetUserId) }.mapSuccess { it.following == true }

    override suspend fun block(targetUserId: String, reason: String?): ApiResult<Boolean> =
        apiCall { api.block(targetUserId, BlockBody(reason?.trim()?.takeIf { it.isNotEmpty() })) }
            .mapSuccess { it.blocked == true }

    override suspend fun unblock(targetUserId: String): ApiResult<Boolean> =
        apiCall { api.unblock(targetUserId) }.mapSuccess { it.blocked == true }

    /**
     * The answer is the 201. The queue row the server returns belongs to the operator's panel, so
     * nothing here reads it back — a member filing a complaint has no business seeing how it is
     * filed, only that it was received.
     */
    override suspend fun report(
        targetUserId: String,
        reason: ReportReason,
        details: String?,
        roomId: String?,
    ): ApiResult<Unit> = apiCall {
        api.reportUser(
            targetUserId,
            ReportBody(
                reason = reason.wire,
                details = details?.trim()?.takeIf { it.isNotEmpty() },
                roomId = roomId,
            ),
        )
    }.mapSuccess { }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}
