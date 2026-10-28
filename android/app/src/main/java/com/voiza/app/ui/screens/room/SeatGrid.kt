package com.voiza.app.ui.screens.room

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatStatus
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.SpeakingRing
import com.voiza.app.ui.components.SpeakingRingBrush
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.VoizaSeatRingGradient
import com.voiza.app.ui.theme.WarningAmber

/**
 * The seats this room has, host seat emphasised: slightly larger, permanent gradient
 * ring. The speaking ring is driven by LiveKit audio levels resolved per seat via the
 * occupant's user id (identity == user id).
 *
 * How many seats exist is the administrator's seat policy, so nothing here assumes a 3x3:
 * a wide room gets more columns and smaller cells instead of invisible speakers.
 */
@Composable
fun SeatGrid(
    seats: List<Seat>,
    speakingLevels: Map<String, Double>,
    onSeatClick: (Seat) -> Unit,
    modifier: Modifier = Modifier,
) {
    val ordered = seats.sortedBy { it.seatIndex }
    val wide = ordered.size > 9
    val cell = if (wide) 88.dp else SEAT_CELL
    val rows = ordered.chunked(if (wide) 4 else 3)

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(if (wide) 10.dp else 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        rows.forEach { row ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                row.forEach { seat ->
                    SeatCell(
                        seat = seat,
                        isHostSeat = seat.seatIndex == 0,
                        cell = cell,
                        level = seat.user?.id?.let { speakingLevels[it] } ?: 0.0,
                        onClick = { onSeatClick(seat) },
                    )
                }
            }
        }
    }
}

private val SEAT_CELL = 104.dp

@Composable
private fun SeatCell(
    seat: Seat,
    isHostSeat: Boolean,
    cell: androidx.compose.ui.unit.Dp,
    level: Double,
    onClick: () -> Unit,
) {
    val outer = if (isHostSeat) cell - 28.dp else cell - 40.dp
    val isSpeaking = level > 0.03 && seat.status == SeatStatus.OCCUPIED && !seat.isMuted

    Box(contentAlignment = Alignment.Center, modifier = Modifier.size(cell)) {
        // Speaking pulse sits behind everything.
        if (isSpeaking) {
            SpeakingRing(level = level, modifier = Modifier.size(outer + 20.dp))
        }

        // Host gets a standing gradient ring; speaking adds it for others.
        val ring: Brush? = when {
            isHostSeat -> VoizaSeatRingGradient
            isSpeaking -> SpeakingRingBrush
            else -> null
        }

        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(outer)) {
            Avatar(
                url = seat.user?.avatarUrl,
                name = seat.user?.username,
                size = outer,
                ringBrush = ring,
                ringWidth = if (isHostSeat) 3.dp else 2.5.dp,
                // The ring a member bought is drawn by the seat grid too, so a paid decoration is
                // visible where most people actually see each other.
                frame = seat.user?.profileFrame,
                fallbackBackground = when (seat.status) {
                    SeatStatus.EMPTY -> Color(0xFF1C1840)
                    SeatStatus.LOCKED -> Color(0xFF2A2459)
                    SeatStatus.OCCUPIED -> MaterialTheme.colorScheme.surfaceVariant
                },
                modifier = Modifier.clickable(onClick = onClick),
            )

            // Overlays
            when (seat.status) {
                SeatStatus.LOCKED -> OverlayIcon(Icons.Default.Lock, WarningAmber, outer)
                SeatStatus.OCCUPIED -> if (seat.isMuted) {
                    OverlayIcon(Icons.Default.MicOff, DangerTint, outer)
                } else {
                    OverlayIcon(Icons.Default.Mic, Mint, outer)
                }
                SeatStatus.EMPTY -> Unit
            }
        }

        // Seat index + name beneath
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(top = 2.dp),
        ) {
            Spacer(Modifier.height(2.dp))
            Text(
                text = seat.user?.username ?: "#${seat.seatIndex}",
                color = if (seat.user != null) OnDarkHigh else OnDarkMedium,
                fontSize = 10.sp,
                fontWeight = if (isHostSeat) FontWeight.Bold else FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(Color(0x99000000))
                    .padding(horizontal = 5.dp, vertical = 1.dp),
            )
        }
    }
}

@Composable
private fun OverlayIcon(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tint: Color,
    seatSize: androidx.compose.ui.unit.Dp,
) {
    Box(
        contentAlignment = Alignment.BottomEnd,
        modifier = Modifier.size(seatSize),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(20.dp)
                .clip(CircleShape)
                .background(Color(0xE6000000)),
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(12.dp),
            )
        }
    }
}

/** Crown pill for the host seat label row (used above the grid). */
@Composable
fun HostBadgeLabel(modifier: Modifier = Modifier) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(Color(0xFF38230F))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Icon(
            imageVector = Icons.Default.RecordVoiceOver,
            contentDescription = null,
            tint = OnDarkHigh,
            modifier = Modifier.size(12.dp),
        )
        Spacer(Modifier.width(4.dp))
        Text("HOST", color = OnDarkHigh, fontSize = 9.sp, fontWeight = FontWeight.Black)
    }
}

private val DangerTint = Color(0xFFFF5B6E)
