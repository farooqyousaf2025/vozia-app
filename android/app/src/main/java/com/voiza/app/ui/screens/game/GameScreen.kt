package com.voiza.app.ui.screens.game

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.GameBoard
import com.voiza.app.domain.model.GameSession
import com.voiza.app.domain.model.GameStatus
import com.voiza.app.domain.model.LudoBoard
import com.voiza.app.domain.model.QuizBoard
import com.voiza.app.domain.model.TicTacToeBoard
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.viewmodel.GameSessionViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Games

/**
 * One match. The board drawn here is the board the server last wrote; every control
 * posts an intent and waits for that write rather than moving anything itself.
 */
@Composable
fun GameScreen(
    sessionId: String,
    onBack: () -> Unit,
    onOpenWallet: () -> Unit,
    viewModel: GameSessionViewModel = viewModel(
        key = "game-$sessionId",
        factory = voizaViewModelFactory { GameSessionViewModel(sessionId) },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val session = state.session

    GameScaffold(
        title = session?.gameKey?.let(::gameTitle) ?: "Match",
        subtitle = session?.roomId?.let { "Room match · rules v${session.rulesVersion}" },
        diamondBalance = state.user?.diamondBalance,
        onBack = onBack,
        onOpenWallet = onOpenWallet,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
        ) {
            when {
                state.loading && session == null -> LoadingProgress(overlay = false)
                session == null -> EmptyState(
                    icon = Icons.Default.Games,
                    title = "Match not found",
                    subtitle = "It may have been closed while you were on the way.",
                )
                else -> SessionBody(
                    session = session,
                    myId = state.user?.id,
                    secondsLeft = state.secondsLeft,
                    busy = state.busy,
                    onCell = viewModel::playCell,
                    onAnswer = viewModel::answer,
                    onRoll = viewModel::rollDice,
                    onPiece = viewModel::movePiece,
                    onReady = viewModel::ready,
                    onStart = viewModel::start,
                    onLeave = viewModel::leave,
                    onCancel = viewModel::cancel,
                    onDispute = viewModel::dispute,
                )
            }
            GameErrorLine(error = state.error, onDismiss = viewModel::clearError)
            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun SessionBody(
    session: GameSession,
    myId: String?,
    secondsLeft: Int?,
    busy: Boolean,
    onCell: (Int) -> Unit,
    onAnswer: (Int) -> Unit,
    onRoll: () -> Unit,
    onPiece: (Int) -> Unit,
    onReady: () -> Unit,
    onStart: () -> Unit,
    onLeave: () -> Unit,
    onCancel: () -> Unit,
    onDispute: (String) -> Unit,
) {
    SessionStatusBar(session = session, secondsLeft = secondsLeft)
    PlayerStrip(
        participants = session.participants,
        myId = myId,
        turnOwnerId = session.turnOwnerId,
    )

    RenderBoard(
        session = session,
        myId = myId,
        busy = busy,
        secondsLeft = secondsLeft,
        onCell = onCell,
        onAnswer = onAnswer,
        onRoll = onRoll,
        onPiece = onPiece,
    )

    session.settlement?.let { SettlementCard(settlement = it, participants = session.participants) }

    MatchActions(
        session = session,
        myId = myId,
        busy = busy,
        onReady = onReady,
        onStart = onStart,
        onLeave = onLeave,
        onCancel = onCancel,
        onDispute = onDispute,
    )
}

@Composable
private fun RenderBoard(
    session: GameSession,
    myId: String?,
    busy: Boolean,
    secondsLeft: Int?,
    onCell: (Int) -> Unit,
    onAnswer: (Int) -> Unit,
    onRoll: () -> Unit,
    onPiece: (Int) -> Unit,
) {
    val mySeat = session.participant(myId)?.position
    when (val board = session.board) {
        is TicTacToeBoard -> TicTacToeBoardView(
            board = board,
            session = session,
            mySeat = mySeat,
            myTurn = session.turnOwnerId == myId,
            locked = busy || session.isOver,
            onCell = onCell,
        )
        is QuizBoard -> QuizBoardView(
            board = board,
            session = session,
            myId = myId,
            secondsLeft = secondsLeft,
            locked = busy,
            onAnswer = onAnswer,
        )
        is LudoBoard -> LudoBoardView(
            board = board,
            session = session,
            mySeat = mySeat,
            myTurn = session.turnOwnerId == myId,
            locked = busy || session.isOver,
            onRoll = onRoll,
            onPiece = onPiece,
        )
        is GameBoard.Unsupported -> UnsupportedBoard(board.gameKey)
        GameBoard.NotStarted -> Text(
            text = if (session.status == GameStatus.WAITING) {
                "The board appears once the host starts the match."
            } else {
                "Waiting for the server to open the board."
            },
            color = OnDarkMuted,
            fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
        )
    }
}

@Composable
private fun MatchActions(
    session: GameSession,
    myId: String?,
    busy: Boolean,
    onReady: () -> Unit,
    onStart: () -> Unit,
    onLeave: () -> Unit,
    onCancel: () -> Unit,
    onDispute: (String) -> Unit,
) {
    val me = session.participant(myId)
    var disputeOpen by remember(session.id) { mutableStateOf(false) }
    var reason by remember(session.id) { mutableStateOf("") }

    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        if (session.status == GameStatus.WAITING && me != null && !me.ready && !busy) {
            VoizaSecondaryButton(text = "I'm ready", onClick = onReady)
        }
        if (session.canStart(myId) && !busy) {
            VoizaButton(text = "Start match", onClick = onStart, height = 46)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            if (session.isOpen && me != null && !busy) {
                VoizaSecondaryButton(
                    text = "Leave",
                    onClick = onLeave,
                    modifier = Modifier.weight(1f),
                )
            }
            if (session.canCancel(myId) && !busy) {
                VoizaSecondaryButton(
                    text = "Cancel & refund",
                    onClick = onCancel,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        // A finished match can still be contested; the claim is recorded with the rules
        // version this session pinned, which is what an operator then reviews.
        if (session.status == GameStatus.COMPLETED && me != null) {
            Text(
                text = "Dispute this result",
                color = DangerRed,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .padding(top = 4.dp)
                    .clickable { disputeOpen = true },
            )
        }
    }

    if (disputeOpen) {
        AlertDialog(
            onDismissRequest = { disputeOpen = false },
            containerColor = androidx.compose.ui.graphics.Color(0xFF151233),
            title = { Text("Dispute this match", color = OnDarkHigh) },
            text = {
                Column {
                    Text(
                        text = "This freezes the payout until an operator reviews it. " +
                            "Say what the server got wrong, not what you hoped for.",
                        color = OnDarkMuted,
                        fontSize = 12.sp,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = reason,
                        onValueChange = { reason = it },
                        label = { Text("Reason", fontSize = 12.sp) },
                        minLines = 2,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        disputeOpen = false
                        if (reason.isNotBlank()) onDispute(reason)
                    },
                ) { Text("Send", color = OnDarkHigh) }
            },
            dismissButton = {
                TextButton(onClick = { disputeOpen = false }) { Text("Cancel", color = OnDarkMuted) }
            },
        )
    }
}

private fun gameTitle(gameKey: String): String = when (gameKey) {
    "TIC_TAC_TOE" -> "Tic-Tac-Toe"
    "QUIZ_BATTLE" -> "Quiz Battle"
    "LUDO" -> "Ludo"
    else -> gameKey.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }
}
