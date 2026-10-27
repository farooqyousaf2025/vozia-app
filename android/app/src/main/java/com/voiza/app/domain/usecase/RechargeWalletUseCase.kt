package com.voiza.app.domain.usecase

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.Transaction
import com.voiza.app.domain.repository.WalletRepository

/**
 * Diamond top-up (dev-mode simulated purchase; the backend treats
 * POST /api/wallet/recharge as the mock payment entry point).
 */
class RechargeWalletUseCase(
    private val walletRepository: WalletRepository,
) {
    suspend operator fun invoke(amountDiamonds: Int): ApiResult<Transaction> {
        if (amountDiamonds <= 0) {
            return ApiResult.Failure("Enter a positive amount")
        }
        return walletRepository.recharge(amountDiamonds)
    }
}
