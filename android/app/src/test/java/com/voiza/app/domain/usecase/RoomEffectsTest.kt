package com.voiza.app.domain.usecase

import com.voiza.app.domain.model.ChatMessage
import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.domain.model.GiftEffectKind
import com.voiza.app.domain.model.MessageType
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

    @Test
    fun `a chat line already on screen is not appended twice`() {
        val entry = ChatMessage(id = "m1", user = null, content = "ana entered the room", type = MessageType.SYSTEM, createdAt = "2026-01-01T00:00:00Z")
        val hello = ChatMessage(id = "m2", user = null, content = "hi", type = MessageType.TEXT, createdAt = "2026-01-01T00:00:01Z")

        // The join path: history snapshot brings the entry notice, then the socket delivers it.
        val afterSnapshot = RoomEffects.appendChat(emptyList(), entry, limit = 50)
        val afterSocket = RoomEffects.appendChat(afterSnapshot, entry, limit = 50)

        // The list is keyed by id, so a second copy would crash the room rather than look odd.
        assertEquals(listOf(entry), afterSocket)
        assertEquals(1, afterSocket.count { it.id == "m1" })

        assertEquals(2, RoomEffects.appendChat(afterSocket, hello, limit = 50).size)
    }

    @Test
    fun `the chat window keeps the newest lines when it overflows`() {
        val lines = (1..5).map { ChatMessage(id = "m$it", user = null, content = "c$it", type = MessageType.TEXT, createdAt = "") }
        val sixth = ChatMessage(id = "m6", user = null, content = "c6", type = MessageType.TEXT, createdAt = "")

        val kept = RoomEffects.appendChat(lines, sixth, limit = 3)

        assertEquals(listOf("m4", "m5", "m6"), kept.map { it.id })
    }
}
