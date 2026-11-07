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
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material.icons.filled.PersonRemove
import androidx.compose.material.icons.filled.Radio
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.Relationship
import com.voiza.app.domain.model.ReportReason
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.VoizaSheet
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.GiftPink
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.WarningAmber
import com.voiza.app.ui.screens.home.voizaFieldColors

/**
 * Somebody else's card, opened by tapping a name in the room roster or holding a line of room chat:
 * the three verbs a member has over another account — follow, report, block.
 *
 * Nothing here decides an outcome. The rows come from `GET /api/users/:id/relationship`, so the
 * card offers the edge the server says exists rather than the one this screen assumes; a block is
 * the server closing an interaction both ways, and a report is a line in an operator's queue that
 * nobody on this phone can resolve.
 */
@Composable
fun MemberSheet(
    member: MiniUser,
    relationship: Relationship?,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onToggleFollow: () -> Unit,
    onOpenReport: () -> Unit,
    onToggleBlock: () -> Unit,
) {
    val blockedByMe = relationship?.blockedByMe == true
    // Either side holding the edge closes the same interactions, so a follow row is dead weight
    // while the server would refuse it.
    val interactionClosed = relationship?.interactionBlocked == true

    VoizaSheet(
        visible = true,
        onDismiss = onDismiss,
        title = member.username,
        subtitle = member.rank?.name ?: "Member",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            // The face the roster row was tapped on: three members can share a name in a room of
            // forty, and a block is not something to aim by username alone.
            Avatar(url = member.avatarUrl, name = member.username, size = 40.dp)
            if (relationship == null) {
                Text(
                    text = if (busy) "Loading…" else "Could not read your connection to this member.",
                    color = OnDarkMedium,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(vertical = 6.dp),
                )
            } else {
                ModerationRow(
                    icon = if (relationship.following) Icons.Default.PersonRemove else Icons.Default.PersonAdd,
                    tint = if (relationship.following) OnDarkMedium else Cyan,
                    title = if (relationship.following) "Unfollow" else "Follow",
                    subtitle = when {
                        interactionClosed -> "Blocked, so follows are refused in both directions"
                        relationship.following -> "You follow this member"
                        else -> "You do not follow this member yet"
                    },
                    enabled = !busy && !interactionClosed,
                    onClick = onToggleFollow,
                )
                ModerationRow(
                    icon = Icons.Default.Flag,
                    tint = WarningAmber,
                    title = "Report to the team",
                    // A block deliberately does not silence this row: the member who was blocked is
                    // often the one who needs the queue.
                    subtitle = "A person reviews it. It does not remove them.",
                    enabled = !busy,
                    onClick = onOpenReport,
                )
                if (blockedByMe) {
                    ModerationRow(
                        icon = Icons.Default.PersonAdd,
                        tint = Mint,
                        title = "Unblock",
                        subtitle = "Reopens gifts and follows between you",
                        enabled = !busy,
                        onClick = onToggleBlock,
                    )
                } else if (relationship.blockedByThem) {
                    Text(
                        text = "This member blocked you. Gifts and follows are closed until they undo it.",
                        color = OnDarkMedium,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
                    )
                } else {
                    ModerationRow(
                        icon = Icons.Default.PersonOff,
                        tint = Color(0xFFFF8FA0),
                        title = "Block",
                        subtitle = "Closes gifts and follows both ways. They stay in this room.",
                        danger = true,
                        enabled = !busy,
                        onClick = onToggleBlock,
                    )
                }
            }

            if (error != null) {
                Text(
                    text = error,
                    color = DangerRed,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
            }
        }
    }
}

/**
 * The complaint form. [onSubmit] hands over a reason and a note and nothing else: the reporter, the
 * target, the status and the outcome are all the server's to write, and a phone that could pick any
 * of them would be moderating its own queue.
 */
@Composable
fun ReportDialog(
    member: MiniUser,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSubmit: (ReportReason, String) -> Unit,
) {
    var reason by remember { mutableStateOf(ReportReason.HARASSMENT) }
    var details by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        containerColor = VoizaSurfaceHigh,
        title = {
            Text(text = "Report ${member.username}", color = OnDarkHigh, fontSize = 17.sp)
        },
        text = {
            Column {
                ReportReason.entries.forEach { option ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .clickable(enabled = !busy) { reason = option }
                            .padding(vertical = 6.dp, horizontal = 4.dp),
                    ) {
                        Icon(
                            imageVector = if (option == reason) Icons.Default.CheckCircle else Icons.Default.Radio,
                            contentDescription = null,
                            tint = if (option == reason) GiftPink else OnDarkMuted,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(
                            text = option.label,
                            color = if (option == reason) OnDarkHigh else OnDarkMedium,
                            fontSize = 14.sp,
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = details,
                    onValueChange = { details = it.take(MAX_REPORT_DETAILS) },
                    placeholder = { Text("What happened?", fontSize = 13.sp) },
                    minLines = 2,
                    colors = voizaFieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    text = "${details.length}/$MAX_REPORT_DETAILS",
                    color = OnDarkMedium,
                    fontSize = 11.sp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp),
                )
                if (error != null) {
                    Text(
                        text = error,
                        color = DangerRed,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = { onSubmit(reason, details.trim()) },
            ) {
                Text(
                    text = if (busy) "Sending…" else "Send",
                    color = if (busy) OnDarkMuted else GiftPink,
                    fontWeight = FontWeight.Bold,
                )
            }
        },
        dismissButton = {
            TextButton(enabled = !busy, onClick = onDismiss) {
                Text("Cancel", color = OnDarkMedium)
            }
        },
    )
}

/** The server's own ceiling on the note; a longer one is refused, not truncated in the queue. */
private const val MAX_REPORT_DETAILS = 500

@Composable
private fun ModerationRow(
    icon: ImageVector,
    tint: Color,
    title: String,
    subtitle: String,
    enabled: Boolean,
    danger: Boolean = false,
    onClick: () -> Unit,
) {
    val alpha = if (enabled) 1f else 0.45f
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(if (danger) Color(0x22FF5B6E) else Color(0xFF1B1740))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(32.dp)
                .clip(CircleShape)
                .background(if (danger) Color(0x33FF5B6E) else Color(0xFF241F3D)),
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = tint.copy(alpha = alpha),
                modifier = Modifier.size(16.dp),
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                color = if (danger) Color(0xFFFF8FA0) else OnDarkHigh,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.alpha(alpha),
            )
            Text(
                text = subtitle,
                color = OnDarkMedium,
                fontSize = 11.sp,
                modifier = Modifier.alpha(alpha),
            )
        }
    }
}
