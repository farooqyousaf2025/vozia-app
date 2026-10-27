package com.voiza.app.ui.screens.game

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.GameSession
import com.voiza.app.domain.model.TicTacToeBoard
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.ui.theme.VoizaSurfaceVariant

// ---------------------------------------------------------------------------
// Tic-Tac-Toe.
//
// The engine stores *seats* in the grid, not user ids and not marks, so the mark a
// cell shows is derived here from the seat that owns it. A tap sends the cell index
// and nothing else; whether it lands is the engine's answer, not this screen's.
// ---------------------------------------------------------------------------

@Composable
fun TicTacToeBoardView(
    board: TicTacToeBoard,
    session: GameSession,
    mySeat: Int?,
    myTurn: Boolean,
    locked: Boolean,
    onCell: (Int) -> Unit,
) {
    TurnHint(
        text = when {
            board.winnerPosition != null ->
                "${session.nameOfPosition(board.winnerPosition) ?: "Seat ${board.winnerPosition}"} wins" +
                    if (board.timeoutPosition != null) " after a stalled clock" else ""
            board.draw -> "Draw — every square is filled"
            myTurn -> "Your move"
            else -> "${session.nameOfPosition(board.turnPosition) ?: "Seat ${board.turnPosition}"} to move"
        },
        highlight = myTurn && !board.isOver,
    )

    mySeat?.let { seat ->
        Text(
            text = "You play ${markFor(seat)} · the other seat plays ${markFor(1 - seat)}",
            color = OnDarkMuted,
            fontSize = 11.sp,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 2.dp),
        )
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 22.dp, vertical = 10.dp),
    ) {
        for (row in 0..2) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (col in 0..2) {
                    val cell = row * 3 + col
                    CellView(
                        modifier = Modifier.weight(1f),
                        owner = board.grid.getOrNull(cell),
                        winning = board.winLine.contains(cell),
                        playable = myTurn && !locked && board.isEmpty(cell),
                        onClick = { onCell(cell) },
                    )
                }
            }
        }
    }
}

@Composable
private fun CellView(
    modifier: Modifier,
    owner: Int?,
    winning: Boolean,
    playable: Boolean,
    onClick: () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(10.dp))
            .background(
                when {
                    winning -> Cyan.copy(alpha = 0.22f)
                    playable -> VoizaSurfaceVariant
                    else -> VoizaSurface
                }
            )
            .then(if (playable) Modifier.clickable(onClick = onClick) else Modifier),
    ) {
        if (owner != null) {
            Text(
                text = markFor(owner),
                color = if (owner == 0) Fuchsia else Cyan,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
            )
        } else {
            Text(text = "·", color = OnDarkMuted, fontSize = 20.sp)
        }
    }
}

/** Seat 0 is X, seat 1 is O. Only two seats exist in this game, so no other mark is needed. */
private fun markFor(seat: Int): String = if (seat == 0) "X" else "O"
