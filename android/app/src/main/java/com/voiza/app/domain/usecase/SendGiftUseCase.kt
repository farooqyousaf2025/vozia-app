package com.voiza.app.domain.usecase

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.Transaction
import com.voiza.app.domain.repository.GiftRepository

/**
 * Gift purchase orchestration: price check against the caller-supplied
 * diamond balance (cheap UX guard; the backend is authoritative), then POST
 * /api/gifts/send. Success also returns the chosen [Gift] so the room layer
 * can optimistically enqueue the animation even if the socket echo is slow.
 */
class SendGiftUseCase(
    private val giftRepository: GiftRepository,
) {
    data class Receipt(val transaction: Transaction, val gift: Gift, val quantity: Int)

    suspend operator fun invoke(
        roomId: String,
        receiverId: String,
        gift: Gift,
        quantity: Int,
        senderDiamondBalance: Int?,
    ): ApiResult<Receipt> {
        val cost = gift.diamondPrice.toLong() * quantity
        if (quantity <= 0) {
            return ApiResult.Failure("Quantity must be at least 1")
        }
        if (senderDiamondBalance != null && cost > senderDiamondBalance) {
            return ApiResult.Failure("Not enough diamonds (need $cost, have $senderDiamondBalance)")
        }
        val result = giftRepository.sendGift(roomId, receiverId, gift.id, quantity)
        return when (result) {
            is ApiResult.Success ->
                ApiResult.Success(Receipt(result.data, gift, quantity))
            is ApiResult.Failure -> result
        }
    }
}
