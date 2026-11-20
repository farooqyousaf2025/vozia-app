package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.MarketplaceOrderDto
import com.voiza.app.data.remote.dto.MarketplaceReceiptDto
import com.voiza.app.data.remote.dto.MarketplaceSellerDto
import com.voiza.app.domain.model.MarketplaceOrder
import com.voiza.app.domain.model.MarketplacePackage
import com.voiza.app.domain.model.MarketplaceReceipt
import com.voiza.app.domain.model.MarketplaceSeller

/**
 * The marketplace catalogue is an allowlist, and a row with a missing id, key or price is dropped:
 * drawing a wrong rate or filling in a plausible-looking status would be worse than omitting the row.
 * Amounts, diamond counts and statuses are always the server's numbers.
 */

fun MarketplaceSellerDto.toDomainOrNull(): MarketplaceSeller? {
    val id = id?.takeIf { it.isNotBlank() } ?: return null
    val code = code?.takeIf { it.isNotBlank() } ?: return null
    val name = displayName?.takeIf { it.isNotBlank() } ?: return null
    return MarketplaceSeller(
        id = id,
        code = code,
        displayName = name,
        marketCountry = marketCountry?.takeIf { it.isNotBlank() },
        paymentRails = paymentRails.orEmpty().map { it.trim().uppercase() }.filter { it.isNotBlank() },
        packages = packages.orEmpty().mapNotNull { it.toDomainOrNull() },
    )
}

private fun com.voiza.app.data.remote.dto.MarketplacePackageDto.toDomainOrNull(): MarketplacePackage? {
    val key = key?.takeIf { it.isNotBlank() } ?: return null
    val diamonds = diamonds ?: return null
    val amountCents = amountCents ?: return null
    if (diamonds <= 0 || amountCents < 0) return null
    return MarketplacePackage(
        key = key,
        label = label?.takeIf { it.isNotBlank() } ?: key,
        diamonds = diamonds,
        amountCents = amountCents,
        currency = currency?.takeIf { it.isNotBlank() } ?: "usd",
        unitPriceCents = unitPriceCents ?: 0,
    )
}

fun MarketplaceOrderDto.toDomainOrNull(): MarketplaceOrder? {
    val id = id?.takeIf { it.isNotBlank() } ?: return null
    val reference = reference?.takeIf { it.isNotBlank() } ?: return null
    val status = status?.takeIf { it.isNotBlank() } ?: return null
    val sellerId = sellerId?.takeIf { it.isNotBlank() } ?: return null
    val createdAt = createdAt?.takeIf { it.isNotBlank() } ?: return null
    return MarketplaceOrder(
        id = id,
        reference = reference,
        status = status,
        sellerId = sellerId,
        sellerName = sellerName?.takeIf { it.isNotBlank() } ?: sellerId,
        packageKey = packageKey?.takeIf { it.isNotBlank() },
        diamonds = diamonds ?: 0,
        amountCents = amountCents ?: 0,
        currency = currency?.takeIf { it.isNotBlank() } ?: "usd",
        paymentMethod = paymentMethod?.takeIf { it.isNotBlank() } ?: "",
        paymentReference = paymentReference?.takeIf { it.isNotBlank() },
        expiresAt = expiresAt,
        createdAt = createdAt,
    )
}

fun MarketplaceReceiptDto.toDomainOrNull(): MarketplaceReceipt? {
    val id = receiptId?.takeIf { it.isNotBlank() } ?: return null
    return MarketplaceReceipt(
        receiptId = id,
        duplicate = duplicate ?: false,
        createdAt = createdAt.orEmpty(),
    )
}
