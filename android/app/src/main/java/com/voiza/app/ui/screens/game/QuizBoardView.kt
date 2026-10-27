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
import com.voiza.app.domain.model.QuizBoard
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.ui.theme.VoizaSurfaceVariant

// ---------------------------------------------------------------------------
// Quiz Battle.
//
// There is no turn owner: the round is open to every seat at once, so the screen
// gates on "have you answered this round" rather than "is it your move". The payload
// is a question index and an option index — the server decides which round is live,
// whether the window closed, and what the answer was worth.
// ---------------------------------------------------------------------------

@Composable
fun QuizBoardView(
    board: QuizBoard,
    session: GameSession,
    myId: String?,
    secondsLeft: Int?,
    locked: Boolean,
    onAnswer: (Int) -> Unit,
) {
    val question = board.liveQuestion
    val answered = board.hasAnswered(myId)
    val myPoints = session.participant(myId)?.score ?: 0

    TurnHint(
        text = when {
            board.finished -> "All rounds are in"
            question == null -> "Waiting for the next round"
            answered -> "Answered — the round closes on the server's clock"
            else -> "Question ${board.index + 1} of ${board.questions.size}"
        },
        highlight = !answered && !board.finished,
    )

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp),
    ) {
        Text("My points: $myPoints", color = Mint, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.weight(1f))
        if (secondsLeft != null && !board.finished) {
            Text(
                text = "${secondsLeft}s left",
                color = if (secondsLeft <= 3) DangerRed else Cyan,
                fontSize = 12.sp,
            )
        }
    }

    if (question == null || board.finished) {
        RoundSummary(board = board, session = session)
        return
    }

    VoizaSurfaceBlock(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
        Text(
            text = question.prompt,
            color = OnDarkHigh,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.height(10.dp))
        question.options.forEachIndexed { optionIndex, option ->
            val mine = board.answerOf(myId, board.index)?.optionIndex
            val chosen = mine == optionIndex
            OptionRow(
                label = option,
                selected = chosen,
                showResult = mine != null,
                enabled = !answered && !locked,
                onClick = { onAnswer(optionIndex) },
            )
        }
    }

    if (!answered) {
        Text(
            text = "Scoring: ${board.correctPoints} for a correct answer, up to ${board.maxSpeedBonus} more for speed.",
            color = OnDarkMuted,
            fontSize = 11.sp,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp),
        )
    } else {
        RoundSummary(board = board, session = session)
    }
}

@Composable
private fun OptionRow(
    label: String,
    selected: Boolean,
    showResult: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    // A finished round does not mark right/wrong here: the payload never carries the
    // answer key, so the only truth this screen can show is the points it was worth.
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(
                when {
                    selected && showResult -> VoizaSurfaceVariant
                    enabled -> VoizaSurface
                    else -> VoizaSurface.copy(alpha = 0.55f)
                }
            )
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label,
                color = if (selected) OnDarkHigh else OnDarkMedium,
                fontSize = 13.sp,
                modifier = Modifier.weight(1f),
            )
            if (selected) {
                Text("yours", color = Cyan, fontSize = 11.sp)
            }
        }
    }
}

/** Who is in front: the server's own per-seat scores, not a tally the client kept. */
@Composable
private fun RoundSummary(board: QuizBoard, session: GameSession) {
    Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
        Text("Standings", color = OnDarkHigh, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        session.livePlayers
            .sortedByDescending { it.score }
            .forEach { player ->
                val answeredCount = board.answers[player.userId]?.size ?: 0
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 2.dp),
                ) {
                    Text(
                        text = player.username.take(14),
                        color = OnDarkMedium,
                        fontSize = 12.sp,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = "$answeredCount/${board.questions.size} answered",
                        color = OnDarkMuted,
                        fontSize = 11.sp,
                    )
                    Text(
                        text = " ${player.score} pts",
                        color = Mint,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
    }
}

@Composable
private fun VoizaSurfaceBlock(
    modifier: Modifier = Modifier,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(VoizaSurface),
        verticalArrangement = Arrangement.spacedBy(0.dp),
        content = content,
    )
}
