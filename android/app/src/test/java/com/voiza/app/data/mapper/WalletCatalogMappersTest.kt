package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.CheckoutResponse
import com.voiza.app.data.remote.dto.DiamondPackageDto
import com.voiza.app.data.remote.dto.FirstRechargeDto
import com.voiza.app.data.remote.dto.WalletResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Money figures and the first-recharge gate are the server's answers. These tests pin that the
 * mapper copies them rather than recomputing a bonus or deciding an account is unlocked.
 */
class WalletCatalogMappersTest {

    private val gson = Gson()

    @Test
    fun `a package quotes the total the server sent, not a sum made on the device`() {
        val pack = gson.fromJson(
            """{"id":"p1","code":"small","name":"Starter","diamonds":100,"bonusDiamonds":20,
                "totalDiamonds":150,"priceCents":199,"currency":"usd","sortOrder":1}""",
            DiamondPackageDto::class.java,
        ).toDomainOrNull()

        assertNotNull(pack)
        assertEquals(150, pack!!.totalDiamonds)
        assertEquals(199, pack.priceCents)
        assertEquals("$1.99", pack.priceLabel())
    }

    @Test
    fun `a pack without a price or an id is dropped rather than shown as a free top-up`() {
        val noPrice = gson.fromJson(
            """{"id":"p2","code":"mystery","name":"Mystery","diamonds":500,"totalDiamonds":500}""",
            DiamondPackageDto::class.java,
        )
        assertNull(noPrice.toDomainOrNull())
    }

    @Test
    fun `the gate is read from the server's completed count`() {
        val done = gson.fromJson(
            """{"required":false,"completed":true,"completedAt":"2026-11-01T00:00:00.000Z","count":3}""",
            FirstRechargeDto::class.java,
        ).toDomain()
        assertTrue(done.completed)
        assertFalse(done.required)
        assertEquals(3, done.count)

        // Gson leaves absent keys null; a backend that predates the gate must not look unlocked.
        val absent = gson.fromJson("""{}""", FirstRechargeDto::class.java).toDomain()
        assertFalse(absent.completed)
        assertTrue(absent.required)
        assertEquals(0, absent.count)
    }

    @Test
    fun `an incomplete payment intent cannot reach a card sheet`() {
        val incomplete = gson.fromJson(
            """{"paymentIntentId":"pi_1","amountCents":199,"amountDiamonds":150}""",
            CheckoutResponse::class.java,
        )
        assertNull(incomplete.toDomainOrNull())

        val complete = gson.fromJson(
            """{"paymentIntentId":"pi_1","clientSecret":"pi_1_secret","amountCents":199,
                "currency":"usd","amountDiamonds":150,"packageId":"p1",
                "publishableKeyHint":"pk_test_"}""",
            CheckoutResponse::class.java,
        ).toDomainOrNull()
        assertNotNull(complete)
        assertEquals("pi_1_secret", complete!!.clientSecret)
        assertEquals(150, complete.amountDiamonds)
        assertEquals("p1", complete.packageId)
    }

    @Test
    fun `the wallet envelope carries the gate into the snapshot`() {
        val wallet = gson.fromJson(
            """{"user":{"id":"u1","phone":"+1","username":"ana","diamondBalance":0,"rCoinBalance":0,
                        "totalGiftsSent":0,"totalGiftsReceived":0,
                        "userType":"USER","status":"ACTIVE","isVerified":false,"vipLevel":0},
                "transactions":[],"stats":{"diamondsSpent":0,"rCoinsEarned":0,"giftsSent":0},
                "firstRecharge":{"required":true,"completed":false,"completedAt":null,"count":0}}""",
            WalletResponse::class.java,
        ).toDomain()

        assertNotNull(wallet.firstRecharge)
        assertFalse(wallet.firstRecharge!!.completed)
        assertTrue(wallet.firstRecharge!!.required)
    }
}
