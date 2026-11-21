package com.voiza.app.ui.screens.game

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.ChessBoard
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VioletLight

@Composable
fun ChessBoardView(board: ChessBoard, myTurn: Boolean, locked: Boolean, onMove: (Int, Int) -> Unit) {
    var selected by remember(board.moveCount) { mutableIntStateOf(-1) }
    val glyphs = mapOf("K" to "♔", "Q" to "♕", "R" to "♖", "B" to "♗", "N" to "♘", "P" to "♙",
        "k" to "♚", "q" to "♛", "r" to "♜", "b" to "♝", "n" to "♞", "p" to "♟")
    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth().padding(12.dp)) {
        Text(
            text = when { board.checkmate -> "Checkmate · Player ${(board.winnerPosition ?: 0) + 1} wins"
                board.stalemate -> "Stalemate · Draw"
                board.draw -> "Draw game"
                board.check -> "Check!"
                myTurn -> "Your move · Select a piece, then its destination"
                else -> "Opponent's turn" },
            color = VioletLight, fontSize = 13.sp, fontWeight = FontWeight.Bold
        )
        for (row in 0..7) {
            Row(horizontalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.fillMaxWidth()) {
                for (col in 0..7) {
                    val index = row * 8 + col
                    val piece = board.board.getOrNull(index)
                    val light = (row + col) % 2 == 0
                    val selectedHere = selected == index
                    Text(
                        text = glyphs[piece] ?: if (col == 0) "${8-row}" else " ",
                        color = when { selectedHere -> VioletLight; piece?.firstOrNull()?.isUpperCase() == true -> OnDarkHigh; piece != null -> OnDarkMuted; else -> OnDarkMuted },
                        fontSize = if (piece == null) 14.sp else 27.sp,
                        fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.weight(1f).clickable(enabled = myTurn && !locked && !board.checkmate && !board.draw) {
                            if (selected < 0) {
                                if (piece != null && piece.first().isUpperCase() == (board.turn == "w")) selected = index
                            } else {
                                if (selected == index) selected = -1 else {
                                    onMove(selected, index)
                                    selected = -1
                                }
                            }
                        }.padding(vertical = 7.dp)
                    )
                }
            }
        }
        Text(
            text = "Standard chess · castling, en passant and promotion are checked by the server.",
            color = OnDarkMuted, fontSize = 11.sp
        )
    }
}
