package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.SendGiftBody
import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.Leaderboard
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.Transaction
import com.voiza.app.domain.repository.GiftRepository

class GiftRepositoryImpl(
    private val api: VoizaApiService,
) : GiftRepository {

    override suspend fun getGifts(): ApiResult<List<Gift>> =
        apiCall { api.gifts() }.mapSuccess { resp -> resp.gifts.map { it.toDomain() } }

    override suspend fun sendGift(
        roomId: String,
        receiverId: String,
        giftId: String,
        quantity: Int,
    ): ApiResult<Transaction> =
        apiCall { api.sendGift(SendGiftBody(roomId, receiverId, giftId, quantity)) }
            .mapSuccess { it.transaction.toDomain() }

    override suspend fun getLeaderboard(window: String, board: RankBoard): ApiResult<Leaderboard> =
        apiCall { api.leaderboard(window, board.name.lowercase(), RANK_LIMIT) }
            .mapSuccess { it.toDomain() }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }

    private companion object {
        /** The backend caps a board at 100 rows; twenty is what a sheet shows. */
        const val RANK_LIMIT = 20
    }
}
