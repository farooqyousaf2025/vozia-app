package com.voiza.app.domain.model

import java.util.Locale

// ---------------------------------------------------------------------------
// Server-driven top-up catalogue (migration 0048) and the first-recharge gate.
// The price, the bonus and the unlock status are the server's answers: a device that edits any of
// these can only change what it draws, never what a recharge credits or what a purchase unlocks.
// ---------------------------------------------------------------------------

/**
 * A package from `GET /api/wallet/packages`, in the order the operator set.
 *
 * [totalDiamonds] is the server's sum of the base pack and the advertised bonus; the chip a member
 * taps should quote it, and a checkout keyed by [id] credits exactly that many diamonds.
 */
data class DiamondPackage(
    val id: String,
    val code: String,
    val name: String,
    val diamonds: Int,
    val bonusDiamonds: Int,
    val totalDiamonds: Int,
    val priceCents: Int,
    val currency: String,
    val sortOrder: Int,
) {
    /** `priceCents` is the authoritative amount; formatting it is the only arithmetic done here. */
    fun priceLabel(): String = buildString {
        val usd = currency.equals("usd", ignoreCase = true)
        if (usd) append('$')
        append(String.format(Locale.US, "%.2f", priceCents / 100.0))
        if (!usd) append(' ').append(currency.uppercase(Locale.US))
    }
}

/**
 * Derived by the server from completed RECHARGE ledger rows, so a repaired or refunded entry cannot
 * leave the app showing an unlock that the ledger does not back.
 */
data class FirstRechargeStatus(
    val required: Boolean,
    val completed: Boolean,
    val completedAt: String?,
    val count: Int,
)

/** A PaymentIntent the server created. The balance moves only after Stripe's signed webhook. */
data class CheckoutSession(
    val paymentIntentId: String,
    val clientSecret: String,
    val amountCents: Int,
    val currency: String,
    val amountDiamonds: Int,
    val packageId: String?,
    val publishableKeyHint: String?,
)
