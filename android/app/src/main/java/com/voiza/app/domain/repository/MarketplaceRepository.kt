package com.voiza.app.domain.repository

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.MarketplaceOrder
import com.voiza.app.domain.model.MarketplaceReceipt
import com.voiza.app.domain.model.MarketplaceSeller

/** Member-facing coin-seller market. Every answer is scoped to the signed-in member by the server. */
interface MarketplaceRepository {
    suspend fun sellers(): ApiResult<List<MarketplaceSeller>>
    suspend fun orders(): ApiResult<List<MarketplaceOrder>>
    suspend fun createOrder(
        sellerId: String,
        packageKey: String,
        paymentMethod: String,
        note: String?,
    ): ApiResult<MarketplaceOrder>

    suspend fun uploadReceipt(orderId: String, fileName: String, data: String): ApiResult<MarketplaceReceipt>
}
