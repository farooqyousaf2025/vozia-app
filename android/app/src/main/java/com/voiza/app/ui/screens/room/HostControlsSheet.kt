package com.voiza.app.ui.screens.room

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatStatus
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.VoizaSheet
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.WarningAmber
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaSurfaceVariant

/**
 * Host-only sheet for one seat: lock/unlock, mute/unmute occupant, kick.
 * All actions hit the host-restricted REST endpoints; the returned seats
 * snapshot updates the grid.
 */
@Composable
fun HostControlsSheet(
    seat: Seat?,
    isHost: Boolean,
    onDismiss: () -> Unit,
    onToggleLock: (Seat, Boolean) -> Unit,
    onToggleMute: (Seat, Boolean) -> Unit,
    onKick: (Seat) -> Unit,
) {
    var confirmKick by remember(seat?.seatIndex) { mutableStateOf(false) }
    if (seat == null || !isHost) return
    VoizaSheet(
        visible = true,
        onDismiss = onDismiss,
        title = "Seat ${seat.seatIndex}",
        subtitle = seat.user?.username ?: "Empty seat",
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(VoizaSurfaceHigh)
                .padding(horizontal = 10.dp, vertical = 8.dp),
        ) {
            if (seat.user != null) {
                Avatar(url = seat.user.avatarUrl, name = seat.user.username, size = 36.dp)
                Spacer(Modifier.width(10.dp))
            }
            Text(
                text = when (seat.status) {
                    SeatStatus.OCCUPIED -> {
                        val who = seat.user?.username ?: "User"
                        if (seat.isSpeaker) "$who is speaking from this seat" else "$who is on this seat"
                    }
                    SeatStatus.LOCKED -> "Seat is locked"
                    SeatStatus.EMPTY -> "Nobody here yet"
                },
                color = OnDarkMedium,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
            )
        }

        Spacer(Modifier.size(12.dp))

        if (seat.status != SeatStatus.EMPTY) {
            val locked = seat.status == SeatStatus.LOCKED
            ControlRow(
                icon = if (locked) Icons.Default.LockOpen else Icons.Default.Lock,
                tint = WarningAmber,
                title = if (locked) "Unlock seat" else "Lock seat",
                subtitle = if (locked) "Anyone can take this seat" else "Only you can change this seat",
                onClick = { onToggleLock(seat, !locked) },
            )
        }

        if (seat.status == SeatStatus.OCCUPIED) {
            ControlRow(
                icon = if (seat.isMuted) Icons.Default.Mic else Icons.Default.MicOff,
                tint = OnDarkHigh,
                title = if (seat.isMuted) "Unmute occupant" else "Mute occupant",
                subtitle = if (seat.isMuted) "They will be able to speak again" else "Silences their LiveKit track",
                onClick = { onToggleMute(seat, !seat.isMuted) },
            )
            ControlRow(
                icon = Icons.Default.PersonOff,
                tint = DangerRed,
                title = "Kick from seat",
                subtitle = "Back to the audience, seat freed",
                danger = true,
                onClick = { confirmKick = true },
            )
        }
    }

    if (confirmKick && seat != null) {
        AlertDialog(
            onDismissRequest = { confirmKick = false },
            title = { Text("Kick " + (seat.user?.username ?: "this member") + "?") },
            text = { Text("They will return to the audience. Their account and room history are not deleted.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmKick = false
                    onKick(seat)
                    onDismiss()
                }) { Text("Kick") }
            },
            dismissButton = {
                TextButton(onClick = { confirmKick = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun ControlRow(
    icon: ImageVector,
    tint: Color,
    title: String,
    subtitle: String,
    danger: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (danger) DangerRed.copy(alpha = 0.13f) else VoizaSurfaceHigh)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(32.dp)
                .clip(CircleShape)
                .background(if (danger) DangerRed.copy(alpha = 0.20f) else VoizaSurfaceVariant),
        ) {
            Icon(imageVector = icon, contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.width(12.dp))
        androidx.compose.foundation.layout.Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                color = if (danger) DangerRed.copy(alpha = 0.90f) else OnDarkHigh,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = subtitle,
                color = OnDarkMedium,
                fontSize = 11.sp,
            )
        }
        Text(
            text = "\u203A",
            color = OnDarkMedium,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Preview(showBackground = true, name = "Host controls (occupied seat)")
@Composable
fun HostControlsSheetPreview() {
    HostControlsSheet(
        seat = Seat(
            seatIndex = 2,
            status = SeatStatus.OCCUPIED,
            isMuted = false,
            isSpeaker = true,
            user = MiniUser(id = "member-2", username = "Mira", avatarUrl = null),
        ),
        isHost = true,
        onDismiss = {},
        onToggleLock = { _, _ -> },
        onToggleMute = { _, _ -> },
        onKick = {},
    )
}

@Preview(showBackground = true, name = "Host controls (locked seat)")
@Composable
fun HostControlsSheetLockedPreview() {
    HostControlsSheet(
        seat = Seat(
            seatIndex = 5,
            status = SeatStatus.LOCKED,
            isMuted = false,
            isSpeaker = false,
            user = null,
        ),
        isHost = true,
        onDismiss = {},
        onToggleLock = { _, _ -> },
        onToggleMute = { _, _ -> },
        onKick = {},
    )
}

