package com.voiza.app.data.mapper

import com.google.gson.JsonParser
import com.voiza.app.domain.model.ConnectFourBoard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConnectFourBoardMapperTest {
    @Test
    fun parsesServerOwnedConnectFourGridAndResult() {
        val board = parseBoard(
            "CONNECT_FOUR",
            JsonParser.parseString("""{"grid":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1,0,1,0],"turnPosition":1,"winnerPosition":0,"winningCells":[35,36,37,38],"draw":false,"timeoutPosition":null,"moveCount":4}"""),
        ) as ConnectFourBoard
        assertEquals(1, board.turnPosition)
        assertEquals(0, board.winnerPosition)
        assertEquals(listOf(35, 36, 37, 38), board.winningCells)
        assertEquals(4, board.moveCount)
        assertNull(board.timeoutPosition)
    }
}
