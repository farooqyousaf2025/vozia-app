package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// The partner desk (`/api/partner`, migration 0046).
//
// The same book the business panel serves, read with a member token: the server resolves the account
// from `business_accounts.owner_user_id`, so no id in a URL or body can point at somebody else's book.
// The write bodies here are exactly the ones the business panel sends — order creation, mark-paid,
// cancel, receipt attach — and every amount in them is either chosen from the server's own package
// list or a reference the operator will verify; no price or balance is ever computed on this device.
//
// Gson builds these without running their initialisers, so every key whose absence would change the
// answer is nullable and takes its fallback in the mapper.
// ---------------------------------------------------------------------------

/** GET /api/partner/me. `paymentRails` is the server's list of ways a customer can hand over money. */
data class PartnerWhoamiEnvelope(
    @SerializedName("account") val account: PartnerAccountDto? = null,
    @SerializedName("permissions") val permissions: List<String>? = null,
    @SerializedName("paymentRails") val paymentRails: List<String>? = null,
)

data class PartnerAccountDto(
    @SerializedName("id") val id: String? = null,
    /** COIN_SELLER, BD_MANAGER or BD_AGENT. Kept a string so a new kind parses. */
    @SerializedName("kind") val kind: String? = null,
    @SerializedName("code") val code: String? = null,
    @SerializedName("displayName") val displayName: String? = null,
    @SerializedName("contactPhone") val contactPhone: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("marketCountry") val marketCountry: String? = null,
    @SerializedName("parentCode") val parentCode: String? = null,
    @SerializedName("parentName") val parentName: String? = null,
    @SerializedName("maxOrderDiamonds") val maxOrderDiamonds: Int? = null,
    @SerializedName("dailyDiamondLimit") val dailyDiamondLimit: Int? = null,
    @SerializedName("dailyOrderLimit") val dailyOrderLimit: Int? = null,
    @SerializedName("approvedAt") val approvedAt: String? = null,
    @SerializedName("suspendedReason") val suspendedReason: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
)

/** The recharge half of a dashboard: counts of orders and the money they moved, in minor units. */
data class RechargeStatsDto(
    @SerializedName("orders") val orders: Int? = null,
    @SerializedName("credited") val credited: Int? = null,
    @SerializedName("awaitingVerification") val awaitingVerification: Int? = null,
    @SerializedName("failed") val failed: Int? = null,
    @SerializedName("reversed") val reversed: Int? = null,
    @SerializedName("processedDiamonds") val processedDiamonds: Int? = null,
    @SerializedName("collectedCents") val collectedCents: Int? = null,
    @SerializedName("netCollectedCents") val netCollectedCents: Int? = null,
)

data class CommissionSummaryDto(
    @SerializedName("accruedCents") val accruedCents: Int? = null,
    @SerializedName("settledCents") val settledCents: Int? = null,
    @SerializedName("reversedCents") val reversedCents: Int? = null,
    @SerializedName("entryCount") val entryCount: Int? = null,
    @SerializedName("currency") val currency: String? = null,
)

/** GET /api/partner/dashboard. `sellers` is empty for a coin seller — a BD's territory. */
data class PartnerDashboardEnvelope(
    @SerializedName("account") val account: PartnerAccountDto? = null,
    @SerializedName("recharge") val recharge: RechargeStatsDto? = null,
    @SerializedName("commission") val commission: CommissionSummaryDto? = null,
    @SerializedName("availableCommissionCents") val availableCommissionCents: Int? = null,
    @SerializedName("sellers") val sellers: List<PartnerAccountDto>? = null,
)

/** GET /api/partner/packages — the price list the operator set; an order names a key, never a price. */
data class RechargePackageDto(
    @SerializedName("key") val key: String? = null,
    @SerializedName("label") val label: String? = null,
    @SerializedName("diamonds") val diamonds: Int? = null,
    @SerializedName("amountCents") val amountCents: Int? = null,
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("unitPriceCents") val unitPriceCents: Int? = null,
    @SerializedName("isActive") val isActive: Boolean? = null,
)

data class RechargePackagesEnvelope(
    @SerializedName("packages") val packages: List<RechargePackageDto>? = null,
)

/**
 * A recharge order. `evidence` and `rulesSnapshot` stay on the server — they are the operator's audit
 * trail, not anything the desk renders, so this type does not carry them.
 */
data class RechargeOrderDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("reference") val reference: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("sellerCode") val sellerCode: String? = null,
    @SerializedName("sellerName") val sellerName: String? = null,
    @SerializedName("bdCode") val bdCode: String? = null,
    @SerializedName("username") val username: String? = null,
    @SerializedName("diamonds") val diamonds: Int? = null,
    @SerializedName("amountCents") val amountCents: Int? = null,
    @SerializedName("feeCents") val feeCents: Int? = null,
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("paymentMethod") val paymentMethod: String? = null,
    @SerializedName("paymentRef") val paymentRef: String? = null,
    @SerializedName("decisionNote") val decisionNote: String? = null,
    @SerializedName("reversalReason") val reversalReason: String? = null,
    @SerializedName("expiresAt") val expiresAt: String? = null,
    @SerializedName("verifiedAt") val verifiedAt: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
)

data class RechargeOrdersEnvelope(
    @SerializedName("orders") val orders: List<RechargeOrderDto>? = null,
    @SerializedName("total") val total: Int? = null,
    @SerializedName("page") val page: Int? = null,
    @SerializedName("limit") val limit: Int? = null,
)

data class RechargeOrderEnvelope(
    @SerializedName("order") val order: RechargeOrderDto? = null,
)

/** GET /api/partner/customers/lookup — a member's recent orders, so the desk can check a phone first. */
data class CustomerLookupDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("username") val username: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("created") val created: String? = null,
    @SerializedName("orders") val orders: List<RechargeOrderDto>? = null,
)

data class CustomerLookupEnvelope(
    @SerializedName("customer") val customer: CustomerLookupDto? = null,
)

/** One commission line: money counted for this account on an order's accrual. */
data class CommissionEntryDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("orderReference") val orderReference: String? = null,
    @SerializedName("beneficiary") val beneficiary: String? = null,
    @SerializedName("beneficiaryCode") val beneficiaryCode: String? = null,
    @SerializedName("beneficiaryName") val beneficiaryName: String? = null,
    @SerializedName("kind") val kind: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("basisCents") val basisCents: Int? = null,
    @SerializedName("amountCents") val amountCents: Int? = null,
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("reversedAt") val reversedAt: String? = null,
    @SerializedName("reversalReason") val reversalReason: String? = null,
    @SerializedName("settlementReference") val settlementReference: String? = null,
    @SerializedName("settledAt") val settledAt: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
)

/** A finance batch that claimed a stretch of commission lines. `paidAt` is null until the money moves. */
data class CommissionSettlementDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("reference") val reference: String? = null,
    @SerializedName("beneficiary") val beneficiary: String? = null,
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("amountCents") val amountCents: Int? = null,
    @SerializedName("entryCount") val entryCount: Int? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("periodFrom") val periodFrom: String? = null,
    @SerializedName("periodTo") val periodTo: String? = null,
    @SerializedName("payoutMethod") val payoutMethod: String? = null,
    @SerializedName("paidAt") val paidAt: String? = null,
    @SerializedName("note") val note: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
)

/** One paid-out R-coin sale, as the seller's cash book lists it. */
data class SellerCashOutDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("reference") val reference: String? = null,
    @SerializedName("username") val username: String? = null,
    @SerializedName("amountRCoins") val amountRCoins: Int? = null,
    @SerializedName("feeRCoins") val feeRCoins: Int? = null,
    @SerializedName("netRCoins") val netRCoins: Int? = null,
    @SerializedName("paidAt") val paidAt: String? = null,
    @SerializedName("payoutReference") val payoutReference: String? = null,
    @SerializedName("receiptCount") val receiptCount: Int? = null,
)

/**
 * The seller's cash book: money collected for the platform and R-coins bought back from members.
 * The two halves are never summed — the cash paid to a member was agreed outside the platform.
 */
data class SellerCashBookDto(
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("collectedNetCents") val collectedNetCents: Int? = null,
    @SerializedName("refundedCents") val refundedCents: Int? = null,
    @SerializedName("commissionSettledCents") val commissionSettledCents: Int? = null,
    @SerializedName("commissionAccruedCents") val commissionAccruedCents: Int? = null,
    @SerializedName("remittanceCents") val remittanceCents: Int? = null,
    @SerializedName("afterAccruedCents") val afterAccruedCents: Int? = null,
    @SerializedName("creditedOrders") val creditedOrders: Int? = null,
    @SerializedName("cashOutNetRCoins") val cashOutNetRCoins: Int? = null,
    @SerializedName("cashOutFeeRCoins") val cashOutFeeRCoins: Int? = null,
    @SerializedName("cashOutCount") val cashOutCount: Int? = null,
    @SerializedName("awaitingCashOutRCoins") val awaitingCashOutRCoins: Int? = null,
    @SerializedName("cashOut") val cashOut: List<SellerCashOutDto>? = null,
)

/** GET /api/partner/statement. `cash` is absent for a BD — a BD holds no cash. */
data class PartnerStatementEnvelope(
    @SerializedName("account") val account: PartnerAccountDto? = null,
    @SerializedName("summary") val summary: CommissionSummaryDto? = null,
    @SerializedName("entries") val entries: List<CommissionEntryDto>? = null,
    @SerializedName("total") val total: Int? = null,
    @SerializedName("settlements") val settlements: List<CommissionSettlementDto>? = null,
    @SerializedName("cash") val cash: SellerCashBookDto? = null,
    @SerializedName("page") val page: Int? = null,
    @SerializedName("limit") val limit: Int? = null,
)

/** A member's R-coin sale request, waiting for the seller to pay cash and attach proof. */
data class SellerPayoutDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("reference") val reference: String? = null,
    @SerializedName("username") val username: String? = null,
    @SerializedName("amountRCoins") val amountRCoins: Int? = null,
    @SerializedName("feeRCoins") val feeRCoins: Int? = null,
    @SerializedName("netRCoins") val netRCoins: Int? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("receiptCount") val receiptCount: Int? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
)

data class SellerPayoutsEnvelope(
    @SerializedName("payouts") val payouts: List<SellerPayoutDto>? = null,
    @SerializedName("total") val total: Int? = null,
    @SerializedName("page") val page: Int? = null,
    @SerializedName("limit") val limit: Int? = null,
)

/** POST /api/partner/receipts. `duplicate` true means these exact bytes were already on file. */
data class PaymentReceiptDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("fileName") val fileName: String? = null,
    @SerializedName("contentType") val contentType: String? = null,
    @SerializedName("byteSize") val byteSize: Int? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
)

data class ReceiptUploadEnvelope(
    @SerializedName("receipt") val receipt: PaymentReceiptDto? = null,
    @SerializedName("duplicate") val duplicate: Boolean? = null,
)

/** GET /api/partner/sellers — a BD's territory, each row carrying its own recharge numbers. */
data class PartnerSellerRowDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("kind") val kind: String? = null,
    @SerializedName("code") val code: String? = null,
    @SerializedName("displayName") val displayName: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("marketCountry") val marketCountry: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("recharge") val recharge: RechargeStatsDto? = null,
)

data class PartnerSellersEnvelope(
    @SerializedName("sellers") val sellers: List<PartnerSellerRowDto>? = null,
)

/** GET /api/partner/sellers/:id/report — one seller's book, refused for a seller outside the territory. */
data class SellerReportEnvelope(
    @SerializedName("seller") val seller: PartnerAccountDto? = null,
    @SerializedName("recharge") val recharge: RechargeStatsDto? = null,
    @SerializedName("commission") val commission: CommissionSummaryDto? = null,
    @SerializedName("entries") val entries: List<CommissionEntryDto>? = null,
    @SerializedName("settlements") val settlements: List<CommissionSettlementDto>? = null,
    @SerializedName("orders") val orders: List<RechargeOrderDto>? = null,
    @SerializedName("page") val page: Int? = null,
    @SerializedName("limit") val limit: Int? = null,
)

// ---- Write bodies ----------------------------------------------------------
// Each mirrors the business panel's own payload. The phone names a member the server resolves; the
// package key names a price the operator set; nothing here carries an amount the app worked out.

data class CreateRechargeOrderBody(
    @SerializedName("phone") val phone: String,
    @SerializedName("packageKey") val packageKey: String,
    @SerializedName("paymentMethod") val paymentMethod: String,
    @SerializedName("note") val note: String? = null,
)

data class MarkOrderPaidBody(
    @SerializedName("paymentRef") val paymentRef: String,
)

data class CancelOrderBody(
    @SerializedName("reason") val reason: String,
)

/** Exactly one of `orderId` / `withdrawalId` — what the proof is for. `data` is base64 or a data URL. */
data class UploadReceiptBody(
    @SerializedName("orderId") val orderId: String? = null,
    @SerializedName("withdrawalId") val withdrawalId: String? = null,
    @SerializedName("fileName") val fileName: String,
    @SerializedName("data") val data: String,
)