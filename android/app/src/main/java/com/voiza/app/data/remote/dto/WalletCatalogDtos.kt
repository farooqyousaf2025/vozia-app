package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// The buyer's diamond catalogue and the paid checkout hand-off.
//
// Every key is nullable with a safe default because Gson constructs these without running their
// initialisers. Prices, diamond counts and the gate status are read from the wire; this layer never
// calculates a package's total or decides that a member has completed a recharge.
// ---------------------------------------------------------------------------

/** One active row of `diamond_packages`, already resolved by `listDiamondPackages`. */
data class DiamondPackageDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("code") val code: String? = null,
    @SerializedName("name") val name: String? = null,
    @SerializedName("diamonds") val diamonds: Int? = null,
    @SerializedName("bonusDiamonds") val bonusDiamonds: Int? = null,
    /** The server's sum of [diamonds] and [bonusDiamonds], not a client calculation. */
    @SerializedName("totalDiamonds") val totalDiamonds: Int? = null,
    @SerializedName("priceCents") val priceCents: Int? = null,
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("sortOrder") val sortOrder: Int? = null,
)

data class DiamondPackagesEnvelope(
    @SerializedName("packages") val packages: List<DiamondPackageDto>? = null,
)

/** `GET /api/wallet/first-recharge`, also embedded in `GET /api/wallet`. */
data class FirstRechargeDto(
    @SerializedName("required") val required: Boolean? = null,
    @SerializedName("completed") val completed: Boolean? = null,
    @SerializedName("completedAt") val completedAt: String? = null,
    @SerializedName("count") val count: Int? = null,
)

/**
 * `POST /api/wallet/recharge/checkout`. Send the package id *or* a legacy diamond amount; when a
 * package id is present the server reads both the price and the credit from its own row.
 */
data class CheckoutBody(
    @SerializedName("packageId") val packageId: String? = null,
    @SerializedName("amountDiamonds") val amountDiamonds: Int? = null,
)

/**
 * The intent Stripe should present. The server never credits on this response — the signed webhook
 * does — and `publishableKeyHint` is only a hint, not a usable key.
 */
data class CheckoutResponse(
    @SerializedName("paymentIntentId") val paymentIntentId: String? = null,
    @SerializedName("clientSecret") val clientSecret: String? = null,
    @SerializedName("amountCents") val amountCents: Int? = null,
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("amountDiamonds") val amountDiamonds: Int? = null,
    @SerializedName("packageId") val packageId: String? = null,
    @SerializedName("publishableKeyHint") val publishableKeyHint: String? = null,
)
