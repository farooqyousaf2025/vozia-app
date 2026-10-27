package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.SessionManager
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.RechargeBody
import com.voiza.app.data.remote.dto.WithdrawBody
import com.voiza.app.domain.model.Transaction
import com.voiza.app.domain.model.WalletSnapshot
import com.voiza.app.domain.model.Withdrawal
import com.voiza.app.domain.repository.WalletRepository

class WalletRepositoryImpl(
    private val api: VoizaApiService,
    private val sessionManager: SessionManager,
) : WalletRepository {

    override suspend fun getWallet(): ApiResult<WalletSnapshot> =
        apiCall { api.wallet() }.mapSuccess { resp ->
            // Keep the cached session user fresh from the wallet envelope.
            sessionManager.updateUser(resp.user)
            resp.toDomain()
        }

    override suspend fun recharge(amountDiamonds: Int): ApiResult<Transaction> =
        apiCall { api.recharge(RechargeBody(amountDiamonds)) }.mapSuccess { resp ->
            sessionManager.updateUser(resp.user)
            resp.transaction.toDomain()
        }

    override suspend fun withdraw(
        amountRCoins: Int,
        payoutMethod: String,
        payoutDetails: Map<String, String>,
    ): ApiResult<Withdrawal> =
        apiCall { api.withdraw(WithdrawBody(amountRCoins, payoutMethod, payoutDetails)) }
            .mapSuccess { it.withdrawal.toDomain() }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}
