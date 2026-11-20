package com.voiza.app.data.repository

import com.voiza.app.domain.model.AgencyLiveRoom
import com.voiza.app.data.mapper.toHosts
import com.voiza.app.data.mapper.toPosition
import com.voiza.app.data.mapper.toSettlements
import com.voiza.app.data.mapper.toSubs
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.domain.model.AgencyHostRow
import com.voiza.app.domain.model.AgencyPosition
import com.voiza.app.domain.model.AgencySettlementRow
import com.voiza.app.domain.model.AgencySubRow
import com.voiza.app.domain.repository.AgencyBookRepository

/**
 * The agency's own book over HTTP (migrations 0033 and 0040).
 *
 * Four GETs and no session write-back: reading a roster changes nothing, and the figures here are
 * the journal's, not a balance the app has to refresh elsewhere. A refusal is returned as the
 * server's own sentence — including the 403 a member without an agency gets from every route and the
 * one a sub-agency gets from [subAgencies] — so the screen reports what the backend said rather than
 * inventing a reason for it.
 */
class AgencyBookRepositoryImpl(
    private val api: VoizaApiService,
) : AgencyBookRepository {

    override suspend fun activeRooms(): ApiResult<List<AgencyLiveRoom>> =
        apiCall { api.agencyActiveRooms() }.mapSuccess { envelope ->
            envelope.rooms.orEmpty().mapNotNull { row ->
                val id = row.id?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                AgencyLiveRoom(id, row.title.orEmpty(), row.roomNumber.orEmpty(), row.hostUsername.orEmpty(), (row.memberCount ?: 0).coerceAtLeast(0))
            }
        }

    override suspend fun position(): ApiResult<AgencyPosition> =
        apiCall { api.agencyPosition() }.flatMapSuccess { envelope ->
            envelope.toPosition()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The answer carried no agency.")
        }

    override suspend fun hosts(limit: Int): ApiResult<List<AgencyHostRow>> =
        apiCall { api.agencyHosts(limit) }.mapSuccess { it.toHosts() }

    override suspend fun subAgencies(): ApiResult<List<AgencySubRow>> =
        apiCall { api.agencySubAgencies() }.mapSuccess { it.toSubs() }

    override suspend fun settlements(limit: Int): ApiResult<List<AgencySettlementRow>> =
        apiCall { api.agencySettlements(limit) }.mapSuccess { it.toSettlements() }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }

    /** For an envelope whose payload the server may legitimately leave out. */
    private inline fun <T, R> ApiResult<T>.flatMapSuccess(transform: (T) -> ApiResult<R>): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> transform(data)
            is ApiResult.Failure -> this
        }
}
