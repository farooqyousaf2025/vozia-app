package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.PkBattleDto
import com.voiza.app.data.remote.dto.PkSettingsDto
import com.voiza.app.domain.model.PkBattle
import com.voiza.app.domain.model.PkSide
import com.voiza.app.domain.model.PkStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * PK wire shapes, built with Gson exactly like the Retrofit converter does. The server sends the
 * score as its own ledger sum and freezes it at settlement; these cases pin that the phone copies
 * every figure and never invents one when a key is missing.
 */
class PkMappersTest {

    private val gson = Gson()

    private val activeJson = """
        {
          "id": "b1",
          "status": "ACTIVE",
          "roomA": {"id":"ra","title":"Nights","coverUrl":null,"hostId":"ha","hostUsername":"alice"},
          "roomB": {"id":"rb","title":"Dawn","coverUrl":"/c.png","hostId":"hb","hostUsername":"bob"},
          "durationSeconds": 120,
          "scores": {"a": 300, "b": 100},
          "unit": "diamond",
          "invitedAt": "2026-10-30T10:00:00.000Z",
          "inviteExpiresAt": "2026-10-30T10:00:10.000Z",
          "startedAt": "2026-10-30T10:00:12.000Z",
          "endsAt": "2026-10-30T10:02:12.000Z",
          "finishedAt": null,
          "remainingMs": 90000,
          "winnerRoomId": null,
          "bonusXp": 0,
          "bonusUserId": null,
          "stopped": false
        }
    """.trimIndent()

    @Test
    fun `a running battle maps every server figure and resolves its sides`() {
        val battle = requireNotNull(gson.fromJson(activeJson, PkBattleDto::class.java).toDomain())

        assertEquals("b1", battle.id)
        assertEquals(PkStatus.ACTIVE, battle.status)
        assertTrue(battle.isActive)
        assertFalse(battle.isInvited)
        assertEquals("Nights", battle.roomA.title)
        assertEquals("bob", battle.roomB.hostUsername)
        assertEquals(120, battle.durationSeconds)
        assertEquals(300, battle.scoreA)
        assertEquals(100, battle.scoreB)
        assertEquals(400, battle.total)
        assertEquals(0.75f, battle.fractionA)
        assertEquals(PkSide.A, battle.sideOf("ra"))
        assertEquals(PkSide.B, battle.sideOf("rb"))
        assertNull(battle.sideOf("elsewhere"))
        assertEquals("Dawn", battle.opponentOf("ra")?.title)
        assertEquals("Nights", battle.opponentOf("rb")?.title)
    }

    @Test
    fun `the clock is read against the server's deadline, not the phone's arrival order`() {
        val battle = requireNotNull(gson.fromJson(activeJson, PkBattleDto::class.java).toDomain())
        val endsAt = requireNotNull(battle.endsAtMs)

        assertEquals(30_000, battle.remainingAt(endsAt - 30_000))
        assertEquals(0, battle.remainingAt(endsAt + 5_000))
        assertEquals("00:30", battle.clockLabel(battle.remainingAt(endsAt - 30_000)))
        assertEquals("02:35", battle.clockLabel(155_000))
        assertEquals("00:00", battle.clockLabel(-1))
    }

    @Test
    fun `a settled battle knows its winner, or says it was a draw`() {
        val won = requireNotNull(
            gson.fromJson(
                activeJson.replace("\"status\": \"ACTIVE\"", "\"status\": \"FINISHED\"")
                    .replace("\"winnerRoomId\": null", "\"winnerRoomId\": \"rb\"")
                    .replace("\"bonusXp\": 0", "\"bonusXp\": 45")
                    .replace("\"bonusUserId\": null", "\"bonusUserId\": \"u9\""),
                PkBattleDto::class.java,
            ).toDomain(),
        )

        assertTrue(won.isFinished)
        assertFalse(won.isDraw)
        assertEquals("Dawn", won.winnerRoom?.title)
        assertEquals(45, won.bonusXp)
        assertEquals("u9", won.bonusUserId)
        assertEquals(0, won.remainingAt(won.endsAtMs ?: 0))

        val drawn = won.copy(winnerRoomId = null, bonusXp = 0, bonusUserId = null)
        assertTrue(drawn.isDraw)
        assertNull(drawn.winnerRoom)
    }

    @Test
    fun `an invitation counts down its own expiry and is not live`() {
        val invited = requireNotNull(
            gson.fromJson(
                activeJson.replace("\"status\": \"ACTIVE\"", "\"status\": \"INVITED\"")
                    .replace("\"scores\": {\"a\": 300, \"b\": 100}", "\"scores\": {\"a\": 0, \"b\": 0}"),
                PkBattleDto::class.java,
            ).toDomain(),
        )

        assertTrue(invited.isInvited)
        assertFalse(invited.isActive)
        val expires = requireNotNull(invited.inviteExpiresAtMs)
        assertEquals(4_000, invited.inviteRemainingAt(expires - 4_000))
        assertEquals(0, invited.inviteRemainingAt(expires + 1))
        assertEquals(0, invited.remainingAt(System.currentTimeMillis()))
    }

    @Test
    fun `an unknown status is never drawn as a live race`() {
        val battle = requireNotNull(
            gson.fromJson(
                activeJson.replace("\"status\": \"ACTIVE\"", "\"status\": \"PAUSED\""),
                PkBattleDto::class.java,
            ).toDomain(),
        )

        assertEquals(PkStatus.UNKNOWN, battle.status)
        assertFalse(battle.isActive)
        assertFalse(battle.isInvited)
        assertFalse(battle.isFinished)
        assertEquals(0, battle.remainingAt(System.currentTimeMillis()))
    }

    @Test
    fun `a battle without an id or a room cannot be shown and maps to null`() {
        assertNull(gson.fromJson("""{"status":"ACTIVE","roomA":{"id":"ra","title":"A","hostId":"h","hostUsername":"h"}}""", PkBattleDto::class.java).toDomain())
        assertNull(gson.fromJson("""{"status":"ACTIVE","roomB":{"id":"rb","title":"B","hostId":"h","hostUsername":"h"}}""", PkBattleDto::class.java).toDomain())
        assertNull(gson.fromJson("""{"id":"b1","status":"ACTIVE","roomA":{"id":"ra","title":"A","hostId":"h","hostUsername":"h"},"roomB":null}""", PkBattleDto::class.java).toDomain())
    }

    @Test
    fun `missing scores read as zero, not as a made-up board`() {
        val battle: PkBattle = requireNotNull(
            gson.fromJson(
                """{"id":"b1","status":"ACTIVE",
                   "roomA":{"id":"ra","title":"A","hostId":"h","hostUsername":"h"},
                   "roomB":{"id":"rb","title":"B","hostId":"h","hostUsername":"h"}}""",
                PkBattleDto::class.java,
            ).toDomain(),
        )

        assertEquals(0, battle.scoreA)
        assertEquals(0, battle.scoreB)
        assertEquals(0, battle.total)
        assertEquals(0.5f, battle.fractionA)
    }

    @Test
    fun `the settings offer only durations the operator's range accepts`() {
        val settings = gson.fromJson(
            """{"isEnabled":true,"inviteTimeoutSeconds":30,"minDurationSeconds":10,
                "defaultDurationSeconds":10,"maxDurationSeconds":900,"winnerBonusXp":40}""",
            PkSettingsDto::class.java,
        ).toDomain()

        assertTrue(settings.isEnabled)
        assertEquals(30, settings.inviteTimeoutSeconds)
        assertEquals(40, settings.winnerBonusXp)
        assertEquals(listOf(10, 60, 120, 180, 300, 600, 900), settings.durationChoices())

        val narrow = settings.copy(minDurationSeconds = 100, defaultDurationSeconds = 150, maxDurationSeconds = 200)
        assertEquals(listOf(120, 150, 180), narrow.durationChoices())

        // A broken range must still offer the default the server itself would apply.
        val broken = settings.copy(minDurationSeconds = 900, defaultDurationSeconds = 10, maxDurationSeconds = 60)
        assertEquals(listOf(10), broken.durationChoices())
    }
}
