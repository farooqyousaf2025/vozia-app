package com.voiza.app.ui.screens.game

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
import com.voiza.app.domain.model.RockPaperScissorsBoard
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VioletLight

@Composable
fun RockPaperScissorsBoardView(
    board: RockPaperScissorsBoard,
    mySeat: Int?,
    locked: Boolean,
    onChoose: (String) -> Unit,
) {
    val submitted = mySeat != null && board.committedPositions.contains(mySeat)
    val revealed = board.choices.size == 2
    Column(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 16.dp),
    ) {
        Text(
            text = when {
                board.winnerPosition != null -> "Player ${board.winnerPosition + 1} wins"
                board.draw -> "It's a draw"
                submitted -> "Choice locked · waiting for your opponent"
                else -> "Choose your hand"
            },
            color = VioletLight,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
        )
        if (!board.draw && board.winnerPosition == null && !submitted && !locked) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                listOf("ROCK", "PAPER", "SCISSORS").forEach { choice ->
                    VoizaSecondaryButton(
                        text = choice.lowercase().replaceFirstChar { it.uppercase() },
                        onClick = { onChoose(choice) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        if (revealed) {
            board.choices.toSortedMap().forEach { (position, choice) ->
                Text("Player ${position + 1}: ${choice.lowercase().replaceFirstChar { it.uppercase() }}", color = OnDarkHigh, fontSize = 14.sp)
            }
        } else if (!board.draw && board.winnerPosition == null) {
            Text("Choices stay hidden until both players have locked in.", color = OnDarkMuted, fontSize = 12.sp)
        }
        Text(
            "Rock beats scissors · scissors beats paper · paper beats rock",
            color = OnDarkMuted,
            fontSize = 11.sp,
        )
    }
}
