package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.CheckInResponseDto
import com.voiza.app.data.remote.dto.QuestsTodayDto
import com.voiza.app.domain.model.CheckInResult
import com.voiza.app.domain.model.QuestsToday
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The quests wire shapes, built with Gson exactly like the Retrofit converter does. Gson constructs
 * a data class without running its default initialisers, so a key the backend omits lands as null;
 * these cases are the ones the server really sends.
 */
class QuestMappersTest {

    private val gson = Gson()

    private val todayJson = """
        {
          "date": "2026-10-30",
          "resetTimezone": "UTC",
          "completedCount": 1,
          "xpEarnedToday": 35,
          "quests": [
            {"key":"gift-1","title":"Send a Gift","description":"Send any gift.","metric":"GIFT_SENT",
             "target":1,"progress":1,"xpReward":20,"completed":true,
             "completedAt":"2026-10-30T10:00:00.000Z","xpAwarded":20},
            {"key":"spend-50","title":"Share the Love","description":"Spend 50 diamonds.","metric":"DIAMONDS_SPENT",
             "target":50,"progress":2,"xpReward":30,"completed":false,"completedAt":null,"xpAwarded":0}
          ],
          "checkIn": {"available":false,"done":true,"streakDay":3,"xpAwardedToday":20,
                      "nextRewardXp":25,"nextStreakDay":4,"baseXp":10,"streakStepXp":5,"maxStreakDays":7}
        }
    """.trimIndent()

    @Test
    fun `a full status maps every server figure without deriving any of them`() {
        val today: QuestsToday = gson.fromJson(todayJson, QuestsTodayDto::class.java).toDomain()

        assertEquals("2026-10-30", today.date)
        assertEquals("UTC", today.resetTimezone)
        assertEquals(2, today.quests.size)
        assertEquals(1, today.completedCount)
        assertEquals(35, today.xpEarnedToday)
        assertFalse(today.allDone)

        val gift = today.quests[0]
        assertEquals("gift-1", gift.key)
        assertEquals("GIFT_SENT", gift.metric)
        assertTrue(gift.completed)
        assertEquals(20, gift.xpAwarded)
        assertEquals(1f, gift.fraction)
        assertEquals(0, gift.remaining)

        val spend = today.quests[1]
        assertEquals(2, spend.progress)
        assertEquals(50, spend.target)
        assertEquals(0.04f, spend.fraction)
        assertEquals(48, spend.remaining)
        assertEquals("2 / 50", spend.progressLabel)

        val checkIn = today.checkIn!!
        assertFalse(checkIn.available)
        assertTrue(checkIn.done)
        assertEquals(3, checkIn.streakDay)
        assertEquals(20, checkIn.xpAwardedToday)
        assertEquals(25, checkIn.nextRewardXp)
        assertEquals(4, checkIn.nextStreakDay)
        assertEquals(7, checkIn.maxStreakDays)
        assertEquals(3, checkIn.litDays)
    }

    @Test
    fun `an absent quest list and check-in become empty and null, not a crash`() {
        val today = gson
            .fromJson("""{"date":"2026-10-30","resetTimezone":"UTC"}""", QuestsTodayDto::class.java)
            .toDomain()

        assertTrue(today.quests.isEmpty())
        assertNull(today.checkIn)
        assertEquals(0, today.completedCount)
        // An empty day is not "all done" — that would hide the empty-state sentence.
        assertFalse(today.allDone)
    }

    @Test
    fun `a progress count past the target never draws a bar longer than full`() {
        val today = gson.fromJson(todayJson, QuestsTodayDto::class.java).toDomain()
        val over = today.quests[1].copy(progress = 60)

        assertEquals(1f, over.fraction)
        assertEquals(0, over.remaining)
        assertEquals("50 / 50", over.progressLabel)
    }

    @Test
    fun `a zero target leaves the bar empty instead of dividing by zero`() {
        val today = gson.fromJson(todayJson, QuestsTodayDto::class.java).toDomain()
        assertEquals(0f, today.quests[0].copy(target = 0).fraction)
    }

    @Test
    fun `the check-in response carries the reward, the refreshed status and the account`() {
        val json = """
            {
              "xpAwarded": 15,
              "status": $todayJson,
              "user": {"id":"u1","phone":"+15550000001","username":"alice","xp":415,"rank":null}
            }
        """.trimIndent()

        val result: CheckInResult = gson.fromJson(json, CheckInResponseDto::class.java).toDomain()

        assertEquals(15, result.xpAwarded)
        val status = result.status!!
        assertEquals("2026-10-30", status.date)
        assertEquals(1, status.completedCount)
    }
}
