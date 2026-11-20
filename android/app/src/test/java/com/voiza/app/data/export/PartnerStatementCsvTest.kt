package com.voiza.app.data.export

import com.voiza.app.domain.model.CommissionEntry
import com.voiza.app.domain.model.CommissionSummary
import com.voiza.app.domain.model.PartnerStatement
import org.junit.Assert.assertTrue
import org.junit.Test

class PartnerStatementCsvTest {
    @Test
    fun exportsStatementRowsWithExplicitCurrencyMinorUnits() {
        val statement = PartnerStatement(
            summary = CommissionSummary(5000, 2500, 0, 1, "PKR"),
            entries = listOf(
                CommissionEntry(
                    id = "internal-id",
                    orderReference = "RCH-100",
                    kind = "SELLER_PERCENT",
                    status = null,
                    statusLabel = "Accrued",
                    basisMinor = 100000,
                    amountMinor = 5000,
                    currency = "PKR",
                    reversalReason = null,
                    settlementReference = null,
                    settledAt = null,
                    createdAt = "2026-11-21T08:00:00Z",
                ),
            ),
            totalEntries = 1,
            settlements = emptyList(),
            cash = null,
        )

        val csv = statement.toPartnerStatementCsv()
        assertTrue(csv.startsWith("\uFEFFsection,reference,status"))
        assertTrue(csv.contains("\"commission\",\"RCH-100\",\"Accrued\",\"SELLER_PERCENT\",\"5000\",\"PKR\""))
        assertTrue(!csv.contains("internal-id"))
    }

    @Test
    fun neutralizesSpreadsheetFormulasAndQuotesStatementText() {
        val statement = PartnerStatement(
            summary = CommissionSummary(0, 0, 0, 1, "PKR"),
            entries = listOf(
                CommissionEntry(
                    id = "id",
                    orderReference = "=HYPERLINK(\"x\")",
                    kind = "SELLER, TIER",
                    status = null,
                    statusLabel = "Accrued",
                    basisMinor = 0,
                    amountMinor = 0,
                    currency = "PKR",
                    reversalReason = null,
                    settlementReference = null,
                    settledAt = null,
                    createdAt = null,
                ),
            ),
            totalEntries = 1,
            settlements = emptyList(),
            cash = null,
        )

        val csv = statement.toPartnerStatementCsv()
        assertTrue(csv.contains("'=HYPERLINK(\"\"x\"\")"))
        assertTrue(csv.contains("\"SELLER, TIER\""))
    }
}
