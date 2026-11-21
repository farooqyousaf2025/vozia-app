package com.voiza.app.ui.screens.game

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.CarromBoard
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VioletLight

private val BoardWood = Color(0xFF704A36)
private val BoardBed = Color(0xFFE8D1A9)
private val BoardLine = Color(0xFF76533D)
private val CoinIvory = Color(0xFFF5E6C8)
private val CoinOnyx = Color(0xFF28212F)
private val QueenRose = Color(0xFFB94D79)

/** Draws the server's settled Carrom board; the client submits aim parameters only. */
@Composable
fun CarromBoardView(
    board: CarromBoard,
    mySeat: Int?,
    myTurn: Boolean,
    locked: Boolean,
    onShot: (Float, Float, Float) -> Unit,
) {
    var angle by remember(board.shotCount) { mutableFloatStateOf(90f) }
    var power by remember(board.shotCount) { mutableFloatStateOf(0.62f) }
    var strikerX by remember(board.shotCount) { mutableFloatStateOf(500f) }
    val canShoot = myTurn && !locked && board.winnerPosition == null && !board.draw

    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth().padding(12.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("PLAYER 1 · ${board.scores[0] ?: 0}", color = if (mySeat == 0) VioletLight else OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Text("PLAYER 2 · ${board.scores[1] ?: 0}", color = if (mySeat == 1) VioletLight else OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        Text(
            text = when {
                board.winnerPosition != null -> "Player ${board.winnerPosition + 1} wins"
                board.draw -> "Match drawn"
                board.queenPendingFor != null -> "Queen pocketed · Player ${board.queenPendingFor + 1} must cover next shot"
                myTurn -> "Your turn · Aim and set your power"
                else -> "Opponent's shot"
            },
            color = VioletLight, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
        )
        Canvas(modifier = Modifier.fillMaxWidth().aspectRatio(1f)) {
            val sx = size.width / 1000f
            val sy = size.height / 1000f
            fun p(x: Float, y: Float) = Offset(x * sx, y * sy)
            drawRoundRect(BoardWood, size = size, cornerRadius = CornerRadius(30f * sx))
            drawRoundRect(BoardBed, topLeft = p(62f, 62f), size = Size(876f * sx, 876f * sy), cornerRadius = CornerRadius(18f * sx))
            drawRoundRect(BoardLine, topLeft = p(112f, 112f), size = Size(776f * sx, 776f * sy), cornerRadius = CornerRadius(12f * sx), style = Stroke(3f * sx))
            listOf(82f to 82f, 918f to 82f, 82f to 918f, 918f to 918f).forEach { (x, y) ->
                drawCircle(Color(0xFF211A22), 43f * sx, p(x, y))
                drawCircle(Color(0xFF9A7656), 47f * sx, p(x, y), style = Stroke(4f * sx))
            }
            listOf(220f, 780f).forEach { x ->
                drawCircle(BoardLine, 9f * sx, p(x, 160f))
                drawCircle(BoardLine, 9f * sx, p(x, 840f))
            }
            drawLine(BoardLine, p(220f, 160f), p(780f, 160f), 3f * sx)
            drawLine(BoardLine, p(220f, 840f), p(780f, 840f), 3f * sx)
            drawCircle(BoardLine, 112f * sx, p(500f, 500f), style = Stroke(3f * sx))
            board.coins.filterNot { it.pocketed }.forEach { coin ->
                val color = when (coin.kind) {
                    "queen" -> QueenRose
                    else -> if (coin.owner == 0) CoinIvory else CoinOnyx
                }
                val edge = if (coin.owner == 0 || coin.kind == "queen") BoardLine else Color(0xFFD8C7A8)
                drawCircle(edge, 19f * sx, p(coin.x, coin.y))
                drawCircle(color, 15f * sx, p(coin.x, coin.y))
            }
            val strikerY = if (mySeat == 1) 160f else 840f
            val striker = p(board.strikerX, strikerY)
            drawCircle(Color(0xFF5C3C8E), 25f * sx, striker)
            drawCircle(Color(0xFFF9F4FF), 20f * sx, striker, style = Stroke(5f * sx))
            if (canShoot) {
                val radians = Math.toRadians(angle.toDouble())
                val direction = if (mySeat == 1) 1f else -1f
                val end = p(board.strikerX + (kotlin.math.cos(radians) * 125f).toFloat(), strikerY + (kotlin.math.sin(radians) * 125f).toFloat() * direction)
                drawLine(VioletLight, striker, end, 5f * sx)
                drawCircle(VioletLight, 8f * sx, end)
            }
        }
        Text("Aim angle · ${angle.toInt()}°", color = OnDarkMuted, fontSize = 11.sp)
        Slider(value = angle, onValueChange = { angle = it }, valueRange = 5f..175f, enabled = canShoot)
        Text("Shot power · ${(power * 100).toInt()}%", color = OnDarkMuted, fontSize = 11.sp)
        Slider(value = power, onValueChange = { power = it }, valueRange = 0.12f..1f, enabled = canShoot)
        Text("Striker position · ${strikerX.toInt()}", color = OnDarkMuted, fontSize = 11.sp)
        Slider(value = strikerX, onValueChange = { strikerX = it }, valueRange = 260f..740f, enabled = canShoot)
        VoizaButton(
            text = if (canShoot) "Strike" else if (board.winnerPosition != null || board.draw) "Match complete" else "Waiting for turn",
            onClick = { if (canShoot) onShot(angle, power, strikerX) },
            enabled = canShoot,
            height = 46,
        )
        Text("Server-simulated physics · 18 coins · queen cover · striker fouls", color = OnDarkMuted, fontSize = 10.sp)
    }
}
