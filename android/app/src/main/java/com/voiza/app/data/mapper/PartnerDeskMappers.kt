package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.CommissionEntryDto
import com.voiza.app.data.remote.dto.CommissionSettlementDto
import com.voiza.app.data.remote.dto.CommissionSummaryDto
import com.voiza.app.data.remote.dto.CustomerLookupEnvelope
import com.voiza.app.data.remote.dto.PartnerAccountDto
import com.voiza.app.data.remote.dto.PartnerDashboardEnvelope
import com.voiza.app.data.remote.dto.PartnerSellerRowDto
import com.voiza.app.data.remote.dto.PartnerSellersEnvelope
import com.voiza.app.data.remote.dto.PartnerStatementEnvelope
import com.voiza.app.data.remote.dto.PartnerWhoamiEnvelope
import com.voiza.app.data.remote.dto.ReceiptUploadEnvelope
import com.voiza.app.data.remote.dto.RechargeOrderDto
import com.voiza.app.data.remote.dto.RechargeOrderEnvelope
import com.voiza.app.data.remote.dto.RechargeOrdersEnvelope
import com.voiza.app.data.remote.dto.RechargePackageDto
import com.voiza.app.data.remote.dto.RechargePackagesEnvelope
import com.voiza.app.data.remote.dto.RechargeStatsDto
import com.voiza.app.data.remote.dto.SellerCashBookDto
import com.voiza.app.data.remote.dto.SellerCashOutDto
import com.voiza.app.data.remote.dto.SellerPayoutDto
import com.voiza.app.data.remote.dto.SellerPayoutsEnvelope
import com.voiza.app.data.remote.dto.SellerReportEnvelope
import com.voiza.app.domain.model.CommissionEntry
import com.voiza.app.domain.model.CommissionEntryStatus
import com.voiza.app.domain.model.CommissionSettlement
import com.voiza.app.domain.model.CommissionSettlementStatus
import com.voiza.app.domain.model.CommissionSummary
import com.voiza.app.domain.model.PartnerAccount
import com.voiza.app.domain.model.PartnerAccountStatus
import com.voiza.app.domain.model.PartnerCustomer
import com.voiza.app.domain.model.PartnerDashboard
import com.voiza.app.domain.model.PartnerKind
import com.voiza.app.domain.model.PartnerSellerRow
import com.voiza.app.domain.model.PartnerStatement
import com.voiza.app.domain.model.PartnerWhoami
import com.voiza.app.domain.model.RechargeOrder
import com.voiza.app.domain.model.RechargeOrderPage
import com.voiza.app.domain.model.RechargeOrderStatus
import com.voiza.app.domain.model.RechargePackage
import com.voiza.app.domain.model.RechargeStats
import com.voiza.app.domain.model.SellerCashBook
import com.voiza.app.domain.model.SellerCashOutRow
import com.voiza.app.domain.model.SellerPayout
import com.voiza.app.domain.model.SellerPayoutPage
import com.voiza.app.domain.model.SellerPayoutStatus
import com.voiza.app.domain.model.SellerReport
import com.voiza.app.domain.model.UploadedReceipt

// ---------------------------------------------------------------------------
// The partner desk's wire-to-domain copies.
//
// Every figure is copied, none is worked out: diamonds, prices and commission are the server's
// arithmetic on what it booked, and re-deriving any of them here from a rate would disagree with the
// journal the moment an operator changes that rate for the next order.
//
// A label falls back to the server's own word when this build has no name for the value, so a new
// order or batch state reads as that state instead of vanishing from the row that carries it.
// ---------------------------------------------------------------------------

private fun String?.orIfBlank(fallback: () -> String): String =
    if (this.isNullOrBlank()) fallback() else this

private fun accountStatus(value: String?): Pair<PartnerAccountStatus?, String> {
    val status = PartnerAccountStatus.fromWire(value)
    return status to (status?.label ?: value?.trim().orIfBlank { "Unknown" })
}

fun PartnerAccountDto.toDomain(): PartnerAccount {
    val (status, statusLabel) = accountStatus(status)
    val parsedKind = PartnerKind.fromWire(kind)
    return PartnerAccount(
        id = id.orEmpty(),
        kind = parsedKind,
        kindLabel = parsedKind?.label ?: kind.orIfBlank { "Partner" },
        code = code.orEmpty(),
        displayName = displayName.orEmpty(),
        status = status,
        statusLabel = statusLabel,
        marketCountry = marketCountry.orEmpty(),
        parentName = parentName,
        parentCode = parentCode,
        maxOrderDiamonds = maxOrderDiamonds ?: 0,
        dailyDiamondLimit = dailyDiamondLimit ?: 0,
        dailyOrderLimit = dailyOrderLimit ?: 0,
        suspendedReason = suspendedReason,
        createdAt = createdAt,
    )
}

fun RechargeStatsDto.toDomain(): RechargeStats = RechargeStats(
    orders = orders ?: 0,
    credited = credited ?: 0,
    awaitingVerification = awaitingVerification ?: 0,
    failed = failed ?: 0,
    reversed = reversed ?: 0,
    processedDiamonds = processedDiamonds ?: 0,
    collectedMinor = collectedCents ?: 0,
    netCollectedMinor = netCollectedCents ?: 0,
)

fun CommissionSummaryDto.toDomain(): CommissionSummary = CommissionSummary(
    accruedMinor = accruedCents ?: 0,
    settledMinor = settledCents ?: 0,
    reversedMinor = reversedCents ?: 0,
    entryCount = entryCount ?: 0,
    currency = currency.orEmpty(),
)

fun RechargePackageDto.toDomain(): RechargePackage = RechargePackage(
    key = key.orEmpty(),
    label = label.orEmpty(),
    diamonds = diamonds ?: 0,
    amountMinor = amountCents ?: 0,
    currency = currency.orEmpty(),
)

fun RechargeOrderDto.toDomain(): RechargeOrder {
    val parsed = RechargeOrderStatus.fromWire(status)
    return RechargeOrder(
        id = id.orEmpty(),
        reference = reference.orEmpty(),
        status = parsed,
        statusLabel = parsed?.label ?: status?.trim().orIfBlank { "Unknown" },
        sellerCode = sellerCode.orEmpty(),
        sellerName = sellerName.orEmpty(),
        bdCode = bdCode.orEmpty(),
        username = username.orEmpty(),
        diamonds = diamonds ?: 0,
        amountMinor = amountCents ?: 0,
        feeMinor = feeCents ?: 0,
        currency = currency.orEmpty(),
        paymentMethod = paymentMethod.orEmpty(),
        paymentRef = paymentRef,
        decisionNote = decisionNote,
        reversalReason = reversalReason,
        expiresAt = expiresAt,
        verifiedAt = verifiedAt,
        createdAt = createdAt,
    )
}

fun CommissionEntryDto.toDomain(): CommissionEntry {
    val parsed = CommissionEntryStatus.fromWire(status)
    return CommissionEntry(
        id = id.orEmpty(),
        orderReference = orderReference.orEmpty(),
        kind = kind.orEmpty(),
        status = parsed,
        statusLabel = parsed?.label ?: status?.trim().orIfBlank { "Unknown" },
        basisMinor = basisCents ?: 0,
        amountMinor = amountCents ?: 0,
        currency = currency.orEmpty(),
        reversalReason = reversalReason,
        settlementReference = settlementReference,
        settledAt = settledAt,
        createdAt = createdAt,
    )
}

fun CommissionSettlementDto.toDomain(): CommissionSettlement {
    val parsed = CommissionSettlementStatus.fromWire(status)
    return CommissionSettlement(
        reference = reference.orEmpty(),
        amountMinor = amountCents ?: 0,
        currency = currency.orEmpty(),
        entryCount = entryCount ?: 0,
        status = parsed,
        statusLabel = parsed?.label ?: status?.trim().orIfBlank { "Unknown" },
        periodFrom = periodFrom,
        periodTo = periodTo,
        paidAt = paidAt,
        note = note,
        createdAt = createdAt,
    )
}

fun SellerCashOutDto.toDomain(): SellerCashOutRow = SellerCashOutRow(
    reference = reference.orEmpty(),
    username = username.orEmpty(),
    netRCoins = netRCoins ?: 0,
    feeRCoins = feeRCoins ?: 0,
    paidAt = paidAt,
    receiptCount = receiptCount ?: 0,
)

fun SellerCashBookDto.toDomain(): SellerCashBook = SellerCashBook(
    currency = currency.orEmpty(),
    collectedNetMinor = collectedNetCents ?: 0,
    refundedMinor = refundedCents ?: 0,
    commissionSettledMinor = commissionSettledCents ?: 0,
    commissionAccruedMinor = commissionAccruedCents ?: 0,
    remittanceMinor = remittanceCents ?: 0,
    afterAccruedMinor = afterAccruedCents ?: 0,
    creditedOrders = creditedOrders ?: 0,
    cashOutNetRCoins = cashOutNetRCoins ?: 0,
    cashOutFeeRCoins = cashOutFeeRCoins ?: 0,
    cashOutCount = cashOutCount ?: 0,
    awaitingCashOutRCoins = awaitingCashOutRCoins ?: 0,
    cashOut = cashOut.orEmpty().filterNotNull().map { it.toDomain() },
)

fun SellerPayoutDto.toDomain(): SellerPayout {
    val parsed = SellerPayoutStatus.fromWire(status)
    return SellerPayout(
        id = id.orEmpty(),
        reference = reference.orEmpty(),
        username = username.orEmpty(),
        amountRCoins = amountRCoins ?: 0,
        feeRCoins = feeRCoins ?: 0,
        netRCoins = netRCoins ?: 0,
        status = parsed,
        statusLabel = parsed?.label ?: status?.trim().orIfBlank { "Unknown" },
        receiptCount = receiptCount ?: 0,
        createdAt = createdAt,
    )
}

fun PartnerSellerRowDto.toDomain(): PartnerSellerRow {
    val (status, statusLabel) = accountStatus(status)
    return PartnerSellerRow(
        id = id.orEmpty(),
        code = code.orEmpty(),
        displayName = displayName.orEmpty(),
        status = status,
        statusLabel = statusLabel,
        marketCountry = marketCountry.orEmpty(),
        recharge = recharge?.toDomain() ?: RechargeStats(0, 0, 0, 0, 0, 0, 0, 0),
    )
}

fun PartnerWhoamiEnvelope.toWhoami(): PartnerWhoami? = account?.let {
    PartnerWhoami(
        account = it.toDomain(),
        permissions = permissions.orEmpty().filterNotNull(),
        paymentRails = paymentRails.orEmpty().filterNotNull(),
    )
}

fun PartnerDashboardEnvelope.toDashboard(): PartnerDashboard? = account?.let {
    PartnerDashboard(
        account = it.toDomain(),
        recharge = recharge?.toDomain() ?: RechargeStats(0, 0, 0, 0, 0, 0, 0, 0),
        commission = commission?.toDomain() ?: CommissionSummary(0, 0, 0, 0, ""),
        sellers = sellers.orEmpty().filterNotNull().map { dto -> dto.toDomain() },
    )
}

fun RechargePackagesEnvelope.toPackages(): List<RechargePackage> =
    packages.orEmpty().filterNotNull().filter { it.isActive != false }.map { it.toDomain() }

fun RechargeOrdersEnvelope.toOrderPage(): RechargeOrderPage = RechargeOrderPage(
    orders = orders.orEmpty().filterNotNull().map { it.toDomain() },
    total = total ?: 0,
)

fun RechargeOrderEnvelope.toOrder(): RechargeOrder? = order?.toDomain()

fun CustomerLookupEnvelope.toCustomer(): PartnerCustomer? = customer?.let {
    PartnerCustomer(
        username = it.username.orEmpty(),
        status = it.status.orEmpty(),
        createdAt = it.created,
        recentOrders = it.orders.orEmpty().filterNotNull().map { dto -> dto.toDomain() },
    )
}

fun PartnerStatementEnvelope.toStatement(): PartnerStatement = PartnerStatement(
    summary = summary?.toDomain() ?: CommissionSummary(0, 0, 0, 0, ""),
    entries = entries.orEmpty().filterNotNull().map { it.toDomain() },
    totalEntries = total ?: 0,
    settlements = settlements.orEmpty().filterNotNull().map { it.toDomain() },
    cash = cash?.toDomain(),
)

fun SellerPayoutsEnvelope.toPayoutPage(): SellerPayoutPage = SellerPayoutPage(
    payouts = payouts.orEmpty().filterNotNull().map { it.toDomain() },
    total = total ?: 0,
)

fun ReceiptUploadEnvelope.toUploadedReceipt(): UploadedReceipt? = receipt?.let {
    UploadedReceipt(
        fileName = it.fileName.orEmpty(),
        byteSize = it.byteSize ?: 0,
        duplicate = duplicate == true,
    )
}

fun PartnerSellersEnvelope.toSellerRows(): List<PartnerSellerRow> =
    sellers.orEmpty().filterNotNull().map { it.toDomain() }

fun SellerReportEnvelope.toSellerReport(): SellerReport? = seller?.let {
    SellerReport(
        seller = it.toDomain(),
        recharge = recharge?.toDomain() ?: RechargeStats(0, 0, 0, 0, 0, 0, 0, 0),
        commission = commission?.toDomain() ?: CommissionSummary(0, 0, 0, 0, ""),
        entries = entries.orEmpty().filterNotNull().map { dto -> dto.toDomain() },
        settlements = settlements.orEmpty().filterNotNull().map { dto -> dto.toDomain() },
        orders = orders.orEmpty().filterNotNull().map { dto -> dto.toDomain() },
    )
}