package com.voiza.app.data.export

import com.voiza.app.domain.model.RechargeOrder

/**
 * Exports only the already-loaded orders returned for the signed-in partner account.
 * Amounts remain in minor units with an explicit currency column; no exchange-rate assumptions.
 */
fun List<RechargeOrder>.toRechargeOrderCsv(): String {
    val header = listOf(
        "order_reference", "status", "customer_username", "diamonds",
        "amount_minor", "fee_minor", "currency", "payment_method",
        "payment_reference", "created_at", "verified_at", "finance_note", "reversal_reason",
    )
    return buildString {
        append('\uFEFF')
        append(header.joinToString(",") { it.toCsvField() })
        append("\r\n")
        this@toRechargeOrderCsv.forEach { order ->
            val row = listOf(
                order.reference,
                order.statusLabel,
                order.username,
                order.diamonds.toString(),
                order.amountMinor.toString(),
                order.feeMinor.toString(),
                order.currency,
                order.paymentMethod,
                order.paymentRef.orEmpty(),
                order.createdAt.orEmpty(),
                order.verifiedAt.orEmpty(),
                order.decisionNote.orEmpty(),
                order.reversalReason.orEmpty(),
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
