package com.voiza.app.data.export

import com.voiza.app.domain.model.PartnerStatement

/**
 * Exports only the statement returned for the authenticated partner account.
 * Currency minor units and R-coins stay in separate sections and are never combined.
 */
fun PartnerStatement.toPartnerStatementCsv(): String = buildString {
    append('\uFEFF')
    appendLine("section,reference,status,kind_or_username,amount_minor,currency,details,date")
    entries.forEach { entry ->
        row("commission", entry.orderReference, entry.statusLabel, entry.kind,
            entry.amountMinor.toString(), entry.currency,
            listOfNotNull(
                entry.settlementReference?.let { "batch=" + it },
                entry.reversalReason?.let { "reversal=" + it },
            ).joinToString(";"), entry.createdAt.orEmpty())
    }
    settlements.forEach { batch ->
        row("settlement", batch.reference, batch.statusLabel, batch.entryCount.toString() + " entries",
            batch.amountMinor.toString(), batch.currency,
            listOfNotNull(batch.note, batch.periodFrom?.let { "from=" + it },
                batch.periodTo?.let { "to=" + it }).joinToString(";"),
            batch.paidAt ?: batch.createdAt.orEmpty())
    }
    cash?.let { book ->
        row("cash_summary", "cash-book", "summary", "collected_net", book.collectedNetMinor.toString(), book.currency, "minor currency units", "")
        row("cash_summary", "cash-book", "summary", "refunded", book.refundedMinor.toString(), book.currency, "minor currency units", "")
        row("cash_summary", "cash-book", "summary", "commission_settled", book.commissionSettledMinor.toString(), book.currency, "minor currency units", "")
        row("cash_summary", "cash-book", "summary", "commission_accrued", book.commissionAccruedMinor.toString(), book.currency, "minor currency units", "")
        row("cash_summary", "cash-book", "summary", "remittance_due", book.remittanceMinor.toString(), book.currency, "minor currency units; informational only", "")
        row("cash_summary", "cash-book", "summary", "after_accrued", book.afterAccruedMinor.toString(), book.currency, "minor currency units", "")
        row("cashout_summary", "cash-book", "summary", "net_r_coins_paid", book.cashOutNetRCoins.toString(), "RCOIN", "R-coins; separate from cash", "")
        row("cashout_summary", "cash-book", "summary", "fee_r_coins", book.cashOutFeeRCoins.toString(), "RCOIN", "R-coins; separate from cash", "")
        row("cashout_summary", "cash-book", "summary", "awaiting_cashout_r_coins", book.awaitingCashOutRCoins.toString(), "RCOIN", "R-coins; separate from cash", "")
        book.cashOut.forEach { item ->
            row("cashout", item.reference, "paid", item.username, item.netRCoins.toString(), "RCOIN",
                "fee_r_coins=" + item.feeRCoins + "; receipts=" + item.receiptCount, item.paidAt.orEmpty())
        }
    }
}

private fun StringBuilder.row(vararg values: String) {
    append(values.joinToString(",") { it.csvCell() })
    append("\r\n")
}

private fun String.csvCell(): String {
    val safe = if (firstOrNull() in listOf('=', '+', '-', '@', '\t', '\r')) "'" + this else this
    return "\"" + safe.replace("\"", "\"\"") + "\""
}
