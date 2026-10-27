package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.GameCatalogResponse
import com.voiza.app.data.remote.dto.GameHistoryResponse
import com.voiza.app.data.remote.dto.GameSessionDto
import com.voiza.app.domain.model.GameBoard
import com.voiza.app.domain.model.GamePhase
import com.voiza.app.domain.model.GameParticipantStatus
import com.voiza.app.domain.model.LudoBoard
import com.voiza.app.domain.model.LUDO_HOME
import com.voiza.app.domain.model.QuizBoard
import com.voiza.app.domain.model.TicTacToeBoard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every JSON literal below is copied from a live capture of this backend
 * (`backend/scripts/capture-game-wire.cjs` -> `android/scripts/fixtures/wire-games.json`), not
 * written from what the client would prefer. Gson builds the DTOs the same way the Retrofit
 * converter and the socket parser do, so a key the server really sends as `null` is exercised
 * here as `null` too.
 */
class GameMappersTest {

    private val gson = Gson()

    private val hostId = "b98aa74c-d8d4-4471-9be9-21d2714b749b"
    private val guestId = "4a0339de-ec81-46f3-9ad7-7d5974c32241"

    private val hostParticipant =
        """{"userId":"$hostId","username":"wire_h_6276_1","avatarUrl":null,"position":0,"status":"PLAYING",""" +
            """"score":0,"rank":null,"entryFeeDiamonds":0,"prizeDiamonds":0,"ready":true}"""

    private val guestParticipant =
        """{"userId":"$guestId","username":"wire_g_6276_2","avatarUrl":null,"position":1,"status":"PLAYING",""" +
            """"score":150,"rank":null,"entryFeeDiamonds":0,"prizeDiamonds":0,"ready":true}"""

    /** The session envelope `toGameSession` always writes; only the parts under test vary. */
    private fun sessionJson(
        gameKey: String,
        state: String,
        status: String = "IN_PROGRESS",
        result: String? = null,
        phase: String? = null,
        settlement: String? = null,
        participants: String = "$hostParticipant,$guestParticipant",
    ) = """{"id":"6bc5e5e8-09dc-450a-9a08-8b9b8aca5a27","gameKey":"$gameKey","roomId":"9a81f644-2656-415c-9d38-62dd947dfe6f",""" +
        """"createdBy":"$hostId","status":"$status","settlementStatus":"${if (result == null) "PENDING" else "SETTLED"}",""" +
        """"rulesVersion":22,"state":$state,"entryFeeDiamonds":0,"maxPlayers":2,"turnOwnerId":"$guestId",""" +
        """"turnDeadlineAt":"2026-10-23T09:26:06.736Z","result":${result ?: "null"},""" +
        """"startedAt":"2026-10-23T09:25:36.819Z","endedAt":null,"createdAt":"2026-10-23T09:25:36.819Z",""" +
        """"participants":[$participants]""" +
        (if (phase == null) "" else ""","phase":"$phase"""") +
        (if (settlement == null) "" else ""","settlement":$settlement""") +
        "}"

    private val ticTacToeState =
        """{"draw":false,"grid":[0,null,null,1,null,null,null,null,null],"winLine":null,"moveCount":2,""" +
            """"turnPosition":0,"winnerPosition":null,"timeoutPosition":null}"""

    private val ludoState =
        """{"order":[0,1],"players":{"0":{"pieces":[-1,-1,-1,-1],"position":0,"piecesHome":0,"pendingRoll":null},""" +
            """"1":{"pieces":[-1,-1,-1,-1],"position":1,"piecesHome":0,"pendingRoll":3}},"finished":false,""" +
            """"rollCount":1,"startRoll":6,"turnPosition":1,"winnerPosition":null}"""

    private val quizState =
        """{"index":1,"answers":{"$guestId":{"0":{"points":150,"correct":true,"latencyMs":15,"optionIndex":2}},""" +
            """"$hostId":{"0":{"points":0,"correct":false,"latencyMs":8,"optionIndex":1}}},"finished":false,""" +
            """"questions":[{"id":1,"prompt":"Which ocean is the deepest?","options":["Indian","Atlantic","Pacific","Arctic"]},""" +
            """{"id":2,"prompt":"How many continents are there?","options":["8","5","6","7"]}],""" +
            """"correctPoints":100,"maxSpeedBonus":50,"roundStartedAtMs":1792747536802,"secondsPerQuestion":15}"""

    @Test
    fun `the captured tic tac toe board reads seats, turn and an absent win line`() {
        val session = gson.fromJson(sessionJson("TIC_TAC_TOE", ticTacToeState), GameSessionDto::class.java).toDomain()

        val board = session.board as TicTacToeBoard
        assertEquals(listOf(0, null, null, 1, null, null, null, null, null), board.grid)
        assertEquals(0, board.turnPosition)
        assertEquals(2, board.moveCount)
        // The server sends `winLine: null` until someone wins, not an empty array.
        assertTrue(board.winLine.isEmpty())
        assertNull(board.winnerPosition)
        assertFalse(board.isOver)
        assertEquals(GameParticipantStatus.PLAYING, session.participants.first().status)
    }

    @Test
    fun `a phase the client has never seen is unknown rather than a guess`() {
        // The emit uses lowercase tags; `waiting` and `lobby` are the same desk.
        assertEquals(GamePhase.LOBBY, phaseOf("waiting"))
        assertEquals(GamePhase.LOBBY, phaseOf("lobby"))
        assertEquals(GamePhase.READY, phaseOf("ready"))
        assertEquals(GamePhase.PLAYING, phaseOf("playing"))
        assertEquals(GamePhase.FINISHED, phaseOf("finished"))
        assertEquals(GamePhase.CANCELLED, phaseOf("cancelled"))
        assertEquals(GamePhase.UNKNOWN, phaseOf("teleported"))
        // REST never sends the tag at all.
        assertEquals(GamePhase.UNKNOWN, phaseOf(null))
    }

    private fun phaseOf(phase: String?): GamePhase {
        val json = sessionJson("TIC_TAC_TOE", ticTacToeState).let { base ->
            if (phase == null) base else base.removeSuffix("}") + ""","phase":"$phase"""" + "}"
        }
        return gson.fromJson(json, GameSessionDto::class.java).toDomain().phase
    }

    @Test
    fun `the captured quiz board keeps each seat's answer off the question paper`() {
        val session = gson.fromJson(sessionJson("QUIZ_BATTLE", quizState), GameSessionDto::class.java).toDomain()

        val board = session.board as QuizBoard
        assertEquals(1, board.index)
        assertEquals("How many continents are there?", board.liveQuestion?.prompt)
        assertEquals(4, board.questions.first().options.size)
        assertEquals(15, board.secondsPerQuestion)
        assertTrue(board.hasAnswered(hostId))
        assertEquals(150, board.answerOf(guestId, 0)?.points)
        assertTrue(board.answerOf(guestId, 0)!!.correct)
        // Round 1 is the live question and nobody has committed to it yet.
        assertNull(board.answerOf(guestId, 1))
    }

    @Test
    fun `the captured ludo board reads the yard and a die waiting to be spent`() {
        val session = gson.fromJson(sessionJson("LUDO", ludoState), GameSessionDto::class.java).toDomain()

        val board = session.board as LudoBoard
        val guestSeat = board.seat(1)!!
        assertEquals(6, board.startRoll)
        assertEquals(1, board.turnPosition)
        assertNull(board.seat(0)?.pendingRoll)
        assertEquals(3, guestSeat.pendingRoll)
        // Every token is still in the yard, and a 3 cannot open a lane that needs a 6.
        assertEquals(4, guestSeat.total)
        assertTrue(guestSeat.legalPieces(roll = 3, startRoll = 6, home = LUDO_HOME).isEmpty())
        assertEquals(listOf(0, 1, 2, 3), guestSeat.legalPieces(roll = 6, startRoll = 6, home = LUDO_HOME))
    }

    @Test
    fun `a stored result fills in the settlement a rest read cannot carry`() {
        val result = """{"grossPool":600,"commission":60,"prizePool":540,"deductions":0,"distributed":540,"rulesVersion":22}"""
        val paid = sessionJson(
            gameKey = "TIC_TAC_TOE",
            state = ticTacToeState,
            status = "COMPLETED",
            result = result,
            participants = """{"userId":"$hostId","username":"host","avatarUrl":null,"position":0,"status":"COMPLETED",""" +
                """"score":1,"rank":1,"entryFeeDiamonds":300,"prizeDiamonds":540,"ready":true},$guestParticipant""",
        )

        val settlement = gson.fromJson(paid, GameSessionDto::class.java).toDomain().settlement
        assertNotNull(settlement)
        assertEquals(600, settlement!!.grossPool)
        assertEquals(0, settlement.deductions)
        // The per-seat prize comes from the participant row the engine wrote, not from arithmetic
        // on the player's own balance.
        assertEquals(listOf(hostId), settlement.payouts.map { it.userId })
        assertEquals(540, settlement.payouts.first().diamonds)
        assertEquals(1, settlement.payouts.first().rank)
    }

    @Test
    fun `the emit's settlement is preferred over the stored result`() {
        val emit = """{"grossPool":600,"commission":60,"prizePool":540,"distributed":540,""" +
            """"payouts":[{"rank":1,"userId":"$guestId","diamonds":540}]}"""
        val stored = """{"grossPool":600,"commission":60,"prizePool":540,"deductions":0,"distributed":0,"rulesVersion":22}"""

        val session = gson.fromJson(
            sessionJson("TIC_TAC_TOE", ticTacToeState, status = "COMPLETED", result = stored, settlement = emit),
            GameSessionDto::class.java,
        ).toDomain()

        assertEquals(540, session.settlement?.distributed)
        assertEquals(listOf(guestId), session.settlement?.payouts?.map { it.userId })
    }

    @Test
    fun `a game this build cannot draw stays unsupported instead of blank`() {
        val session = gson.fromJson(
            sessionJson("SNAKES_AND_LADDERS", """{"anything":true}"""),
            GameSessionDto::class.java,
        ).toDomain()

        assertEquals(GameBoard.Unsupported("SNAKES_AND_LADDERS"), session.board)
    }

    @Test
    fun `no board exists before the match starts`() {
        val session = gson.fromJson(
            sessionJson("TIC_TAC_TOE", "null", status = "WAITING"),
            GameSessionDto::class.java,
        ).toDomain()

        assertEquals(GameBoard.NotStarted, session.board)
    }

    @Test
    fun `the turn deadline is read as an instant and a missing one as none`() {
        val session = gson.fromJson(sessionJson("TIC_TAC_TOE", ticTacToeState), GameSessionDto::class.java).toDomain()
        // 2026-01-01T00:00:00Z is 1767225600000 ms, so the captured October deadline is after it.
        assertTrue(session.turnDeadlineAtMs!! > 1_767_225_600_000L)
        assertEquals(1_767_225_600_000L, isoToEpochMs("2026-01-01T00:00:00.000Z"))
        assertEquals(1_767_225_600_000L, isoToEpochMs("2026-01-01T00:00:00Z"))
        assertNull(isoToEpochMs(null))
        assertNull(isoToEpochMs("not a timestamp"))
    }

    @Test
    fun `the room desk reads both halves of the catalog it asks for`() {
        val response = gson.fromJson(
            """{"sessions":[${sessionJson("TIC_TAC_TOE", ticTacToeState)}],"games":[
                {"key":"TIC_TAC_TOE","name":"Tic Tac Toe","description":null,"minPlayers":2,"maxPlayers":2,
                 "turnTimeoutSeconds":30,"entryFeeEnabled":false,"entryFeeDiamonds":0,"prizeEnabled":false,
                 "commissionBps":0,"dailyEntryLimit":50,"rulesVersion":22,"isActive":true}]}""",
            GameCatalogResponse::class.java,
        )
        val games = response.games.map { it.toDomain() }
        val sessions = response.sessions.orEmpty().map { it.toDomain() }

        assertEquals(1, games.size)
        assertEquals("2 players", games.first().playerRange)
        assertEquals(0, games.first().fee)
        assertEquals(1, sessions.size)
        assertEquals("6bc5e5e8-09dc-450a-9a08-8b9b8aca5a27", sessions.first().id)
    }

    @Test
    fun `history rows carry the server's own fee and prize`() {
        val response = gson.fromJson(
            """{"games":[{"sessionId":"d74a4a8b","gameKey":"LUDO","status":"IN_PROGRESS","rank":null,"score":0,""" +
                """"prizeDiamonds":0,"entryFeeDiamonds":0,"endedAt":null,"createdAt":"2026-10-23T09:25:36.819Z"}]}""",
            GameHistoryResponse::class.java,
        )
        val rows = response.games.map { it.toDomain() }

        assertEquals(0, rows.first().netDiamonds)
        assertNull(rows.first().endedAt)
    }
}
