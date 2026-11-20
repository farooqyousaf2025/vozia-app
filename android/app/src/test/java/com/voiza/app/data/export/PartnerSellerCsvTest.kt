package com.voiza.app.data.export

import com.voiza.app.domain.model.PartnerAccountStatus
import com.voiza.app.domain.model.PartnerSellerRow
import com.voiza.app.domain.model.RechargeStats
import org.junit.Assert.assertTrue
import org.junit.Test

class PartnerSellerCsvTest {
    @Test
    fun `exports only seller territory summary fields`() {
        val csv = listOf(
            PartnerSellerRow(
                id = "internal-id",
                code = "SELL-001",
                displayName = "North Seller",
                status = PartnerAccountStatus.ACTIVE,
                statusLabel = "Active",
                marketCountry = "Pakistan",
                recharge = RechargeStats(
                    orders = 12,
                    credited = 9,
                    awaitingVerification = 2,
                    failed = 1,
                    reversed = 0,
                    processedDiamonds = 45000,
                    collectedMinor = 900000,
                    netCollectedMinor = 875000,
                ),
            ),
        ).toPartnerSellerCsv()

        assertTrue(csv.startsWith("\uFEFFseller_code,seller_name,status,market_country"))
        assertTrue(csv.contains("SELL-001,North Seller,Active,Pakistan,12,9,2,1,0,45000"))
        assertTrue(!csv.contains("internal-id"))
        assertTrue(!csv.contains("900000"))
    }

    @Test
    fun `quotes text and neutralizes spreadsheet formulas`() {
        val csv = listOf(
            PartnerSellerRow(
                id = "id",
                code = "=IMPORTXML(\"x\")",
                displayName = "Seller, \"One\"",
                status = null,
                statusLabel = "Active",
                marketCountry = "Pakistan",
                recharge = RechargeStats(0, 0, 0, 0, 0, 0, 0, 0),
            ),
        ).toPartnerSellerCsv()

        assertTrue(csv.contains("'=IMPORTXML(\"\"x\"\")"))
        assertTrue(csv.contains("\"Seller, \"\"One\"\"\""))
    }
}
