package com.voiza.app.ui.screens.game

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import com.voiza.app.domain.model.LUDO_HOME
import com.voiza.app.domain.model.LUDO_SAFE_CELLS
import com.voiza.app.domain.model.LUDO_TRACK
import com.voiza.app.domain.model.LUDO_YARD
import com.voiza.app.domain.model.LudoBoard
import com.voiza.app.domain.model.LudoSeat
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.ui.theme.VoizaSurfaceVariant

// ---------------------------------------------------------------------------
// Ludo.
//
// The engine's state is arithmetic: steps travelled per token, plus a die that has
// been rolled and not yet spent. That is drawn here as a numbered token per seat
// rather than a drawn board, because the numbers *are* the board — the cell a token
// sits on is derived from the same formula the engine uses, and a token can only be
// tapped when that formula says it can move.
// ---------------------------------------------------------------------------

@Composable
fun LudoBoardView(
    board: LudoBoard,
    session: GameSession,
    mySeat: Int?,
    myTurn: Boolean,
    locked: Boolean,
    onRoll: () -> Unit,
    onPiece: (Int) -> Unit,
) {
    val seat = mySeat?.let { board.seat(it) }
    val roll = seat?.pendingRoll
    val legal = if (myTurn && roll != null && seat != null) seat.legalPieces(roll, board.startRoll, LUDO_HOME) else emptyList()

    TurnHint(
        text = when {
            board.winnerPosition != null ->
                "${session.nameOfPosition(board.winnerPosition) ?: "Seat ${board.winnerPosition}"} brought all four tokens home"
            !myTurn -> "${session.nameOfPosition(board.turnPosition) ?: "Seat ${board.turnPosition}"} is up"
            roll == null -> "Roll the die"
            legal.isEmpty() -> "No token can spend a $roll — the turn passes on the clock"
            else -> "Roll was $roll — tap a token to move it"
        },
        highlight = myTurn && !board.finished,
    )

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 6.dp),
    ) {
        Text(
            text = if (roll != null) "◆ $roll" else "◆ ?",
            color = DiamondGold,
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "Needs a ${board.startRoll} to leave the yard · rolls so far ${board.rollCount}",
                color = OnDarkMuted,
                fontSize = 11.sp,
            )
            Text(
                text = "Track is $LUDO_TRACK squares, then a ${LUDO_HOME - LUDO_TRACK}-square home column",
                color = OnDarkMuted,
                fontSize = 11.sp,
            )
        }
        if (myTurn && roll == null && !locked) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(VoizaSurfaceVariant)
                    .clickable(onClick = onRoll)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            ) {
                Text("Roll", color = OnDarkHigh, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            }
        }
    }

    board.seats.toSortedMap().forEach { (position, playerSeat) ->
        SeatRow(
            seat = playerSeat,
            label = session.nameOfPosition(position) ?: "Seat $position",
            isMine = position == mySeat,
            isTurn = position == board.turnPosition,
            legalPieces = if (position == mySeat && myTurn) legal else emptyList(),
            onPiece = onPiece,
        )
    }
}

@Composable
private fun SeatRow(
    seat: LudoSeat,
    label: String,
    isMine: Boolean,
    isTurn: Boolean,
    legalPieces: List<Int>,
    onPiece: (Int) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (isTurn) VoizaSurfaceVariant else VoizaSurface)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label.take(12),
                color = if (isMine) OnDarkHigh else OnDarkMedium,
                fontSize = 12.sp,
                fontWeight = if (isTurn) FontWeight.Bold else FontWeight.Normal,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = "${seat.piecesHome}/${seat.total} home",
                color = Mint,
                fontSize = 11.sp,
            )
        }
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            seat.pieces.forEachIndexed { piece, steps ->
                val playable = piece in legalPieces
                Token(
                    steps = steps,
                    playable = playable,
                    onClick = { if (playable) onPiece(piece) },
                )
            }
        }
    }
}

@Composable
private fun Token(steps: Int, playable: Boolean, onClick: () -> Unit) {
    val cell = cellOf(steps)
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(40.dp)
            .clip(CircleShape)
            .background(
                when {
                    steps == LUDO_HOME -> Mint.copy(alpha = 0.30f)
                    cell != null && LUDO_SAFE_CELLS.contains(cell) -> Cyan.copy(alpha = 0.20f)
                    else -> VoizaSurfaceVariant
                }
            )
            .then(if (playable) Modifier.clickable(onClick = onClick) else Modifier),
    ) {
        Text(
            text = when {
                steps == LUDO_YARD -> "yard"
                steps >= LUDO_HOME -> "home"
                else -> cellLabel(steps, cell)
            },
            color = if (playable) OnDarkHigh else if (steps == LUDO_YARD) OnDarkMuted else Fuchsia,
            fontSize = 10.sp,
            maxLines = 1,
        )
    }
}

private fun cellOf(steps: Int): Int? = when {
    steps < 0 -> null
    steps >= LUDO_HOME -> null
    else -> steps % LUDO_TRACK
}

/** Where a token actually sits: its track cell, or its step inside the home column. */
private fun cellLabel(steps: Int, cell: Int?): String =
    if (steps < LUDO_TRACK) "c$cell" else "h${steps - LUDO_TRACK + 1}"
