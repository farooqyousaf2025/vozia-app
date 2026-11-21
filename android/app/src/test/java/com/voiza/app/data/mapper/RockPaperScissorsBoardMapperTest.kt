package com.voiza.app.data.mapper

import com.google.gson.JsonParser
import com.voiza.app.domain.model.RockPaperScissorsBoard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RockPaperScissorsBoardMapperTest {
    @Test
    fun parsesChoicesAndServerResult() {
        val board = parseBoard(
            "ROCK_PAPER_SCISSORS",
            JsonParser.parseString("""{"choices":{"0":"ROCK","1":"SCISSORS"},"committedPositions":[0,1],"winnerPosition":0,"draw":false,"timeoutPosition":null}"""),
        ) as RockPaperScissorsBoard
        assertEquals(mapOf(0 to "ROCK", 1 to "SCISSORS"), board.choices)
        assertEquals(0, board.winnerPosition)
        assertEquals(false, board.draw)
        assertNull(board.timeoutPosition)
    }
}
