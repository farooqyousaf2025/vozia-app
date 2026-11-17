package com.voiza.app.domain.usecase

import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.RankingLeader
import com.voiza.app.domain.model.RankingSelf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The rankings screen's display math: podium order, the self-row cap, units and compact scores. */
class LeaderboardEffectsTest {

    private fun leader(position: Int, earned: Long = 100L) = RankingLeader(
        position = position,
        user = MiniUser(id = "u$position", username = "member$position", avatarUrl = null),
        earned = earned,
    )

    @Test
    fun `podium puts second left, first centre, third right`() {
        val slots = podiumSlots(listOf(leader(1), leader(2), leader(3), leader(4)))
        assertEquals(3, slots.size)
        assertEquals(2, slots[0]?.position)
        assertEquals(1, slots[1]?.position)
        assertEquals(3, slots[2]?.position)
    }

    @Test
    fun `podium keeps empty pedestals null on a short board`() {
        val one = podiumSlots(listOf(leader(1)))
        assertNull(one[0])
        assertEquals(1, one[1]?.position)
        assertNull(one[2])

        val two = podiumSlots(listOf(leader(1), leader(2)))
        assertEquals(2, two[0]?.position)
        assertEquals(1, two[1]?.position)
        assertNull(two[2])

        val none = podiumSlots(emptyList())
        assertEquals(listOf(null, null, null), none)
    }

    @Test
    fun `self place label reads the server's place, capped at the board limit`() {
        assertEquals("", selfPlaceLabel(null))
        assertEquals("50+", selfPlaceLabel(RankingSelf(position = null, earned = 0)))
        assertEquals("1", selfPlaceLabel(RankingSelf(position = 1, earned = 900)))
        assertEquals("50", selfPlaceLabel(RankingSelf(position = 50, earned = 10)))
        assertEquals("50+", selfPlaceLabel(RankingSelf(position = 51, earned = 10)))
        assertEquals("5+", selfPlaceLabel(RankingSelf(position = 9, earned = 1), limit = 5))
    }

    @Test
    fun `unit label names what the board counts`() {
        assertEquals("coins", rankingUnitLabel("r_coin"))
        assertEquals("diamonds", rankingUnitLabel("diamond"))
        assertEquals("diamonds", rankingUnitLabel("anything-else"))
    }

    @Test
    fun `compact score keeps small scores whole and abbreviates the big ones`() {
        assertEquals("0", compactScore(0))
        assertEquals("9999", compactScore(9_999))
        assertEquals("10K", compactScore(10_000))
        assertEquals("12.3K", compactScore(12_345))
        assertEquals("999.9K", compactScore(999_949))
        assertEquals("1M", compactScore(1_000_000))
        assertEquals("1.23M", compactScore(1_234_567))
        assertEquals("3.86M", compactScore(3_856_010))
    }
}