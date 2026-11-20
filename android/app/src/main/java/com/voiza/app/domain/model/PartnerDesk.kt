package com.voiza.app.domain.model

// ---------------------------------------------------------------------------
// The partner desk — `/api/partner`, migration 0046.
//
// A coin seller's and a BD's operational book, read with the member's own session: the server finds
// the account from `business_accounts.owner_user_id`, so no id here selects whose book to open.
// A seller can open an order, claim payment and attach proof; a BD reads its sellers' books. Neither
// credits diamonds nor settles commission — those stay with finance, and the labels say so.
//
// Two units appear and neither is the other's proxy: minor currency units are the money an order
// collects and a commission line counts; R-coins are what a member sells back to a seller. The cash
// book keeps them apart on purpose — the cash handed to a member was agreed outside the platform.
//
// Every wire enum parses to a label this build knows and falls back to the server's own string, so a
// state added later reads as that state rather than vanishing from the row that carries it.
// ---------------------------------------------------------------------------

/** Which desk this is: a seller collects money, a BD reads the sellers under it. */
enum class PartnerKind(val wire: String, val label: String) {
    COIN_SELLER("COIN_SELLER", "Coin seller"),
    BD_MANAGER("BD_MANAGER", "BD manager"),
    BD_AGENT("BD_AGENT", "BD agent"),
    ;

    companion object {
        fun fromWire(value: String?): PartnerKind? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

enum class PartnerAccountStatus(val wire: String, val label: String) {
    PENDING("PENDING", "Waiting for activation"),
    ACTIVE("ACTIVE", "Active"),
    SUSPENDED("SUSPENDED", "Suspended"),
    CLOSED("CLOSED", "Closed"),
    ;

    companion object {
        fun fromWire(value: String?): PartnerAccountStatus? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

/** An order's life: opened, paid, decided. Only finance moves it past AWAITING_VERIFICATION. */
enum class RechargeOrderStatus(val wire: String, val label: String) {
    AWAITING_PAYMENT("AWAITING_PAYMENT", "Waiting for payment"),
    AWAITING_VERIFICATION("AWAITING_VERIFICATION", "Payment claimed, in review"),
    CREDITED("CREDITED", "Credited"),
    REJECTED("REJECTED", "Rejected"),
    CANCELLED("CANCELLED", "Cancelled"),
    EXPIRED("EXPIRED", "Expired"),
    REVERSED("REVERSED", "Reversed"),
    ;

    companion object {
        fun fromWire(value: String?): RechargeOrderStatus? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

/** One commission line's state: counted, claimed by a batch, or undone. */
enum class CommissionEntryStatus(val wire: String, val label: String) {
    ACCRUED("ACCRUED", "Accrued"),
    REJECTED("REJECTED", "Rejected"),
    SETTLED("SETTLED", "Settled"),
    REVERSED("REVERSED", "Reversed"),
    ;

    companion object {
        fun fromWire(value: String?): CommissionEntryStatus? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

enum class CommissionSettlementStatus(val wire: String, val label: String) {
    DRAFT("DRAFT", "Not approved yet"),
    APPROVED("APPROVED", "Approved, awaiting payment"),
    PAID("PAID", "Paid"),
    VOID("VOID", "Cancelled"),
    ;

    companion object {
        fun fromWire(value: String?): CommissionSettlementStatus? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

/** A member's R-coin sale, from the seller's side: pay the cash, attach the proof, finance confirms. */
enum class SellerPayoutStatus(val wire: String, val label: String) {
    PENDING("PENDING", "Waiting for your payment"),
    APPROVED("APPROVED", "Approved, awaiting payment"),
    REJECTED("REJECTED", "Rejected"),
    PAID("PAID", "Paid"),
    ;

    companion object {
        fun fromWire(value: String?): SellerPayoutStatus? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

/** The account this member runs. `parentName` is the BD above a seller; null when there is none. */
data class PartnerAccount(
    val id: String,
    val kind: PartnerKind?,
    val kindLabel: String,
    val code: String,
    val displayName: String,
    val status: PartnerAccountStatus?,
    val statusLabel: String,
    val marketCountry: String,
    val parentName: String?,
    val parentCode: String?,
    val maxOrderDiamonds: Int,
    val dailyDiamondLimit: Int,
    val dailyOrderLimit: Int,
    val suspendedReason: String?,
    val createdAt: String?,
) {
    val isSeller: Boolean get() = kind == PartnerKind.COIN_SELLER
    val isBd: Boolean get() = kind == PartnerKind.BD_MANAGER || kind == PartnerKind.BD_AGENT
}

/** The whoami answer: the account, what it may do, and the ways a customer can pay. */
data class PartnerWhoami(
    val account: PartnerAccount,
    val permissions: List<String>,
    val paymentRails: List<String>,
)

data class RechargeStats(
    val orders: Int,
    val credited: Int,
    val awaitingVerification: Int,
    val failed: Int,
    val reversed: Int,
    val processedDiamonds: Int,
    val collectedMinor: Int,
    val netCollectedMinor: Int,
)

data class CommissionSummary(
    val accruedMinor: Int,
    val settledMinor: Int,
    val reversedMinor: Int,
    val entryCount: Int,
    val currency: String,
)

/** GET /api/partner/dashboard — the numbers card, plus a BD's territory. */
data class PartnerDashboard(
    val account: PartnerAccount,
    val recharge: RechargeStats,
    val commission: CommissionSummary,
    val sellers: List<PartnerAccount>,
)

/** One row of the operator's price list. The order names the key; the price is the server's. */
data class RechargePackage(
    val key: String,
    val label: String,
    val diamonds: Int,
    val amountMinor: Int,
    val currency: String,
)

data class RechargeOrder(
    val id: String,
    val reference: String,
    val status: RechargeOrderStatus?,
    val statusLabel: String,
    val sellerCode: String,
    val sellerName: String,
    val bdCode: String,
    val username: String,
    val diamonds: Int,
    val amountMinor: Int,
    val feeMinor: Int,
    val currency: String,
    val paymentMethod: String,
    val paymentRef: String?,
    val decisionNote: String?,
    val reversalReason: String?,
    val expiresAt: String?,
    val verifiedAt: String?,
    val createdAt: String?,
) {
    /** The two states where the seller still has a move: collect, or withdraw. */
    val isOpen: Boolean
        get() = status == RechargeOrderStatus.AWAITING_PAYMENT || status == RechargeOrderStatus.AWAITING_VERIFICATION
}

data class RechargeOrderPage(
    val orders: List<RechargeOrder>,
    val total: Int,
)

/** A member the seller looked up before opening an order — the server's view, recent orders included. */
data class PartnerCustomer(
    val username: String,
    val status: String,
    val createdAt: String?,
    val recentOrders: List<RechargeOrder>,
)

data class CommissionEntry(
    val id: String,
    val orderReference: String,
    val kind: String,
    val status: CommissionEntryStatus?,
    val statusLabel: String,
    val basisMinor: Int,
    val amountMinor: Int,
    val currency: String,
    val reversalReason: String?,
    val settlementReference: String?,
    val settledAt: String?,
    val createdAt: String?,
)

data class CommissionSettlement(
    val reference: String,
    val amountMinor: Int,
    val currency: String,
    val entryCount: Int,
    val status: CommissionSettlementStatus?,
    val statusLabel: String,
    val periodFrom: String?,
    val periodTo: String?,
    val paidAt: String?,
    val note: String?,
    val createdAt: String?,
)

data class SellerCashOutRow(
    val reference: String,
    val username: String,
    val netRCoins: Int,
    val feeRCoins: Int,
    val paidAt: String?,
    val receiptCount: Int,
)

/**
 * The seller's cash book. `remittanceMinor` is what the platform is still owed from cash collected;
 * the R-coin totals are a separate book and are never added to it.
 */
data class SellerCashBook(
    val currency: String,
    val collectedNetMinor: Int,
    val refundedMinor: Int,
    val commissionSettledMinor: Int,
    val commissionAccruedMinor: Int,
    val remittanceMinor: Int,
    val afterAccruedMinor: Int,
    val creditedOrders: Int,
    val cashOutNetRCoins: Int,
    val cashOutFeeRCoins: Int,
    val cashOutCount: Int,
    val awaitingCashOutRCoins: Int,
    val cashOut: List<SellerCashOutRow>,
)

/** GET /api/partner/statement. `cash` is null for a BD — a BD holds no cash. */
data class PartnerStatement(
    val summary: CommissionSummary,
    val entries: List<CommissionEntry>,
    val totalEntries: Int,
    val settlements: List<CommissionSettlement>,
    val cash: SellerCashBook?,
)

data class SellerPayout(
    val id: String,
    val reference: String,
    val username: String,
    val amountRCoins: Int,
    val feeRCoins: Int,
    val netRCoins: Int,
    val status: SellerPayoutStatus?,
    val statusLabel: String,
    val receiptCount: Int,
    val createdAt: String?,
) {
    /** Proof can be attached while finance has not finished with the sale. */
    val acceptsReceipt: Boolean
        get() = status == SellerPayoutStatus.PENDING || status == SellerPayoutStatus.APPROVED
}

data class SellerPayoutPage(
    val payouts: List<SellerPayout>,
    val total: Int,
)

/** The server's word on an attached proof. `duplicate` means these exact bytes were already on file. */
data class UploadedReceipt(
    val fileName: String,
    val byteSize: Int,
    val duplicate: Boolean,
)

/** One seller in a BD's territory, with its own recharge numbers beside it. */
data class PartnerSellerRow(
    val id: String,
    val code: String,
    val displayName: String,
    val status: PartnerAccountStatus?,
    val statusLabel: String,
    val marketCountry: String,
    val recharge: RechargeStats,
)

/** One seller's whole book, as the BD that owns it reads it. */
data class SellerReport(
    val seller: PartnerAccount,
    val recharge: RechargeStats,
    val commission: CommissionSummary,
    val entries: List<CommissionEntry>,
    val settlements: List<CommissionSettlement>,
    val orders: List<RechargeOrder>,
)