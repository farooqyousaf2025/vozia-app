package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.RankingClaimBody
import com.voiza.app.domain.model.RankingBoard
import com.voiza.app.domain.model.RankingBoardKind
import com.voiza.app.domain.model.RankingClaimResult
import com.voiza.app.domain.model.RankingPeriod
import com.voiza.app.domain.repository.RankingsRepository

/**
 * The landing boards over HTTP. Reads are public; the claim is the caller's own. The bonus the
 * claim mints reaches the wallet through the same `wallet:update` push every other mint uses,
 * so nothing here patches a balance.
 */
class RankingsRepositoryImpl(private val api: VoizaApiService) : RankingsRepository {

    override suspend fun board(board: RankingBoardKind, period: RankingPeriod, settled: Boolean): ApiResult<RankingBoard> =
        apiCall { api.rankings(board.wire, period.wire, if (settled) "true" else null) }
            .mapSuccess { it.toDomain() }

    override suspend fun claim(board: RankingBoardKind, period: RankingPeriod): ApiResult<RankingClaimResult> =
        apiCall { api.claimRanking(RankingClaimBody(board.wire, period.wire)) }
            .mapSuccess { response ->
                response.toDomain() ?: throw IllegalStateException("The claim answer carried no receipt")
            }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}