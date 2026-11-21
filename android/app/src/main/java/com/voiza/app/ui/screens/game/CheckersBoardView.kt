package com.voiza.app.ui.screens.game

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.CheckersBoard
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VioletLight

@Composable
fun CheckersBoardView(board: CheckersBoard, myTurn: Boolean, locked: Boolean, onMove: (Int, Int) -> Unit) {
    var selected by remember(board.moveCount, board.forcedFrom) { mutableIntStateOf(board.forcedFrom ?: -1) }
    val glyphs = mapOf("r" to "●", "R" to "♛", "b" to "●", "B" to "♛")
    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth().padding(12.dp)) {
        Text(
            text = when {
                board.winnerPosition != null -> "Checkers · Player ${board.winnerPosition + 1} wins"
                board.forcedFrom != null && myTurn -> "Multi-jump · Continue with the same piece"
                myTurn -> "Your move · Captures are mandatory"
                else -> "Opponent's turn"
            },
            color = VioletLight, fontSize = 13.sp, fontWeight = FontWeight.Bold
        )
        for (row in 0..7) {
            Row(horizontalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.fillMaxWidth()) {
                for (col in 0..7) {
                    val cell = row * 8 + col
                    val piece = board.board.getOrNull(cell)
                    val dark = (row + col) % 2 == 1
                    val own = piece != null && piece.first().lowercase() == board.turn
                    val chosen = selected == cell
                    Text(
                        text = glyphs[piece] ?: " ",
                        color = when {
                            chosen -> VioletLight
                            piece == "r" || piece == "R" -> Color(0xFFFFD8C7)
                            piece == "b" || piece == "B" -> OnDarkHigh
                            else -> OnDarkMuted
                        },
                        fontSize = if (piece == null) 14.sp else 25.sp,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.weight(1f)
                            .background(if (chosen) Color(0xFF70529A) else if (dark) Color(0xFF51445A) else Color(0xFFB9A58C))
                            .clickable(enabled = myTurn && !locked && board.winnerPosition == null && dark) {
                                if (own) selected = cell
                                else if (selected >= 0 && selected != cell) {
                                    onMove(selected, cell)
                                    selected = -1
                                }
                            }
                            .padding(vertical = 9.dp)
                    )
                }
            }
        }
        Text("American checkers · mandatory captures · multi-jumps · king promotion", color = OnDarkMuted, fontSize = 11.sp)
    }
}
