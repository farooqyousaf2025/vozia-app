package com.voiza.app.ui.screens.game

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SportsEsports
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.GameDefinition
import com.voiza.app.domain.model.GameHistoryRow
import com.voiza.app.domain.model.GameSession
import com.voiza.app.domain.model.GameStatus
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.viewmodel.GameLobbyViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * The room's game desk. Opened from a party room, because a match belongs to one: its
 * entry fee, its pinned rules version and its settlement all hang off the room that
 * hosted it.
 */
@Composable
fun GameLobbyScreen(
    roomId: String,
    onBack: () -> Unit,
    onOpenSession: (String) -> Unit,
    onOpenWallet: () -> Unit,
    viewModel: GameLobbyViewModel = viewModel(
        key = "game-lobby-$roomId",
        factory = voizaViewModelFactory { GameLobbyViewModel(roomId) },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    GameScaffold(
        title = "Games",
        subtitle = if (state.isHost) "You host this room — you can open a match" else "The room host opens matches",
        diamondBalance = state.user?.diamondBalance,
        onBack = onBack,
        onOpenWallet = onOpenWallet,
    ) {
        if (state.loading && state.definitions.isEmpty()) {
            LoadingProgress(overlay = false)
            return@GameScaffold
        }

        GameErrorLine(error = state.error, onDismiss = viewModel::load)

        LazyColumn(
            contentPadding = PaddingValues(start = 14.dp, end = 14.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            item { SectionLabel("Play") }

            items(state.definitions, key = { it.key }) { definition ->
                DefinitionCard(
                    definition = definition,
                    canOpen = state.isHost && !state.busy,
                    balance = state.user?.diamondBalance ?: 0,
                    onOpen = { viewModel.create(definition.key) },
                )
            }

            if (state.openSessions.isNotEmpty()) {
                item { SectionLabel("Open tables") }
                items(state.openSessions, key = { it.id }) { session ->
                    SessionCard(
                        session = session,
                        myId = state.user?.id,
                        busy = state.busy,
                        onJoin = { viewModel.join(session.id) },
                        onReady = { viewModel.ready(session.id) },
                        onStart = { viewModel.start(session.id) },
                        onCancel = { viewModel.cancel(session.id) },
                        onOpen = { onOpenSession(session.id) },
                    )
                }
            }

            if (state.liveSessions.isNotEmpty()) {
                item { SectionLabel("Live now") }
                items(state.liveSessions, key = { it.id }) { session ->
                    SessionCard(
                        session = session,
                        myId = state.user?.id,
                        busy = false,
                        onJoin = {},
                        onReady = {},
                        onStart = {},
                        onCancel = {},
                        onOpen = { onOpenSession(session.id) },
                    )
                }
            }

            if (state.history.isNotEmpty()) {
                item { SectionLabel("Your recent matches") }
                items(state.history, key = { it.sessionId }) { row ->
                    HistoryRow(row = row, onOpen = { onOpenSession(row.sessionId) })
                }
            }

            if (state.definitions.isEmpty()) {
                item {
                    EmptyState(
                        icon = Icons.Default.SportsEsports,
                        title = "No games open in this room",
                        subtitle = "The operator has not activated a game, or every one is disabled right now.",
                    )
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        color = OnDarkHigh,
        fontSize = 13.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(top = 8.dp),
    )
}

/**
 * The rules as the operator set them, at the version this match will pin if it is
 * opened now. Opening is host-only and the card says why it is dimmed.
 */
@Composable
private fun DefinitionCard(
    definition: GameDefinition,
    canOpen: Boolean,
    balance: Int,
    onOpen: () -> Unit,
) {
    VoizaCard(modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = definition.name,
                color = OnDarkHigh,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = if (definition.fee > 0) "${definition.fee} ◆" else "free",
                color = if (definition.fee > 0) DiamondGold else Mint,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
        definition.description?.let {
            Text(it, color = OnDarkMedium, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
        }
        Text(
            text = "${definition.playerRange} · ${definition.turnTimeoutSeconds}s per turn · " +
                "house cut ${definition.commissionBps / 100.0}% · rules v${definition.rulesVersion}",
            color = OnDarkMuted,
            fontSize = 11.sp,
            modifier = Modifier.padding(top = 4.dp),
        )
        Spacer(Modifier.height(8.dp))
        VoizaButton(
            text = if (balance < definition.fee) "Not enough diamonds" else "Open this match",
            onClick = onOpen,
            enabled = canOpen && balance >= definition.fee,
            height = 42,
        )
        if (!canOpen) {
            Text(
                text = "Only the room host can open a match.",
                color = OnDarkMuted,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

@Composable
private fun SessionCard(
    session: GameSession,
    myId: String?,
    busy: Boolean,
    onJoin: () -> Unit,
    onReady: () -> Unit,
    onStart: () -> Unit,
    onCancel: () -> Unit,
    onOpen: () -> Unit,
) {
    val me = session.participant(myId)
    VoizaCard(modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = session.gameKey.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() },
                color = OnDarkHigh,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = "${session.livePlayers.size}/${session.maxPlayers}",
                color = Cyan,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
        PlayerStrip(participants = session.participants, myId = myId, turnOwnerId = session.turnOwnerId)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            when {
                session.canJoin(myId) && !busy -> VoizaSecondaryButton(
                    text = if (session.entryFeeDiamonds > 0) "Join · ${session.entryFeeDiamonds} ◆" else "Join",
                    onClick = onJoin,
                    modifier = Modifier.weight(1f),
                )
                me != null && !me.ready && session.status == GameStatus.WAITING && !busy -> VoizaSecondaryButton(
                    text = "I'm ready",
                    onClick = onReady,
                    modifier = Modifier.weight(1f),
                )
                else -> VoizaButton(
                    text = if (session.status == GameStatus.IN_PROGRESS) "Watch" else "Enter",
                    onClick = onOpen,
                    modifier = Modifier.weight(1f),
                    height = 42,
                )
            }
            if (session.canStart(myId) && !busy) {
                VoizaButton(text = "Start", onClick = onStart, modifier = Modifier.weight(1f), height = 42)
            }
        }
        if (session.canCancel(myId) && !busy) {
            Text(
                text = "Cancel and refund entry fees",
                color = OnDarkMuted,
                fontSize = 11.sp,
                modifier = Modifier
                    .padding(top = 6.dp)
                    .clickable(onClick = onCancel),
            )
        }
    }
}

@Composable
private fun HistoryRow(row: GameHistoryRow, onOpen: () -> Unit) {
    VoizaCard(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = 10.dp,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = row.gameKey.replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() },
                    color = OnDarkHigh,
                    fontSize = 13.sp,
                )
                Text(
                    text = row.endedAt?.take(16)?.replace('T', ' ')
                        ?: row.createdAt.take(16).replace('T', ' '),
                    color = OnDarkMuted,
                    fontSize = 10.sp,
                )
            }
            Text(
                text = row.rank?.let { "#$it" } ?: row.status.name.lowercase(),
                color = if (row.rank == 1) DiamondGold else OnDarkMedium,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = if (row.netDiamonds >= 0) "+${row.netDiamonds} ◆" else "${row.netDiamonds} ◆",
                color = if (row.netDiamonds >= 0) Mint else OnDarkMedium,
                fontSize = 12.sp,
                modifier = Modifier.padding(start = 8.dp),
            )
            Text(
                text = "open",
                color = Cyan,
                fontSize = 11.sp,
                modifier = Modifier
                    .padding(start = 10.dp)
                    .clickable(onClick = onOpen),
            )
        }
    }
}
