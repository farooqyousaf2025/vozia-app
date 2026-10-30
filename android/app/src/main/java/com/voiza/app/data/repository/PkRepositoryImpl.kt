package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.PkInviteBody
import com.voiza.app.domain.model.PkBattle
import com.voiza.app.domain.model.PkSettings
import com.voiza.app.domain.repository.PkRepository

/**
 * PK battles over HTTP.
 *
 * The only values this class sends are the two room ids and a duration the operator's dials
 * already bound. The score is not a request field anywhere: it is summed from the gift ledger by
 * the same server that paid for the gifts.
 */
class PkRepositoryImpl(
    private val api: VoizaApiService,
) : PkRepository {

    override suspend fun settings(): ApiResult<PkSettings> =
        apiCall { api.pkSettings() }
            .mapSuccess { requireNotNull(it.settings?.toDomain()) { "settings without dials" } }

    override suspend fun battleForRoom(roomId: String): ApiResult<PkBattle?> =
        apiCall { api.pkBattleForRoom(roomId) }.mapSuccess { it.battle?.toDomain() }

    override suspend fun history(roomId: String, limit: Int): ApiResult<List<PkBattle>> =
        apiCall { api.pkHistory(roomId, limit) }
            .mapSuccess { response -> response.battles.orEmpty().mapNotNull { it.toDomain() } }

    override suspend fun invite(roomId: String, opponentRoomId: String, durationSeconds: Int?): ApiResult<PkBattle> =
        apiCall { api.pkInvite(PkInviteBody(roomId, opponentRoomId, durationSeconds)) }
            .mapSuccess { requireNotNull(it.battle?.toDomain()) { "invitation without a battle" } }

    override suspend fun accept(battleId: String): ApiResult<PkBattle> =
        apiCall { api.pkAccept(battleId) }
            .mapSuccess { requireNotNull(it.battle?.toDomain()) { "accept without a battle" } }

    override suspend fun decline(battleId: String): ApiResult<PkBattle> =
        apiCall { api.pkDecline(battleId) }
            .mapSuccess { requireNotNull(it.battle?.toDomain()) { "decline without a battle" } }

    override suspend fun cancel(battleId: String): ApiResult<PkBattle> =
        apiCall { api.pkCancel(battleId) }
            .mapSuccess { requireNotNull(it.battle?.toDomain()) { "cancel without a battle" } }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}
