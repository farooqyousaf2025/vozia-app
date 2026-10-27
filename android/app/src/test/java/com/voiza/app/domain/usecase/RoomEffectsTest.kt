package com.voiza.app.domain.usecase

import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.domain.model.GiftEffectKind
import com.voiza.app.domain.model.MiniUser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The takeover line and the ticker are the two places where a busy room has to
 * decide what to drop. These are the decisions, without a device.
 */
class RoomEffectsTest {

    private fun user(id: String) = MiniUser(id = id, username = id, avatarUrl = null)

    private fun event(senderId: String, tier: GiftEffectKind = GiftEffectKind.FULLSCREEN) =
        GiftAnimatedEvent(
            roomId = "r1",
            gift = Gift(
                id = "g$senderId",
                name = "Gift",
                iconUrl = "/gifts/rose.png",
                animationUrl = null,
                diamondPrice = 10,
                rCoinValue = 9,
                category = "ROSE",
                effectKind = tier,
            ),
            sender = user(senderId),
            receiver = user("host"),
            quantity = 1,
            animationUrl = null,
            totalDiamonds = 10,
            totalRCoins = 9,
            seatIndex = null,
        )

    @Test
    fun `the takeover line holds three and no more`() {
        val full = (1..3).fold(emptyList<GiftAnimatedEvent>()) { acc, i ->
            RoomEffects.enqueueTakeover(acc, event("u$i"), myUserId = "me")
        }
        assertEquals(3, full.size)

        val overflow = RoomEffects.enqueueTakeover(full, event("u4"), myUserId = "me")
        assertEquals(3, overflow.size)
        assertEquals("u4", overflow.last().sender.id)
    }

    @Test
    fun `a full line drops the first gift that is not mine`() {
        val line = listOf(event("other"), event("me"), event("me"))
        val next = RoomEffects.enqueueTakeover(line, event("me"), myUserId = "me")

        assertEquals(listOf("me", "me", "me"), next.map { it.sender.id })
    }

    @Test
    fun `someone else's gift is dropped rather than pushing mine out of line`() {
        val mine = listOf(event("me"), event("me"), event("me"))
        val next = RoomEffects.enqueueTakeover(mine, event("other"), myUserId = "me")

        assertEquals(3, next.size)
        assertTrue(next.none { it.sender.id == "other" })
    }

    @Test
    fun `the ticker keeps the newest three rows`() {
        val rows = (1..6).fold(emptyList<GiftAnimatedEvent>()) { acc, i ->
            RoomEffects.appendTicker(acc, event("u$i", GiftEffectKind.TICKER))
        }

        assertEquals(listOf("u4", "u5", "u6"), rows.map { it.sender.id })
    }

    @Test
    fun `entry tiers split at the levels an operator can actually award`() {
        assertEquals(0, RoomEffects.entryTier(null))
        assertEquals(0, RoomEffects.entryTier(0))
        assertEquals(0, RoomEffects.entryTier(4))
        assertEquals(1, RoomEffects.entryTier(5))
        assertEquals(1, RoomEffects.entryTier(9))
        assertEquals(2, RoomEffects.entryTier(10))
        assertEquals(2, RoomEffects.entryTier(20))
    }

    @Test
    fun `a panel page is four tiles wide and two tall`() {
        assertEquals(8, RoomEffects.PANEL_PAGE_SIZE)
        assertEquals(RoomEffects.PANEL_COLUMNS * RoomEffects.PANEL_ROWS, RoomEffects.PANEL_PAGE_SIZE)
    }
}
