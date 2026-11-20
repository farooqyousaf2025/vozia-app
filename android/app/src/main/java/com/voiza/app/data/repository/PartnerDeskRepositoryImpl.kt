package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toCustomer
import com.voiza.app.data.mapper.toDashboard
import com.voiza.app.data.mapper.toOrder
import com.voiza.app.data.mapper.toOrderPage
import com.voiza.app.data.mapper.toPackages
import com.voiza.app.data.mapper.toPayoutPage
import com.voiza.app.data.mapper.toSellerReport
import com.voiza.app.data.mapper.toSellerRows
import com.voiza.app.data.mapper.toStatement
import com.voiza.app.data.mapper.toUploadedReceipt
import com.voiza.app.data.mapper.toWhoami
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.CancelOrderBody
import com.voiza.app.data.remote.dto.CreateRechargeOrderBody
import com.voiza.app.data.remote.dto.MarkOrderPaidBody
import com.voiza.app.data.remote.dto.RechargeOrderEnvelope
import com.voiza.app.data.remote.dto.UploadReceiptBody
import com.voiza.app.domain.model.PartnerCustomer
import com.voiza.app.domain.model.PartnerDashboard
import com.voiza.app.domain.model.PartnerSellerRow
import com.voiza.app.domain.model.PartnerStatement
import com.voiza.app.domain.model.PartnerWhoami
import com.voiza.app.domain.model.RechargeOrder
import com.voiza.app.domain.model.RechargeOrderPage
import com.voiza.app.domain.model.RechargePackage
import com.voiza.app.domain.model.SellerPayoutPage
import com.voiza.app.domain.model.SellerReport
import com.voiza.app.domain.model.UploadedReceipt
import com.voiza.app.domain.repository.PartnerDeskRepository

/**
 * The partner desk over HTTP (migration 0046).
 *
 * Every refusal is returned as the server's own sentence — including the 403 a member without an
 * active partner account gets from every route, the one a seller gets from a BD route, and the 404 a
 * BD gets for a seller outside its territory — so the screen reports what the backend said rather
 * than inventing a reason for it.
 *
 * The write methods carry no amount the app worked out: an order names a phone and a package key and
 * the server prices it; marking paid sends only the reference the customer gave; a receipt is bytes.
 */
class PartnerDeskRepositoryImpl(
    private val api: VoizaApiService,
) : PartnerDeskRepository {

    override suspend fun whoami(): ApiResult<PartnerWhoami> =
        apiCall { api.partnerWhoami() }.flatMapSuccess { envelope ->
            envelope.toWhoami()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The answer carried no partner account.")
        }

    override suspend fun dashboard(): ApiResult<PartnerDashboard> =
        apiCall { api.partnerDashboard() }.flatMapSuccess { envelope ->
            envelope.toDashboard()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The answer carried no partner account.")
        }

    override suspend fun packages(): ApiResult<List<RechargePackage>> =
        apiCall { api.partnerPackages() }.mapSuccess { it.toPackages() }

    override suspend fun createOrder(
        phone: String,
        packageKey: String,
        paymentMethod: String,
        note: String?,
    ): ApiResult<RechargeOrder> =
        apiCall { api.partnerCreateOrder(CreateRechargeOrderBody(phone, packageKey, paymentMethod, note)) }
            .flatMapSuccess { it.toOrderResult() }

    override suspend fun markPaid(orderId: String, paymentRef: String): ApiResult<RechargeOrder> =
        apiCall { api.partnerMarkOrderPaid(orderId, MarkOrderPaidBody(paymentRef)) }
            .flatMapSuccess { it.toOrderResult() }

    override suspend fun cancelOrder(orderId: String, reason: String): ApiResult<RechargeOrder> =
        apiCall { api.partnerCancelOrder(orderId, CancelOrderBody(reason)) }
            .flatMapSuccess { it.toOrderResult() }

    override suspend fun orders(page: Int, limit: Int): ApiResult<RechargeOrderPage> =
        apiCall { api.partnerOrders(page, limit) }.mapSuccess { it.toOrderPage() }

    override suspend fun order(orderId: String): ApiResult<RechargeOrder> =
        apiCall { api.partnerOrder(orderId) }.flatMapSuccess { it.toOrderResult() }

    override suspend fun lookupCustomer(phone: String): ApiResult<PartnerCustomer> =
        apiCall { api.partnerLookupCustomer(phone) }.flatMapSuccess { envelope ->
            envelope.toCustomer()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The answer carried no customer.")
        }

    override suspend fun statement(page: Int, limit: Int): ApiResult<PartnerStatement> =
        apiCall { api.partnerStatement(page, limit) }.mapSuccess { it.toStatement() }

    override suspend fun payouts(page: Int, limit: Int): ApiResult<SellerPayoutPage> =
        apiCall { api.partnerPayouts(page, limit) }.mapSuccess { it.toPayoutPage() }

    override suspend fun uploadReceipt(
        orderId: String?,
        withdrawalId: String?,
        fileName: String,
        data: String,
    ): ApiResult<UploadedReceipt> =
        apiCall { api.partnerUploadReceipt(UploadReceiptBody(orderId, withdrawalId, fileName, data)) }
            .flatMapSuccess { envelope ->
                envelope.toUploadedReceipt()?.let { ApiResult.Success(it) }
                    ?: ApiResult.Failure("The answer carried no receipt.")
            }

    override suspend fun sellers(): ApiResult<List<PartnerSellerRow>> =
        apiCall { api.partnerSellers() }.mapSuccess { it.toSellerRows() }

    override suspend fun sellerReport(sellerId: String): ApiResult<SellerReport> =
        apiCall { api.partnerSellerReport(sellerId) }.flatMapSuccess { envelope ->
            envelope.toSellerReport()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The answer carried no seller.")
        }

    private fun RechargeOrderEnvelope.toOrderResult(): ApiResult<RechargeOrder> =
        toOrder()?.let { ApiResult.Success(it) }
            ?: ApiResult.Failure("The answer carried no order.")

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