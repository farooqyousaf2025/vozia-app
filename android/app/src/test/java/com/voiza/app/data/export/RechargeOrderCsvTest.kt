package com.voiza.app.data.export

import com.voiza.app.domain.model.RechargeOrder
import com.voiza.app.domain.model.RechargeOrderStatus
import org.junit.Assert.assertTrue
import org.junit.Test

class RechargeOrderCsvTest {
    @Test
    fun `exports loaded order details with explicit minor currency units`() {
        val csv = listOf(
            RechargeOrder(
                id = "private-id",
                reference = "RCH-001",
                status = RechargeOrderStatus.AWAITING_VERIFICATION,
                statusLabel = "In review",
                sellerCode = "SELL-1",
                sellerName = "Seller",
                bdCode = "BD-1",
                username = "member_one",
                diamonds = 5000,
                amountMinor = 125000,
                feeMinor = 2500,
                currency = "PKR",
                paymentMethod = "BANK",
                paymentRef = "TXN-88",
                decisionNote = "Awaiting finance",
                reversalReason = null,
                expiresAt = null,
                verifiedAt = null,
                createdAt = "2026-11-21T08:00:00Z",
            ),
        ).toRechargeOrderCsv()

        assertTrue(csv.startsWith("\uFEFForder_reference,status,customer_username"))
        assertTrue(csv.contains("RCH-001,In review,member_one,5000,125000,2500,PKR,BANK,TXN-88"))
        assertTrue(csv.contains("Awaiting finance"))
        assertTrue(!csv.contains("private-id"))
        assertTrue(!csv.contains("SELL-1"))
        assertTrue(!csv.contains("BD-1"))
    }

    @Test
    fun `quotes fields and neutralizes spreadsheet formulas`() {
        val csv = listOf(
            RechargeOrder(
                id = "id", reference = "=HYPERLINK(\"x\")",
                status = null, statusLabel = "In review",
                sellerCode = "SELL", sellerName = "Seller", bdCode = "BD",
                username = "Member, \"One\"", diamonds = 0, amountMinor = 0, feeMinor = 0,
                currency = "PKR", paymentMethod = "BANK", paymentRef = null,
                decisionNote = null, reversalReason = null, expiresAt = null,
                verifiedAt = null, createdAt = null,
            ),
        ).toRechargeOrderCsv()

        assertTrue(csv.contains("'=HYPERLINK(\"\"x\"\")"))
        assertTrue(csv.contains("\"Member, \"\"One\"\"\""))
    }
}
