package com.voiza.app.domain.model

import java.util.Locale

/** A package a seller may actually sell. Every number is the server's own row. */
data class MarketplacePackage(
    val key: String,
    val label: String,
    val diamonds: Int,
    val amountCents: Int,
    val currency: String,
    val unitPriceCents: Int,
) {
    fun priceLabel(): String =
        if (currency.equals("usd", ignoreCase = true)) {
            "\$${"%,.2f".format(Locale.US, amountCents / 100.0)}"
        } else {
            "${amountCents / 100.0} ${currency.uppercase(Locale.US)}"
        }
}

/** An approved coin seller, with only the fields a buyer is allowed to see. */
data class MarketplaceSeller(
    val id: String,
    val code: String,
    val displayName: String,
    val marketCountry: String?,
    val paymentRails: List<String>,
    val packages: List<MarketplacePackage>,
)

/** A member's own recharge order. Status is the server's; nothing here predicts settlement. */
data class MarketplaceOrder(
    val id: String,
    val reference: String,
    val status: String,
    val sellerId: String,
    val sellerName: String,
    val packageKey: String?,
    val diamonds: Int,
    val amountCents: Int,
    val currency: String,
    val paymentMethod: String,
    val paymentReference: String?,
    val expiresAt: String?,
    val createdAt: String,
)

data class MarketplaceReceipt(
    val receiptId: String,
    val duplicate: Boolean,
    val createdAt: String,
)
