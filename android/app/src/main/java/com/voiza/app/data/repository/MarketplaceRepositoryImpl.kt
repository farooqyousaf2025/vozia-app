package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomainOrNull
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.CreateMarketplaceOrderBody
import com.voiza.app.data.remote.dto.MarketplaceReceiptBody
import com.voiza.app.domain.model.MarketplaceOrder
import com.voiza.app.domain.model.MarketplaceReceipt
import com.voiza.app.domain.model.MarketplaceSeller
import com.voiza.app.domain.repository.MarketplaceRepository

/**
 * `/api/marketplace` over HTTP. The body names a seller and a package by key; the server prices the
 * order, binds it to the token's subject, and stops at AWAITING_PAYMENT. Receipts are evidence for a
 * finance decision, never a way to credit diamonds from the device.
 */
class MarketplaceRepositoryImpl(
    private val api: VoizaApiService,
) : MarketplaceRepository {

    override suspend fun sellers(): ApiResult<List<MarketplaceSeller>> =
        apiCall { api.marketplaceSellers() }.mapSuccess { envelope ->
            envelope.sellers.orEmpty().mapNotNull { it.toDomainOrNull() }
        }

    override suspend fun orders(): ApiResult<List<MarketplaceOrder>> =
        apiCall { api.marketplaceOrders() }.mapSuccess { envelope ->
            envelope.orders.orEmpty().mapNotNull { it.toDomainOrNull() }
        }

    override suspend fun createOrder(
        sellerId: String,
        packageKey: String,
        paymentMethod: String,
        note: String?,
    ): ApiResult<MarketplaceOrder> =
        apiCall {
            api.marketplaceCreateOrder(
                CreateMarketplaceOrderBody(
                    sellerId = sellerId,
                    packageKey = packageKey,
                    paymentMethod = paymentMethod,
                    note = note?.takeIf { it.isNotBlank() },
                ),
            )
        }.flatMapSuccess { envelope ->
            envelope.order?.toDomainOrNull()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The server answered with no order.")
        }

    override suspend fun uploadReceipt(
        orderId: String,
        fileName: String,
        data: String,
    ): ApiResult<MarketplaceReceipt> =
        apiCall { api.marketplaceUploadReceipt(orderId, MarketplaceReceiptBody(fileName, data)) }
            .flatMapSuccess { dto ->
                dto.toDomainOrNull()?.let { ApiResult.Success(it) }
                    ?: ApiResult.Failure("The server answered with no receipt.")
            }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }

    private inline fun <T, R> ApiResult<T>.flatMapSuccess(transform: (T) -> ApiResult<R>): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> transform(data)
            is ApiResult.Failure -> this
        }
}
