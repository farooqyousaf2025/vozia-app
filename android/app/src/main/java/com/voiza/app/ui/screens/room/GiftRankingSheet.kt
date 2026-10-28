package com.voiza.app.ui.screens.room

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.Leaderboard
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.RankRow
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.RankBadge
import com.voiza.app.ui.components.VoizaSheet
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.WarningAmber

/**
 * The board behind the gift panel: who is keeping this room alive, and who it
 * pays. Both halves read the same ledger through GET /api/users/top, so the
 * numbers are the server's, never a local tally of what this device saw.
 */
@Composable
fun GiftRankingSheet(
    visible: Boolean,
    board: RankBoard,
    window: String,
    leaderboard: Leaderboard?,
    loading: Boolean,
    error: String?,
    onSelectBoard: (RankBoard) -> Unit,
    onSelectWindow: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    // \u2756 diamonds spent, \u25C9 coin earned
    val glyph = if (board == RankBoard.SENDERS) "\u2756" else "\u25C9"
    VoizaSheet(
        visible = visible,
        onDismiss = onDismiss,
        title = "Gift ranking",
        subtitle = if (board == RankBoard.SENDERS) "Diamonds spent" else "Coin earned by hosts",
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            RankTab(text = "Gifters", active = board == RankBoard.SENDERS) { onSelectBoard(RankBoard.SENDERS) }
            RankTab(text = "Hosts", active = board == RankBoard.RECEIVERS) { onSelectBoard(RankBoard.RECEIVERS) }
        }
        Spacer(Modifier.size(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("day", "week", "month").forEach { key ->
                RankTab(text = key.replaceFirstChar { it.uppercase() }, active = key == window) {
                    onSelectWindow(key)
                }
            }
        }

        when {
            loading -> Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp),
            ) { LoadingProgress() }

            error != null -> Text(
                text = error,
                color = Color(0xFFFF8FA0),
                fontSize = 12.sp,
                modifier = Modifier.fillMaxWidth().padding(vertical = 18.dp),
            )

            leaderboard == null || leaderboard.rows.isEmpty() -> Text(
                text = "No gifts in this window yet.",
                color = OnDarkMedium,
                fontSize = 12.sp,
                modifier = Modifier.fillMaxWidth().padding(vertical = 18.dp),
            )

            else -> LazyColumn(
                verticalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 320.dp)
                    .padding(top = 10.dp),
            ) {
                itemsIndexed(leaderboard.rows) { index, row -> RankRowItem(index, row, glyph) }
            }
        }
    }
}

@Composable
private fun RankRowItem(rank: Int, row: RankRow, glyph: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (rank == 0) Color(0x33FFC94D) else Color(0x14FFFFFF))
            .padding(horizontal = 10.dp, vertical = 7.dp),
    ) {
        Text(
            text = "${rank + 1}",
            color = when (rank) {
                0 -> WarningAmber
                1 -> Color(0xFFCBD2E1)
                2 -> Color(0xFFD9906B)
                else -> OnDarkMedium
            },
            fontSize = 14.sp,
            fontWeight = FontWeight.Black,
            modifier = Modifier.width(24.dp),
        )
        Avatar(
            url = row.user.avatarUrl,
            name = row.user.username,
            size = 30.dp,
            ringBrush = if (rank < 3) {
                Brush.linearGradient(listOf(WarningAmber, Color(0xFFFF6EC7)))
            } else {
                null
            },
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = row.user.username,
            color = OnDarkHigh,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        val rung = row.user.rank
        if (rung != null) {
            RankBadge(rank = rung, size = 18.dp)
            Spacer(Modifier.width(6.dp))
        }
        Text(
            text = "$glyph ${row.earned}",
            color = Cyan,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun RankTab(text: String, active: Boolean, onClick: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .height(30.dp)
            .clip(RoundedCornerShape(50))
            .background(if (active) Color(0xFF7C4DFF) else Color(0xFF241F3D))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp),
    ) {
        Text(text, color = OnDarkHigh, fontSize = 11.sp, fontWeight = if (active) FontWeight.Black else FontWeight.SemiBold)
    }
}
