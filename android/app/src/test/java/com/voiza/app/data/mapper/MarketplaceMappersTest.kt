package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.MarketplaceOrderDto
import com.voiza.app.data.remote.dto.MarketplaceSellerDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The marketplace catalogue is an allowlist and every money figure is the server's. A row missing an
 * id, key or price is dropped rather than drawn with a made-up rate or status.
 */
class MarketplaceMappersTest {

    private val gson = Gson()

    @Test
    fun `a seller keeps only the fields a buyer may see, with server-owned prices`() {
        val seller = gson.fromJson(
            """{"id":"s1","code":"SELLER1","displayName":"Speed Pay","marketCountry":"PK",
                "paymentRails":["BANK","WALLET"],
                "packages":[{"key":"p1","label":"Starter","diamonds":100,"amountCents":199,
                    "currency":"usd","unitPriceCents":1}]}""",
            MarketplaceSellerDto::class.java,
        ).toDomainOrNull()

        assertNotNull(seller)
        assertEquals("SELLER1", seller!!.code)
        assertEquals(199, seller.packages.single().amountCents)
        assertEquals("$1.99", seller.packages.single().priceLabel())
        assertEquals(listOf("BANK", "WALLET"), seller.paymentRails)
    }

    @Test
    fun `a package with no key or price is dropped rather than offered for free`() {
        val seller = gson.fromJson(
            """{"id":"s1","code":"SELLER1","displayName":"Speed Pay",
                "packages":[{"label":"Mystery","diamonds":500},
                    {"key":"p2","label":"No price","diamonds":500}]}""",
            MarketplaceSellerDto::class.java,
        ).toDomainOrNull()

        assertNotNull(seller)
        assertTrue("malformed packages must not reach the buyer", seller!!.packages.isEmpty())
    }

    @Test
    fun `an order status and amount are the server's, never inferred on the device`() {
        val order = gson.fromJson(
            """{"id":"o1","reference":"RC-1","status":"AWAITING_PAYMENT","sellerId":"s1",
                "sellerName":"Speed Pay","diamonds":100,"amountCents":199,"currency":"usd",
                "paymentMethod":"BANK","createdAt":"2026-11-20T00:00:00.000Z"}""",
            MarketplaceOrderDto::class.java,
        ).toDomainOrNull()

        assertNotNull(order)
        assertEquals("AWAITING_PAYMENT", order!!.status)
        assertEquals(199, order.amountCents)
        assertEquals("BANK", order.paymentMethod)
    }

    @Test
    fun `a seller or order without an id is rejected`() {
        val seller = gson.fromJson("""{"code":"X","displayName":"X"}""", MarketplaceSellerDto::class.java)
        val order = gson.fromJson("""{"reference":"X"}""", MarketplaceOrderDto::class.java)
        assertNull(seller.toDomainOrNull())
        assertNull(order.toDomainOrNull())
    }
}
