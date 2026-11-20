package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.CheckoutResponse
import com.voiza.app.data.remote.dto.DiamondPackageDto
import com.voiza.app.data.remote.dto.FirstRechargeDto
import com.voiza.app.domain.model.CheckoutSession
import com.voiza.app.domain.model.DiamondPackage
import com.voiza.app.domain.model.FirstRechargeStatus

// ---------------------------------------------------------------------------
// Wire-to-domain copies for the wallet catalogue. A row missing the fields needed to describe a
// pack is dropped from the list; a single-row answer that cannot be mapped is turned into a failure
// by the repository instead of becoming a half-price card on screen.
// ---------------------------------------------------------------------------

fun DiamondPackageDto.toDomainOrNull(): DiamondPackage? {
    val id = id?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val code = code?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val name = name?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val diamonds = diamonds ?: return null
    val priceCents = priceCents ?: return null
    return DiamondPackage(
        id = id,
        code = code,
        name = name,
        diamonds = diamonds,
        bonusDiamonds = bonusDiamonds ?: 0,
        // The server sends the total; trusting it avoids a client/server disagreement about a bonus.
        totalDiamonds = totalDiamonds ?: diamonds,
        priceCents = priceCents,
        currency = currency?.trim()?.takeIf { it.isNotEmpty() } ?: "usd",
        sortOrder = sortOrder ?: Int.MAX_VALUE,
    )
}

fun FirstRechargeDto.toDomain(): FirstRechargeStatus = FirstRechargeStatus(
    required = required ?: !completed.orDefaultFalse(),
    completed = completed.orDefaultFalse(),
    completedAt = completedAt,
    count = (count ?: 0).coerceAtLeast(0),
)

private fun Boolean?.orDefaultFalse(): Boolean = this == true

fun CheckoutResponse.toDomainOrNull(): CheckoutSession? {
    val intentId = paymentIntentId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val secret = clientSecret?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return CheckoutSession(
        paymentIntentId = intentId,
        clientSecret = secret,
        amountCents = amountCents ?: return null,
        currency = currency?.trim()?.takeIf { it.isNotEmpty() } ?: "usd",
        amountDiamonds = amountDiamonds ?: return null,
        packageId = packageId,
        publishableKeyHint = publishableKeyHint,
    )
}
