package com.voiza.app.viewmodel

import com.voiza.app.domain.model.StoreItem
import com.voiza.app.domain.model.StoreItemKind
import com.voiza.app.domain.model.User
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StoreBalanceTest {
    private val user = User(
        id = "", phone = "", username = "", avatarUrl = null, bio = null,
        gender = null, countryCode = null, diamondBalance = 0, promoDiamondBalance = 600,
        rCoinBalance = 0, totalGiftsSent = 0, totalGiftsReceived = 0,
        userType = "USER", status = "ACTIVE", isVerified = false,
    )
    private val item = StoreItem(
        kind = StoreItemKind.BUBBLE, key = "spark", name = "Spark", art = "", accent = null,
        priceDiamonds = 300, periodDays = 30, owned = false, expiresAt = null,
        equipped = false, minVipLevel = 0, recommended = false,
    )

    @Test fun `eligible bonus enables purchase without changing purchased balance`() {
        val state = StoreViewModel.StoreUiState(user = user, promoUsableFor = listOf("STORE"))
        assertEquals(600L, state.balance)
        assertEquals(600, state.eligibleBonus)
        assertTrue(state.canAfford(item))
        assertEquals(0L, state.shortfall(item))
        assertEquals(0, state.user!!.diamondBalance)
    }

    @Test fun `bonus cannot buy store items when policy excludes store`() {
        val state = StoreViewModel.StoreUiState(user = user, promoUsableFor = listOf("GIFT", "GAME"))
        assertEquals(0L, state.balance)
        assertFalse(state.canAfford(item))
        assertEquals(300L, state.shortfall(item))
    }

    @Test fun `missing policy does not assume bonus eligibility`() {
        val state = StoreViewModel.StoreUiState(user = user)
        assertEquals(0, state.eligibleBonus)
        assertFalse(state.canAfford(item))
    }

    @Test fun `purchased and eligible bonus jointly fund a purchase`() {
        val state = StoreViewModel.StoreUiState(
            user = user.copy(diamondBalance = 100, promoDiamondBalance = 200),
            promoUsableFor = listOf("STORE"),
        )
        assertEquals(300L, state.balance)
        assertTrue(state.canAfford(item))
        assertEquals(1L, state.shortfall(item.copy(priceDiamonds = 301)))
    }

    @Test fun `fresh server balance removes spent or expired bonus from affordability`() {
        val state = StoreViewModel.StoreUiState(user = user, promoUsableFor = listOf("STORE"))
        val refreshed = state.copy(user = user.copy(promoDiamondBalance = 0))
        assertFalse(refreshed.canAfford(item))
        assertEquals(300L, refreshed.shortfall(item))
    }

    @Test fun `combined pockets do not overflow integer range`() {
        val state = StoreViewModel.StoreUiState(
            user = user.copy(diamondBalance = Int.MAX_VALUE, promoDiamondBalance = Int.MAX_VALUE),
            promoUsableFor = listOf("STORE"),
        )
        assertEquals(4_294_967_294L, state.balance)
        assertTrue(state.canAfford(item))
    }
}
