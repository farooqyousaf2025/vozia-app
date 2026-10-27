package com.voiza.app.ui.screens.room

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.domain.usecase.RoomEffects
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.OnDarkHigh
import kotlinx.coroutines.delay

/**
 * The quiet half of the gift effects: a rose or a lollipop scrolls past here
 * instead of covering the room. Three rows deep, oldest leaves first, and each
 * row removes itself from the ViewModel list when its slot expires.
 */
@Composable
fun GiftTickerColumn(
    events: List<GiftAnimatedEvent>,
    onFinished: (GiftAnimatedEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (events.isEmpty()) return
    Column(
        verticalArrangement = Arrangement.spacedBy(6.dp),
        horizontalAlignment = Alignment.Start,
        modifier = modifier.width(186.dp),
    ) {
        events.forEach { event ->
            LaunchedEffect(event) {
                delay(RoomEffects.GIFT_DISMISS_MS)
                onFinished(event)
            }
            AnimatedVisibility(
                visible = true,
                enter = slideInHorizontally(tween(260)) { -it / 3 } + fadeIn(tween(220)),
            ) {
                TickerRow(event)
            }
        }
    }
}

@Composable
private fun TickerRow(event: GiftAnimatedEvent) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(Brush.horizontalGradient(listOf(Color(0xE62A2459), Color(0xB3151233))))
            .padding(horizontal = 8.dp, vertical = 5.dp),
    ) {
        Avatar(url = event.sender.avatarUrl, name = event.sender.username, size = 22.dp)
        Box(contentAlignment = Alignment.Center) {
            Box(
                modifier = Modifier
                    .size(26.dp)
                    .clip(CircleShape)
                    .background(Color(0x40FFFFFF)),
            )
            AsyncImage(
                model = event.gift.iconUrl.asAssetUrl(),
                contentDescription = event.gift.name,
                contentScale = ContentScale.Fit,
                modifier = Modifier.size(22.dp),
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = event.sender.username,
                color = OnDarkHigh,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = "${event.gift.name} \u00D7${event.quantity} \u2192 ${event.receiver.username}",
                color = Cyan,
                fontSize = 9.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            text = "\u2756 ${event.totalDiamonds}",
            color = Color(0xFFFFF3B0),
            fontSize = 10.sp,
            fontWeight = FontWeight.Black,
        )
    }
}
