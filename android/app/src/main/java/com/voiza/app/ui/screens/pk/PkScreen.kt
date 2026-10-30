package com.voiza.app.ui.screens.pk

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.FlashOn
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.PkBattle
import com.voiza.app.domain.model.PkRoomRef
import com.voiza.app.domain.model.PkSettings
import com.voiza.app.domain.model.PkSide
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaSurfaceVariant
import com.voiza.app.ui.theme.WarningAmber
import com.voiza.app.viewmodel.PkViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * The PK desk of one room.
 *
 * Two hosts, one clock, and a score that is never a number this screen produced: the server sums
 * the diamonds spent in each room during the battle window and freezes the result at settlement.
 * The invitation form only offers the durations the operator's dials allow, and every button here
 * is host-only because the server checks `rooms.host_id` on the other side.
 */
@Composable
fun PkScreen(
    roomId: String,
    onBack: () -> Unit,
    viewModel: PkViewModel = viewModel(
        factory = voizaViewModelFactory { PkViewModel(roomId) },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    // A battle can start, end or be cancelled while this screen is in the background.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.load() }

    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp),
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
            }
            Text("PK battle", color = OnDarkHigh, fontSize = 19.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            IconButton(onClick = viewModel::load) {
                Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = OnDarkMedium)
            }
        }

        Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
            val battle = state.battle
            when {
                state.loading && !state.loaded -> LoadingProgress(overlay = true)

                !state.loaded -> EmptyState(
                    icon = Icons.Default.FlashOn,
                    title = state.error ?: "PK battles did not load",
                    subtitle = "Nothing here is cached \u2014 the board comes from the server",
                    action = {
                        VoizaButton(
                            text = "Try again",
                            onClick = viewModel::load,
                            height = 44,
                            modifier = Modifier.width(160.dp),
                        )
                    },
                )

                battle != null -> BattleContent(
                    battle = battle,
                    roomId = roomId,
                    state = state,
                    onAccept = viewModel::accept,
                    onDecline = viewModel::decline,
                    onCancel = viewModel::cancel,
                )

                !state.isEnabled -> EmptyState(
                    icon = Icons.Default.FlashOn,
                    title = "PK battles are switched off",
                    subtitle = "The operator has turned battles off. Nothing can be started until they are back.",
                )

                !state.isHost -> EmptyState(
                    icon = Icons.Default.FlashOn,
                    title = "Only the host can start a battle",
                    subtitle = "A PK battle is between two rooms whose hosts agreed to it. " +
                        "Ask this room's host to open the challenge.",
                )

                else -> LazyColumn(
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    item { ChallengeIntro(state.settings, state.roomTitle) }
                    state.settings?.let { settings ->
                        item { SectionLabel("How long the race lasts") }
                        item {
                            DurationRow(
                                settings = settings,
                                selected = state.durationSeconds,
                                onSelect = viewModel::selectDuration,
                            )
                        }
                    }
                    item { SectionLabel("Choose the room to challenge") }
                    if (state.opponentRooms.isEmpty()) {
                        item {
                            EmptyState(
                                icon = Icons.Default.FlashOn,
                                title = "No other open rooms",
                                subtitle = "A battle needs a second host. Try again once another room is live.",
                            )
                        }
                    } else {
                        items(state.opponentRooms, key = { it.id }) { room ->
                            OpponentRow(
                                room = room,
                                selected = room.id == state.selectedOpponentId,
                                onClick = { viewModel.selectOpponent(room.id) },
                            )
                        }
                    }
                }
            }
        }

        if (state.battle == null && state.canInvite) {
            InviteBar(
                opponent = state.selectedOpponent,
                busy = state.busy,
                onInvite = viewModel::invite,
            )
        }

        state.message?.let { message ->
            PkSnack(text = message, onConsumed = viewModel::consumeMessage)
        }
        if (state.loaded) {
            state.error?.let { error ->
                Text(
                    text = error,
                    color = DangerRed,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Live card
// ---------------------------------------------------------------------------

@Composable
private fun BattleContent(
    battle: PkBattle,
    roomId: String,
    state: PkViewModel.PkUiState,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
    onCancel: () -> Unit,
) {
    LazyColumn(
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            VoizaCard(backgroundColor = VoizaSurfaceHigh, modifier = Modifier.fillMaxWidth()) {
                StatusHeader(battle, state.nowMs)
                Spacer(Modifier.height(12.dp))
                when {
                    battle.isInvited -> InvitedBody(battle, state, onAccept, onDecline, onCancel)
                    battle.isActive -> ActiveBody(battle, state)
                    else -> FinishedBody(battle)
                }
            }
        }

        val others = state.history.filterNot { it.id == battle.id }
        if (others.isNotEmpty()) {
            item { SectionLabel("Earlier battles") }
            items(others, key = { it.id }) { row ->
                HistoryRow(battle = row, nowRoomId = roomId)
            }
        }
    }
}

@Composable
private fun StatusHeader(battle: PkBattle, nowMs: Long) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = when {
                battle.isInvited -> "Invitation"
                battle.isActive -> "Live now"
                else -> "Result"
            },
            color = OnDarkHigh,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.weight(1f))
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(
                    when {
                        battle.isActive -> Color(0x33FFC246)
                        battle.isInvited -> Color(0x2622D3EE)
                        else -> Color(0x26B9B4D6)
                    }
                )
                .padding(horizontal = 10.dp, vertical = 4.dp),
        ) {
            Text(
                text = when {
                    battle.isActive -> battle.clockLabel(battle.remainingAt(nowMs))
                    battle.isInvited -> "Waiting"
                    battle.isFinished && battle.isDraw -> "Draw"
                    battle.isFinished -> "Finished"
                    else -> "Closed"
                },
                color = when {
                    battle.isActive -> WarningAmber
                    battle.isInvited -> Cyan
                    else -> OnDarkMedium
                },
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun InvitedBody(
    battle: PkBattle,
    state: PkViewModel.PkUiState,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
    onCancel: () -> Unit,
) {
    Text(
        text = "${battle.roomA.title} challenged ${battle.roomB.title}",
        color = OnDarkHigh,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
    )
    Spacer(Modifier.height(4.dp))
    Text(
        text = "Diamonds spent inside each room during the race decide the winner. " +
            "The challenge is open for ${battle.clockLabel(state.inviteRemainingMs)} more.",
        color = OnDarkMedium,
        fontSize = 11.sp,
    )
    Spacer(Modifier.height(12.dp))

    when {
        state.canAccept -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VoizaButton(
                text = if (state.busy) "Starting\u2026" else "Accept",
                onClick = onAccept,
                enabled = !state.busy,
                height = 46,
                modifier = Modifier.weight(1f),
            )
            VoizaSecondaryButton(
                text = "Decline",
                onClick = onDecline,
                enabled = !state.busy,
                modifier = Modifier.weight(1f),
            )
        }

        state.canCancel -> VoizaSecondaryButton(
            text = if (state.busy) "Cancelling\u2026" else "Cancel challenge",
            onClick = onCancel,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth(),
        )

        else -> Text(
            text = if (state.isHost) {
                "This room is waiting for the challenged host."
            } else {
                "Only this room's host can answer the challenge."
            },
            color = OnDarkMuted,
            fontSize = 11.sp,
        )
    }
}

@Composable
private fun ActiveBody(battle: PkBattle, state: PkViewModel.PkUiState) {
    ScoreLine(battle, state.remainingMs)
    Spacer(Modifier.height(10.dp))
    ShareBar(battle)
    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
        Text(battle.roomA.hostUsername, color = OnDarkMuted, fontSize = 10.sp, maxLines = 1)
        Text(battle.roomB.hostUsername, color = OnDarkMuted, fontSize = 10.sp, maxLines = 1)
    }
    Spacer(Modifier.height(10.dp))
    Text(
        text = "Gifts sent inside each room during the window decide the race. " +
            "The score is the server's ledger sum \u2014 nothing on a phone can move it.",
        color = OnDarkMuted,
        fontSize = 10.sp,
    )
    if (battle.durationSeconds > 0) {
        Spacer(Modifier.height(4.dp))
        Text(
            text = "Agreed length: ${battle.durationSeconds} seconds.",
            color = OnDarkMuted,
            fontSize = 10.sp,
        )
    }
}

@Composable
private fun FinishedBody(battle: PkBattle) {
    val winner = battle.winnerRoom
    if (battle.isFinished) {
        Text(
            text = when {
                winner != null -> "Winner: ${winner.title}"
                else -> "Draw \u2014 nobody wins"
            },
            color = when {
                winner != null -> Mint
                else -> OnDarkMedium
            },
            fontSize = 16.sp,
            fontWeight = FontWeight.Black,
        )
    } else {
        Text(
            text = when (battle.status.name) {
                "DECLINED" -> "The challenge was declined."
                "CANCELLED" -> "The challenge was withdrawn."
                "EXPIRED" -> "Nobody answered in time."
                else -> "This battle is closed."
            },
            color = OnDarkMedium,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
    Spacer(Modifier.height(10.dp))
    ScoreLine(battle, remainingMs = 0)
    Spacer(Modifier.height(10.dp))
    when {
        battle.bonusXp > 0 -> Text(
            text = "The winning room's top supporter earned +${battle.bonusXp} XP.",
            color = WarningAmber,
            fontSize = 11.sp,
        )
        battle.isFinished -> Text(
            text = "A draw pays no prize.",
            color = OnDarkMuted,
            fontSize = 10.sp,
        )
    }
    if (battle.stopped) {
        Spacer(Modifier.height(4.dp))
        Text(
            text = "An operator ended this battle before the clock.",
            color = OnDarkMuted,
            fontSize = 10.sp,
        )
    }
}

/** The two totals, as the server froze or last summed them. */
@Composable
private fun ScoreLine(battle: PkBattle, remainingMs: Long) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.weight(1f)) {
            TeamName(battle.roomA)
            Text(
                text = "%,d".format(battle.scoreA),
                color = Cyan,
                fontSize = 26.sp,
                fontWeight = FontWeight.Black,
            )
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = if (battle.isActive) battle.clockLabel(remainingMs) else "VS",
                color = if (battle.isActive) WarningAmber else OnDarkMuted,
                fontSize = if (battle.isActive) 20.sp else 13.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "diamonds",
                color = OnDarkMuted,
                fontSize = 9.sp,
            )
        }
        Column(modifier = Modifier.weight(1f), horizontalAlignment = Alignment.End) {
            TeamName(battle.roomB, alignEnd = true)
            Text(
                text = "%,d".format(battle.scoreB),
                color = Fuchsia,
                fontSize = 26.sp,
                fontWeight = FontWeight.Black,
            )
        }
    }
}

@Composable
private fun TeamName(room: PkRoomRef, alignEnd: Boolean = false) {
    Text(
        text = room.title.ifBlank { room.hostUsername.ifBlank { "Room" } },
        color = OnDarkHigh,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        textAlign = if (alignEnd) androidx.compose.ui.text.style.TextAlign.End else androidx.compose.ui.text.style.TextAlign.Start,
        modifier = Modifier.fillMaxWidth(),
    )
}

/** One bar split by share of the diamonds, so the two sides always add up to the whole. */
@Composable
private fun ShareBar(battle: PkBattle) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(10.dp)
            .clip(RoundedCornerShape(50))
            .background(Fuchsia),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth(battle.fractionA)
                .fillMaxHeight()
                .clip(RoundedCornerShape(50))
                .background(Brush.horizontalGradient(listOf(Cyan, Mint))),
        )
    }
}

// ---------------------------------------------------------------------------
// Invitation form
// ---------------------------------------------------------------------------

@Composable
private fun ChallengeIntro(settings: PkSettings?, roomTitle: String?) {
    VoizaCard(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = "Challenge another room",
            color = OnDarkHigh,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = "${roomTitle ?: "This room"} picks up the race once the other host accepts. " +
                "Supporters send gifts; whichever room receives more diamonds inside the window wins.",
            color = OnDarkMedium,
            fontSize = 11.sp,
        )
        settings?.let {
            Spacer(Modifier.height(8.dp))
            Text(
                text = "A battle lasts ${it.minDurationSeconds}\u2013${it.maxDurationSeconds} seconds. " +
                    "The winning room's top supporter earns +${it.winnerBonusXp} XP.",
                color = OnDarkMuted,
                fontSize = 10.sp,
            )
        }
    }
}

@Composable
private fun DurationRow(settings: PkSettings, selected: Int?, onSelect: (Int) -> Unit) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        items(settings.durationChoices(), key = { it }) { seconds ->
            val isSelected = seconds == selected
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(if (isSelected) Cyan else VoizaSurfaceVariant)
                    .clickable { onSelect(seconds) }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            ) {
                Text(
                    text = if (seconds % 60 == 0) "${seconds / 60} min" else "$seconds s",
                    color = if (isSelected) Color(0xFF0B0A1F) else OnDarkHigh,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

@Composable
private fun OpponentRow(room: RoomSummary, selected: Boolean, onClick: () -> Unit) {
    VoizaCard(
        backgroundColor = if (selected) Color(0x3322D3EE) else VoizaSurfaceHigh,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(34.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(VoizaSurfaceVariant),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.FlashOn, contentDescription = null, tint = Cyan, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = room.title,
                    color = OnDarkHigh,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = "${room.host.username} \u00B7 ${room.listenerCount} listening",
                    color = OnDarkMuted,
                    fontSize = 10.sp,
                    maxLines = 1,
                )
            }
            if (selected) {
                Text("Selected", color = Cyan, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun InviteBar(opponent: RoomSummary?, busy: Boolean, onInvite: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .background(VoizaSurfaceHigh)
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = opponent?.title ?: "Pick a room",
                color = if (opponent != null) OnDarkHigh else OnDarkMuted,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = if (opponent != null) "Ready to be challenged" else "Tap a room above",
                color = OnDarkMuted,
                fontSize = 10.sp,
            )
        }
        VoizaButton(
            text = if (busy) "Sending\u2026" else "Send challenge",
            onClick = onInvite,
            enabled = opponent != null && !busy,
            height = 44,
            modifier = Modifier.width(150.dp),
        )
    }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

@Composable
private fun HistoryRow(battle: PkBattle, nowRoomId: String) {
    val side = battle.sideOf(nowRoomId)
    VoizaCard(backgroundColor = VoizaSurfaceHigh, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "${battle.roomA.title} vs ${battle.roomB.title}",
                    color = OnDarkHigh,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = "${battle.scoreA} \u2013 ${battle.scoreB} diamonds",
                    color = OnDarkMedium,
                    fontSize = 10.sp,
                )
            }
            Text(
                text = historyLabel(battle, side),
                color = historyColor(battle, side),
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

private fun historyLabel(battle: PkBattle, side: PkSide?): String = when {
    !battle.isFinished -> "Closed"
    battle.isDraw -> "Draw"
    side == null -> "Finished"
    else -> if (battle.winnerRoomId == myRoomId(battle, side)) "Won" else "Lost"
}

private fun historyColor(battle: PkBattle, side: PkSide?): Color = when {
    !battle.isFinished -> OnDarkMuted
    battle.isDraw -> OnDarkMedium
    side == null -> OnDarkMedium
    historyLabel(battle, side) == "Won" -> Mint
    else -> DangerRed
}

private fun myRoomId(battle: PkBattle, side: PkSide): String =
    when (side) {
        PkSide.A -> battle.roomA.id
        PkSide.B -> battle.roomB.id
    }

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        color = OnDarkMedium,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 6.dp, bottom = 2.dp),
    )
}

/** One-shot confirmation snack; clears itself after 2.5 s. */
@Composable
private fun PkSnack(text: String, onConsumed: () -> Unit) {
    LaunchedEffect(text) {
        kotlinx.coroutines.delay(2500)
        onConsumed()
    }
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Text(
            text = text,
            color = OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .clip(RoundedCornerShape(10.dp))
                .background(Color(0xE6221B4E))
                .padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}
