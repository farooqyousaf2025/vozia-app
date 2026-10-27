package com.voiza.app.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The client-side rules the screens lean on. Each one is a copy of a rule the engine already
 * enforces — a seat that reads these wrong gets its move rejected by the server, so these tests
 * are about not lying to the player, not about trusting the client.
 */
class GamesTest {

    private val hostId = "u-host"
    private val guestId = "u-guest"

    private fun player(
        id: String,
        position: Int,
        status: GameParticipantStatus = GameParticipantStatus.PLAYING,
        rank: Int? = null,
        score: Long = 0,
    ) = GameParticipant(
        userId = id,
        username = id,
        avatarUrl = null,
        position = position,
        status = status,
        score = score,
        rank = rank,
        entryFeeDiamonds = 0,
        prizeDiamonds = 0,
        ready = status == GameParticipantStatus.READY,
    )

    private fun sessionOf(
        status: GameStatus = GameStatus.IN_PROGRESS,
        createdBy: String = hostId,
        participants: List<GameParticipant> = listOf(player(hostId, 0), player(guestId, 1)),
        maxPlayers: Int = 2,
    ) = GameSession(
        id = "s1",
        gameKey = "TIC_TAC_TOE",
        roomId = "r1",
        createdBy = createdBy,
        status = status,
        settlementStatus = GameSettlementStatus.PENDING,
        rulesVersion = 1,
        board = GameBoard.NotStarted,
        entryFeeDiamonds = 0,
        maxPlayers = maxPlayers,
        turnOwnerId = null,
        turnDeadlineAtMs = null,
        startedAt = null,
        endedAt = null,
        createdAt = "2026-10-23T09:00:00.000Z",
        participants = participants,
        phase = GamePhase.PLAYING,
        settlement = null,
        refundedDiamonds = null,
    )

    @Test
    fun `a ludo seat may only open its lane with the start roll`() {
        val yard = LudoSeat(position = 0, pieces = listOf(-1, -1, -1, -1), pendingRoll = 6, piecesHome = 0)

        assertEquals(listOf(0, 1, 2, 3), yard.legalPieces(roll = 6, startRoll = 6, home = LUDO_HOME))
        assertTrue(yard.legalPieces(roll = 4, startRoll = 6, home = LUDO_HOME).isEmpty())
    }

    @Test
    fun `a ludo token cannot overshoot home but can land on it exactly`() {
        val seat = LudoSeat(
            position = 0,
            pieces = listOf(LUDO_HOME - 3, LUDO_HOME - 1, LUDO_HOME, -1),
            pendingRoll = 3,
            piecesHome = 1,
        )

        // 0 travels to HOME, 1 would pass it, 2 is already home, 3 is still in the yard.
        assertEquals(listOf(0), seat.legalPieces(roll = 3, startRoll = 6, home = LUDO_HOME))
        assertEquals(listOf(0, 1), seat.legalPieces(roll = 1, startRoll = 6, home = LUDO_HOME))
    }

    @Test
    fun `the home column is the last square a token can hold`() {
        assertEquals(LUDO_TRACK + LUDO_HOME_COLUMN - 1, LUDO_HOME)
        assertEquals(57, LUDO_HOME)
        assertTrue(LUDO_SAFE_CELLS.all { it in 0 until LUDO_TRACK })
    }

    @Test
    fun `standings put the winner first and an unranked seat last`() {
        val drawn = sessionOf(
            status = GameStatus.COMPLETED,
            participants = listOf(
                player(guestId, 1, GameParticipantStatus.COMPLETED, rank = null, score = 4),
                player(hostId, 0, GameParticipantStatus.COMPLETED, rank = null, score = 4),
            ),
        )
        // No ranks means nobody won, so seat order holds instead of a coin flip.
        assertEquals(listOf(hostId, guestId), drawn.standings.map { it.userId })

        val won = sessionOf(
            status = GameStatus.COMPLETED,
            participants = listOf(
                player(guestId, 1, GameParticipantStatus.COMPLETED, rank = null),
                player(hostId, 0, GameParticipantStatus.COMPLETED, rank = 1),
            ),
        )
        assertEquals(listOf(hostId, guestId), won.standings.map { it.userId })
    }

    @Test
    fun `joining is a waiting table with room and no seat taken already`() {
        val open = sessionOf(status = GameStatus.WAITING, participants = listOf(player(hostId, 0, GameParticipantStatus.JOINED)))
        assertTrue(open.canJoin(guestId))
        assertFalse("the creator already holds a seat", open.canJoin(hostId))
        assertFalse("a started match is not recruiting", sessionOf().canJoin(guestId))
        assertFalse(
            "a full table is full",
            sessionOf(
                status = GameStatus.WAITING,
                participants = listOf(
                    player(hostId, 0, GameParticipantStatus.JOINED),
                    player(guestId, 1, GameParticipantStatus.JOINED),
                ),
            ).canJoin("u-third"),
        )
        assertTrue(
            "a seat left behind can be taken again",
            sessionOf(
                status = GameStatus.WAITING,
                participants = listOf(player(hostId, 0, GameParticipantStatus.JOINED), player("u-gone", 1, GameParticipantStatus.LEFT)),
            ).canJoin("u-third"),
        )
    }

    @Test
    fun `only the opener starts or cancels a table`() {
        val ready = sessionOf(status = GameStatus.READY)
        assertTrue(ready.canStart(hostId))
        assertFalse("a player at the table cannot start it", ready.canStart(guestId))
        assertFalse("the desk must be full first", sessionOf(status = GameStatus.WAITING).canStart(hostId))

        assertTrue(ready.canCancel(hostId))
        assertFalse(ready.canCancel(guestId))
        assertFalse("a live match is not cancelled, it is lost", sessionOf().canCancel(hostId))
    }

    @Test
    fun `the clock reads whole seconds and never runs backwards`() {
        val deadline = 1_000_000L

        assertEquals(4, remainingSeconds(deadline, nowMs = 996_000L))
        assertEquals(0, remainingSeconds(deadline, nowMs = 1_004_000L))
        assertNull("a match with no mover has no clock", remainingSeconds(null, nowMs = 0L))
    }

    @Test
    fun `history nets the prize against the fee the server charged`() {
        fun row(prize: Int, fee: Int) = GameHistoryRow(
            sessionId = "s", gameKey = "TIC_TAC_TOE", status = GameStatus.COMPLETED, rank = 1,
            score = 1, prizeDiamonds = prize, entryFeeDiamonds = fee,
            endedAt = null, createdAt = "2026-10-23T09:00:00.000Z",
        )

        assertEquals(240, row(300, 60).netDiamonds)
        assertEquals(-60, row(0, 60).netDiamonds)
    }

    @Test
    fun `a disabled fee is a free table`() {
        fun definition(feeEnabled: Boolean, fee: Int, min: Int, max: Int) = GameDefinition(
            key = "TIC_TAC_TOE", name = "Tic Tac Toe", description = null,
            minPlayers = min, maxPlayers = max, turnTimeoutSeconds = 30,
            entryFeeEnabled = feeEnabled, entryFeeDiamonds = fee,
            prizeEnabled = false, commissionBps = 0, dailyEntryLimit = 50,
            rulesVersion = 1, isActive = true,
        )

        assertEquals(0, definition(feeEnabled = false, fee = 500, min = 2, max = 2).fee)
        assertEquals(500, definition(feeEnabled = true, fee = 500, min = 2, max = 4).fee)
        assertEquals("2 players", definition(true, 0, 2, 2).playerRange)
        assertEquals("2-4 players", definition(true, 0, 2, 4).playerRange)
    }

    @Test
    fun `a seat is live until it has left or been settled`() {
        assertTrue(player(hostId, 0, GameParticipantStatus.READY).isLive)
        assertFalse(player(hostId, 0, GameParticipantStatus.LEFT).isLive)
        assertFalse(player(hostId, 0, GameParticipantStatus.COMPLETED).isLive)
    }
}
