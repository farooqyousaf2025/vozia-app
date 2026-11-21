package com.voiza.app.ui.screens.game

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.ConnectFourBoard
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VioletLight

@Composable
fun ConnectFourBoardView(
    board: ConnectFourBoard,
    myTurn: Boolean,
    locked: Boolean,
    onColumn: (Int) -> Unit,
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(5.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 14.dp),
    ) {
        Text(
            text = when {
                board.winnerPosition != null -> "Winner: Player ${board.winnerPosition + 1}"
                board.draw -> "Draw game"
                myTurn -> "Your turn · choose a column"
                else -> "Opponent's turn"
            },
            color = VioletLight,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(3.dp), modifier = Modifier.fillMaxWidth()) {
            for (column in 0..6) {
                Text(
                    text = "↓",
                    color = if (myTurn && !locked) OnDarkHigh else OnDarkMuted,
                    fontSize = 18.sp,
                    modifier = Modifier.weight(1f).clickable(enabled = myTurn && !locked) { onColumn(column) },
                )
            }
        }
        for (row in 0..5) {
            Row(horizontalArrangement = Arrangement.spacedBy(3.dp), modifier = Modifier.fillMaxWidth()) {
                for (column in 0..6) {
                    val index = row * 7 + column
                    val seat = board.grid.getOrNull(index)
                    val symbol = when (seat) {
                        0 -> "●"
                        1 -> "●"
                        null -> "·"
                        else -> "●"
                    }
                    val color = when (seat) {
                        null -> OnDarkMuted
                        0 -> VioletLight
                        else -> OnDarkHigh
                    }
                    Text(
                        text = symbol,
                        color = color,
                        fontSize = 27.sp,
                        fontWeight = FontWeight.Black,
                        modifier = Modifier.weight(1f).clickable(enabled = myTurn && !locked && seat == null) {
                            onColumn(column)
                        },
                    )
                }
            }
        }
        Text(
            text = "First to connect four discs wins. Moves and results are verified by Vozia's game server.",
            color = OnDarkMuted,
            fontSize = 11.sp,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}
