package com.voiza.app.data.export

import com.voiza.app.domain.model.PartnerSellerRow

/**
 * Exports only the seller rows already returned for this BD's authorized territory.
 * Currency amounts are intentionally omitted because seller summary rows do not carry a currency.
 */
fun List<PartnerSellerRow>.toPartnerSellerCsv(): String {
    val header = listOf(
        "seller_code", "seller_name", "status", "market_country",
        "orders", "credited_orders", "awaiting_verification", "failed_orders",
        "reversed_orders", "processed_diamonds",
    )
    return buildString {
        append('\uFEFF')
        append(header.joinToString(",") { it.toCsvField() })
        append("\r\n")
        this@toPartnerSellerCsv.forEach { seller ->
            val row = listOf(
                seller.code,
                seller.displayName,
                seller.statusLabel,
                seller.marketCountry,
                seller.recharge.orders.toString(),
                seller.recharge.credited.toString(),
                seller.recharge.awaitingVerification.toString(),
                seller.recharge.failed.toString(),
                seller.recharge.reversed.toString(),
                seller.recharge.processedDiamonds.toString(),
            )
            append(row.joinToString(",") { it.toCsvField() })
            append("\r\n")
        }
    }
}

private fun String.toCsvField(): String {
    val firstMeaningful = dropWhile { it == ' ' || it == '\t' || it == '\r' || it == '\n' }.firstOrNull()
    val formulaLike = firstMeaningful in setOf('=', '+', '-', '@')
    val controlPrefixed = firstOrNull() in setOf('\t', '\r', '\n')
    val safe = if (formulaLike || controlPrefixed) "'$this" else this
    return if (safe.any { it == ',' || it == '"' || it == '\r' || it == '\n' }) {
        "\"" + safe.replace("\"", "\"\"") + "\""
    } else safe
}
