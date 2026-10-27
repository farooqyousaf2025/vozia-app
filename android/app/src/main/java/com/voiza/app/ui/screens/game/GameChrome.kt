package com.voiza.app.ui.screens.game

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.GameParticipant
import com.voiza.app.domain.model.GamePhase
import com.voiza.app.domain.model.GameSession
import com.voiza.app.domain.model.GameSettlement
import com.voiza.app.domain.model.GameStatus
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.DiamondChip
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaAccentGradient
import com.voiza.app.ui.theme.VoizaHeroGradient
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaSurfaceVariant

// ---------------------------------------------------------------------------
// Shared chrome for the game screens.
//
// Everything here prints numbers the server already decided. The one exception is the
// countdown, a local estimate against the device clock: the engine's own timeout sweep
// is what ends a stalled turn, so a phone with a wrong clock sees a wrong number and
// still forfeits exactly when the server says it does.
// ---------------------------------------------------------------------------

@Composable
fun GameScaffold(
    title: String,
    subtitle: String?,
    diamondBalance: Int?,
    onBack: () -> Unit,
    onOpenWallet: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(VoizaHeroGradient),
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            ) {
                IconButton(onClick = onBack) {
                    Icon(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back",
                        tint = OnDarkHigh,
                    )
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(title, color = OnDarkHigh, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    subtitle?.let { Text(it, color = OnDarkMedium, fontSize = 12.sp) }
                }
                DiamondChip(balance = diamondBalance, onClick = onOpenWallet)
            }
            Column(modifier = Modifier.weight(1f)) { content() }
        }
    }
}

/** One line saying where the match stands, in the server's terms rather than ours. */
@Composable
fun SessionStatusBar(session: GameSession, secondsLeft: Int?) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 6.dp),
    ) {
        StatusChip(session.status, session.phase)
        Text(
            text = "rules v${session.rulesVersion} · entry ${session.entryFeeDiamonds} ◆",
            color = OnDarkMuted,
            fontSize = 11.sp,
        )
        Spacer(Modifier.weight(1f))
        if (secondsLeft != null && session.status == GameStatus.IN_PROGRESS) {
            Text(
                text = "${secondsLeft}s",
                color = if (secondsLeft <= 5) DangerRed else Cyan,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun StatusChip(status: GameStatus, phase: GamePhase) {
    val (label, color) = when (status) {
        GameStatus.WAITING -> "Waiting for players" to Color(0xFFFFC246)
        GameStatus.READY -> "Ready to start" to Mint
        GameStatus.IN_PROGRESS -> when (phase) {
            GamePhase.FINISHED -> "Finishing" to DiamondGold
            else -> "In progress" to Mint
        }
        GameStatus.COMPLETED -> "Completed" to DiamondGold
        GameStatus.CANCELLED -> "Cancelled" to OnDarkMuted
        GameStatus.DISPUTED -> "Under dispute" to DangerRed
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(color.copy(alpha = 0.18f))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(label, color = color, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
    }
}

/**
 * Seats in play order. The seat number is shown because that is what the board is
 * written in: the engine records positions, not names, and the client only maps one
 * to the other for display.
 */
@Composable
fun PlayerStrip(
    participants: List<GameParticipant>,
    myId: String?,
    turnOwnerId: String?,
    modifier: Modifier = Modifier,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 6.dp),
    ) {
        participants.sortedBy { it.position }.forEach { player ->
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.width(64.dp),
            ) {
                Avatar(
                    url = player.avatarUrl,
                    name = player.username,
                    size = 40.dp,
                    ringBrush = if (player.userId == turnOwnerId) VoizaAccentGradient else null,
                    ringWidth = 2.dp,
                )
                Text(
                    text = player.username.take(8),
                    color = if (player.userId == myId) OnDarkHigh else OnDarkMedium,
                    fontSize = 10.sp,
                    maxLines = 1,
                )
                Text(
                    text = when {
                        player.rank != null -> "#${player.rank}"
                        player.score > 0 -> "${player.score} pts"
                        else -> "seat ${player.position}"
                    },
                    color = if (player.userId == turnOwnerId) Cyan else OnDarkMuted,
                    fontSize = 10.sp,
                )
            }
        }
    }
}

/**
 * Where the pool went, printed as the settlement engine reported it: gross, the
 * platform's cut, what was prize-eligible, and what actually landed. A `distributed`
 * below `prizePool` is said out loud rather than rounded away.
 */
@Composable
fun SettlementCard(settlement: GameSettlement, participants: List<GameParticipant>) {
    VoizaCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 6.dp),
        backgroundColor = VoizaSurfaceHigh,
    ) {
        Text("Settlement", color = OnDarkHigh, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        PoolLine("Pool", settlement.grossPool)
        PoolLine("Platform commission", settlement.commission)
        PoolLine("Prize pool", settlement.prizePool)
        PoolLine("Paid out", settlement.distributed)
        // Shown only when the engine actually recorded a residual, so the four lines above can be
        // read as the whole pool and not a subtotal the player has to complete himself.
        if (settlement.deductions != 0) PoolLine("Kept by the platform", settlement.deductions)
        if (settlement.payouts.isEmpty() && settlement.prizePool > 0) {
            Text(
                text = "Nothing distributed yet — raise a dispute if this match ended without paying.",
                color = DangerRed,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        settlement.payouts.forEach { payout ->
            val name = participants.firstOrNull { it.userId == payout.userId }?.username
                ?: payout.userId.take(6)
            Row(modifier = Modifier.fillMaxWidth().padding(top = 3.dp)) {
                Text(name, color = OnDarkMedium, fontSize = 12.sp, modifier = Modifier.weight(1f))
                Text("#${payout.rank} +${payout.diamonds} ◆", color = Mint, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun PoolLine(label: String, diamonds: Int) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 1.dp),
    ) {
        Text(label, color = OnDarkMedium, fontSize = 12.sp, modifier = Modifier.weight(1f))
        Text("$diamonds ◆", color = DiamondGold, fontSize = 12.sp)
    }
}

/** The server's rejection, in its own words, with a way to get rid of it. */
@Composable
fun GameErrorLine(error: String?, onDismiss: () -> Unit) {
    if (error.isNullOrBlank()) return
    Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) {
        Text(
            text = error,
            color = OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .background(DangerRed.copy(alpha = 0.92f))
                .padding(horizontal = 12.dp, vertical = 8.dp),
        )
        Spacer(Modifier.height(2.dp))
        Text(
            text = "Dismiss",
            color = OnDarkMuted,
            fontSize = 10.sp,
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .background(VoizaSurfaceVariant)
                .clickable(onClick = onDismiss)
                .padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

@Composable
fun TurnHint(text: String, highlight: Boolean) {
    Text(
        text = text,
        color = if (highlight) OnDarkHigh else OnDarkMedium,
        fontSize = 13.sp,
        fontWeight = if (highlight) FontWeight.Bold else FontWeight.Normal,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 6.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (highlight) VoizaSurfaceVariant else VoizaSurface)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    )
}

@Composable
fun UnsupportedBoard(gameKey: String) {
    VoizaCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(14.dp),
        backgroundColor = VoizaSurfaceHigh,
    ) {
        Text("This game needs a newer app", color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text(
            text = "$gameKey is running on the server, but this build has no board for it. " +
                "Seats, entry fee and settlement still show above.",
            color = OnDarkMedium,
            fontSize = 12.sp,
        )
    }
}
