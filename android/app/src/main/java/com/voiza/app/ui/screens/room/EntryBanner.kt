package com.voiza.app.ui.screens.room

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.WorkspacePremium
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.UserJoinedEvent
import com.voiza.app.domain.usecase.RoomEffects
import com.voiza.app.ui.components.accentColor
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.RankBadge
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import kotlinx.coroutines.delay
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.VioletDark
import com.voiza.app.ui.theme.VioletLight
import com.voiza.app.ui.theme.VoizaSurfaceVariant
import com.voiza.app.ui.theme.WarningAmber

/**
 * "X joined the room", styled by how much X spends.
 *
 * The tier comes from `users.vip_level`, which an operator sets — so a fresh
 * account cannot give itself a bigger banner than a paying one. One banner at a
 * time: the ViewModel replaces the pending entry rather than stacking a list,
 * because a viewer reading three overlapping welcomes reads none of them.
 */
@Composable
fun EntryBanner(
    event: UserJoinedEvent?,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    AnimatedVisibility(
        visible = event != null,
        enter = slideInVertically(tween(220)) { it } + fadeIn(tween(180)),
        exit = fadeOut(tween(180)),
        modifier = modifier,
    ) {
        val joined = event ?: return@AnimatedVisibility
        val tier = RoomEffects.entryTier(joined.user.vipLevel)

        // Keyed on the person, so a new arrival restarts the clock but a
        // recomposition does not.
        LaunchedEffect(joined.user.id) {
            delay(RoomEffects.ENTRY_BANNER_MS)
            onDismiss()
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .then(
                    when (tier) {
                        2 -> Modifier.background(
                            Brush.horizontalGradient(listOf(WarningAmber, DiamondGold)),
                        )
                        1 -> Modifier.background(
                            Brush.horizontalGradient(listOf(VioletDark.copy(alpha = 0.90f), VioletLight.copy(alpha = 0.90f))),
                        )
                        else -> Modifier.background(VoizaSurfaceVariant.copy(alpha = 0.70f))
                    },
                )
                .padding(horizontal = 9.dp, vertical = 4.dp),
        ) {
            Avatar(
                url = joined.user.avatarUrl,
                name = joined.user.username,
                size = 26.dp,
                ringBrush = if (tier == 0) {
                    null
                } else {
                    Brush.linearGradient(listOf(DiamondGold, DiamondGold))
                },
                ringWidth = if (tier == 2) 3.dp else 2.dp,
                frame = joined.user.profileFrame,
            )
            Text(
                text = joined.user.username,
                color = OnDarkHigh,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = if (tier == 2) "arrives in style" else "joined the room",
                color = OnDarkHigh,
                fontSize = 11.sp,
                fontWeight = if (tier == 0) FontWeight.Normal else FontWeight.SemiBold,
                maxLines = 1,
            )
            joined.user.rank?.let { rung ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    RankBadge(rank = rung, size = 14.dp)
                    Text(
                        text = rung.name,
                        color = accentColor(rung.accent, OnDarkMedium),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                    )
                }
            }
            if (tier > 0) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.Default.WorkspacePremium,
                        contentDescription = null,
                        tint = if (tier == 2) DiamondGold else VioletLight,
                        modifier = Modifier.size(13.dp),
                    )
                    Text(
                        text = " VIP ${joined.user.vipLevel}",
                        color = if (tier == 2) DiamondGold else VioletLight,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Black,
                    )
                }
            }
        }
    }
}
