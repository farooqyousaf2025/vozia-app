package com.voiza.app.ui.screens.room

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.HeadsetMic
import androidx.compose.material.icons.filled.VoiceChat
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatStatus
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.VoizaSheet
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.GiftPink
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.WarningAmber

/**
 * Audience / co-host roster, opened by tapping the audience strip: who is on a
 * seat (with mic state), who is waiting in the request-to-speak queue, and who
 * is just listening.
 */
@Composable
fun AudienceListSheet(
    visible: Boolean,
    seats: List<Seat>,
    audience: List<MiniUser>,
    handRaises: List<MiniUser>,
    hostId: String?,
    onDismiss: () -> Unit,
) {
    if (!visible) return

    val seatedUsers = seats
        .filter { it.status == SeatStatus.OCCUPIED && it.user != null }
        .sortedBy { it.seatIndex }
    val seatedIds = seatedUsers.mapNotNull { it.user?.id }.toSet()
    // The socket audience snapshot includes seated members; the strip only
    // wants pure listeners.
    val listeners = audience.filterNot { it.id in seatedIds }

    VoizaSheet(
        visible = true,
        onDismiss = onDismiss,
        title = "In this room",
        subtitle = "${seatedUsers.size} on mic \u00B7 ${listeners.size} listening" +
            (if (handRaises.isNotEmpty()) " \u00B7 ${handRaises.size} waiting to speak" else ""),
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 360.dp),
        ) {
            if (seatedUsers.isNotEmpty()) {
                item { SectionHeader("On the mic", Icons.Default.GraphicEq, Mint) }
                items(seatedUsers, key = { "seat-${it.seatIndex}" }) { seat ->
                    PersonRow(
                        user = seat.user!!,
                        badge = seatLabel(seat, hostId),
                        badgeTint = if (seat.seatIndex == 0) WarningAmber else Cyan,
                        trailing = if (seat.isMuted) {
                            { MiniPill("muted", Color(0x33FF5B6E), Color(0xFFFF8FA0)) }
                        } else {
                            { MiniPill("live", Color(0x334DE0A0), Mint) }
                        },
                    )
                }
            }

            if (handRaises.isNotEmpty()) {
                item { SectionHeader("Waiting to speak", Icons.Default.VoiceChat, GiftPink) }
                items(handRaises, key = { "raise-${it.id}" }) { user ->
                    PersonRow(
                        user = user,
                        badge = "request",
                        badgeTint = GiftPink,
                        trailing = null,
                    )
                }
            }

            if (listeners.isNotEmpty()) {
                item { SectionHeader("Audience", Icons.Default.HeadsetMic, OnDarkMedium) }
                items(listeners, key = { "listener-${it.id}" }) { user ->
                    PersonRow(user = user, badge = null, badgeTint = OnDarkMedium, trailing = null)
                }
            } else if (handRaises.isEmpty() && seatedUsers.isEmpty()) {
                item {
                    Text(
                        text = "Nobody here yet.",
                        color = OnDarkMedium,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(vertical = 12.dp),
                    )
                }
            }
        }
    }
}

private fun seatLabel(seat: Seat, hostId: String?): String = when {
    seat.seatIndex == 0 || seat.user?.id == hostId -> "host"
    seat.isSpeaker -> "speaker"
    else -> "seat ${seat.seatIndex}"
}

@Composable
private fun SectionHeader(text: String, icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color) {
    Column {
        HorizontalDivider(color = Color(0x1FFFFFFF), modifier = Modifier.padding(vertical = 8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(imageVector = icon, contentDescription = null, tint = tint, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(6.dp))
            Text(
                text = text.uppercase(),
                color = OnDarkMedium,
                fontSize = 10.sp,
                fontWeight = FontWeight.Black,
                letterSpacing = 1.sp,
            )
        }
    }
}

@Composable
private fun PersonRow(
    user: MiniUser,
    badge: String?,
    badgeTint: Color,
    trailing: @Composable (() -> Unit)?,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 7.dp),
    ) {
        Avatar(url = user.avatarUrl, name = user.username, size = 34.dp)
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = user.username,
                color = OnDarkHigh,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (badge != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(5.dp)
                            .clip(CircleShape)
                            .background(badgeTint),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(text = badge, color = badgeTint, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
        if (trailing != null) trailing()
    }
}

@Composable
private fun MiniPill(text: String, background: Color, textColor: Color) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .height(22.dp)
            .width(56.dp)
            .clip(RoundedCornerShape(50))
            .background(background),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            Icon(
                imageVector = Icons.Default.FiberManualRecord,
                contentDescription = null,
                tint = textColor,
                modifier = Modifier.size(8.dp),
            )
            Spacer(Modifier.width(3.dp))
            Text(text = text, color = textColor, fontSize = 10.sp, fontWeight = FontWeight.Bold)
        }
    }
}
