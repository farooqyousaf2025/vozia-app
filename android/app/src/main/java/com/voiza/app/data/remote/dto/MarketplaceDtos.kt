package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// The member side of the coin-seller market (`/api/marketplace`).
//
// These are allowlisted projections from the backend: no seller contact number, owner link,
// commission rule or evidence blob reaches this app. Every field is nullable/defaulted because
// Gson constructs DTOs without running initialisers, and a malformed row is dropped by the mapper
// rather than shown with a made-up price or status.
// ---------------------------------------------------------------------------

data class MarketplacePackageDto(
    @SerializedName("key") val key: String? = null,
    @SerializedName("label") val label: String? = null,
    @SerializedName("diamonds") val diamonds: Int? = null,
    @SerializedName("amountCents") val amountCents: Int? = null,
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("unitPriceCents") val unitPriceCents: Int? = null,
)

data class MarketplaceSellerDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("code") val code: String? = null,
    @SerializedName("displayName") val displayName: String? = null,
    @SerializedName("marketCountry") val marketCountry: String? = null,
    @SerializedName("paymentRails") val paymentRails: List<String>? = null,
    @SerializedName("packages") val packages: List<MarketplacePackageDto>? = null,
)

data class MarketplaceSellersEnvelope(
    @SerializedName("sellers") val sellers: List<MarketplaceSellerDto>? = null,
)

/** Name the seller and package by the keys the catalogue returned; prices never travel up. */
data class CreateMarketplaceOrderBody(
    @SerializedName("sellerId") val sellerId: String? = null,
    @SerializedName("sellerCode") val sellerCode: String? = null,
    @SerializedName("packageKey") val packageKey: String? = null,
    @SerializedName("packageCode") val packageCode: String? = null,
    @SerializedName("paymentMethod") val paymentMethod: String,
    @SerializedName("note") val note: String? = null,
)

data class MarketplaceOrderDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("reference") val reference: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("sellerId") val sellerId: String? = null,
    @SerializedName("sellerCode") val sellerCode: String? = null,
    @SerializedName("sellerName") val sellerName: String? = null,
    @SerializedName("packageKey") val packageKey: String? = null,
    @SerializedName("diamonds") val diamonds: Int? = null,
    @SerializedName("amountCents") val amountCents: Int? = null,
    @SerializedName("feeCents") val feeCents: Int? = null,
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("paymentMethod") val paymentMethod: String? = null,
    @SerializedName("paymentReference") val paymentReference: String? = null,
    @SerializedName("expiresAt") val expiresAt: String? = null,
    @SerializedName("verifiedAt") val verifiedAt: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("updatedAt") val updatedAt: String? = null,
)

data class MarketplaceOrderEnvelope(
    @SerializedName("order") val order: MarketplaceOrderDto? = null,
)

data class MarketplaceOrdersEnvelope(
    @SerializedName("orders") val orders: List<MarketplaceOrderDto>? = null,
    @SerializedName("total") val total: Int? = null,
    @SerializedName("page") val page: Int? = null,
    @SerializedName("limit") val limit: Int? = null,
)

/** `data` is a base64 string or a data URL, the same shape the partner desk uses. */
data class MarketplaceReceiptBody(
    @SerializedName("fileName") val fileName: String,
    @SerializedName("data") val data: String,
)

data class MarketplaceReceiptDto(
    @SerializedName("receiptId") val receiptId: String? = null,
    @SerializedName("duplicate") val duplicate: Boolean? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
)
