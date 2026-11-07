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
import com.voiza.app.domain.model.SpeakerRequest
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
 *
 * The host gets two more things here, because this is the one screen that shows the whole room at
 * once. A request in [speakerQueue] can be seated or declined — that list is the server's queue and
 * only the host is allowed to read it — and a listener can be invited to a free seat without asking
 * first. Both write through the same endpoints the rest of the room moderates with; nothing here
 * decides who ends up on the mic.
 */
@Composable
fun AudienceListSheet(
    visible: Boolean,
    seats: List<Seat>,
    audience: List<MiniUser>,
    handRaises: List<MiniUser>,
    speakerQueue: List<SpeakerRequest>,
    hostId: String?,
    isHost: Boolean,
    invitableSeatIndex: Int?,
    onDismiss: () -> Unit,
    onApprove: (SpeakerRequest) -> Unit,
    onReject: (SpeakerRequest) -> Unit,
    onInvite: (String) -> Unit,
    onOpenMember: (String) -> Unit,
) {
    if (!visible) return

    val seatedUsers = seats
        .filter { it.status == SeatStatus.OCCUPIED && it.user != null }
        .sortedBy { it.seatIndex }
    val seatedIds = seatedUsers.mapNotNull { it.user?.id }.toSet()
    // The socket audience snapshot includes seated members; the strip only
    // wants pure listeners.
    val listeners = audience.filterNot { it.id in seatedIds }
    val waiting = handRaises.filterNot { it.id in seatedIds }
    // A host with the approval switch off sees the hand-raise list rather than a queue. The two
    // come from different places on the server — a column on the participant row and a table the
    // host answers — so only one of them has anything in it for a given room.
    val waitingCount = speakerQueue.size + waiting.size
    val canInvite = isHost && invitableSeatIndex != null

    VoizaSheet(
        visible = true,
        onDismiss = onDismiss,
        title = "In this room",
        subtitle = "${seatedUsers.size} on mic \u00B7 ${listeners.size} listening" +
            (if (waitingCount > 0) " \u00B7 $waitingCount waiting to speak" else ""),
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
                        onClick = { seat.user?.let { member -> onOpenMember(member.id) } },
                    )
                }
            }

            if (speakerQueue.isNotEmpty()) {
                item { SectionHeader("Requests to speak", Icons.Default.VoiceChat, GiftPink) }
                // Server order, which is the order the requests arrived. Re-sorting this screen by
                // anything the phone likes would let a loud newcomer jump a queue the room is waiting on.
                items(speakerQueue, key = { "request-${it.id}" }) { request ->
                    PersonRow(
                        user = request.user,
                        badge = "asked for seat ${request.seatIndex}",
                        badgeTint = GiftPink,
                        trailing = null,
                        action = if (isHost) {
                            {
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    QueueButton(
                                        text = "Decline",
                                        background = Color(0x33FF5B6E),
                                        tint = Color(0xFFFF8FA0),
                                        onClick = { onReject(request) },
                                    )
                                    QueueButton(
                                        text = "Seat",
                                        background = Color(0x334DE0A0),
                                        tint = Mint,
                                        onClick = { onApprove(request) },
                                    )
                                }
                            }
                        } else {
                            null
                        },
                        onClick = request.user?.let { asked -> { onOpenMember(asked.id) } },
                    )
                }
            }

            if (waiting.isNotEmpty()) {
                item { SectionHeader("Waiting to speak", Icons.Default.VoiceChat, GiftPink) }
                items(waiting, key = { "raise-${it.id}" }) { user ->
                    PersonRow(
                        user = user,
                        badge = "request",
                        badgeTint = GiftPink,
                        trailing = null,
                        // A hand raise is not a queue row, so there is nothing to decline: seating
                        // them is the host's whole answer, and it goes through the invite endpoint.
                        action = if (canInvite) {
                            {
                                QueueButton(
                                    text = "Invite up",
                                    background = Color(0x334DE0A0),
                                    tint = Mint,
                                    onClick = { onInvite(user.id) },
                                )
                            }
                        } else {
                            null
                        },
                        onClick = { onOpenMember(user.id) },
                    )
                }
            }

            if (listeners.isNotEmpty()) {
                item { SectionHeader("Audience", Icons.Default.HeadsetMic, OnDarkMedium) }
                items(listeners, key = { "listener-${it.id}" }) { user ->
                    PersonRow(
                        user = user,
                        badge = null,
                        badgeTint = OnDarkMedium,
                        trailing = null,
                        action = if (canInvite) {
                            {
                                QueueButton(
                                    text = "Invite",
                                    background = Color(0x335BC8FF),
                                    tint = Cyan,
                                    onClick = { onInvite(user.id) },
                                )
                            }
                        } else {
                            null
                        },
                        onClick = { onOpenMember(user.id) },
                    )
                }
            } else if (waiting.isEmpty() && speakerQueue.isEmpty() && seatedUsers.isEmpty()) {
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

/**
 * [user] is nullable because a request outlives the account that filed it: the server still lists
 * the row, so the queue shows it with no name rather than dropping someone's ask off the host's
 * screen. [action] is the host's half of the row — nothing on this sheet tells a member they can be
 * invited, because they cannot invite themselves. [onClick] opens that member's own card; a row with
 * no account behind it has nothing to open.
 */
@Composable
private fun PersonRow(
    user: MiniUser?,
    badge: String?,
    badgeTint: Color,
    trailing: (@Composable () -> Unit)?,
    action: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(vertical = 7.dp),
    ) {
        Avatar(url = user?.avatarUrl, name = user?.username, size = 34.dp)
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = user?.username ?: "Former member",
                color = if (user == null) OnDarkMedium else OnDarkHigh,
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
        if (action != null) {
            action()
            Spacer(Modifier.width(8.dp))
        }
        if (trailing != null) trailing()
    }
}

@Composable
private fun QueueButton(
    text: String,
    background: Color,
    tint: Color,
    onClick: () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .height(26.dp)
            .clip(RoundedCornerShape(50))
            .background(background)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp),
    ) {
        Text(text = text, color = tint, fontSize = 11.sp, fontWeight = FontWeight.Bold)
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
