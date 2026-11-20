package com.voiza.app.ui.components.announcement

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.TickerEvent
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import kotlinx.coroutines.delay

/**
 * App-wide announcement ticker.
 *
 * Every connected socket receives `announcement:ticker` for a top-up, a recharge, a top ranker,
 * a game starting or a game winner. This overlay queues those lines and shows one at a time so a
 * burst of gifts or matches does not paint several banners over the same screen.
 */
@Composable
fun AnnouncementTicker(modifier: Modifier = Modifier) {
    var current by remember { mutableStateOf<TickerEvent?>(null) }
    var queue by remember { mutableStateOf(emptyList<TickerEvent>()) }

    LaunchedEffect(Unit) {
        ServiceLocator.socketClient.tickers.collect { event ->
            // The server may redeliver on reconnect; the id is the dedupe key the whole app uses.
            if (event.id == current?.id || queue.any { it.id == event.id }) return@collect
            if (current == null) current = event else queue = queue + event
        }
    }

    LaunchedEffect(current?.id) {
        if (current == null) return@LaunchedEffect
        delay(5_000)
        current = queue.firstOrNull()
        queue = queue.drop(1)
    }

    AnimatedVisibility(
        visible = current != null,
        enter = slideInVertically { -it } + fadeIn(),
        exit = slideOutVertically { -it } + fadeOut(),
        modifier = modifier,
    ) {
        current?.let { event ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .statusBarsPadding()
                    .padding(horizontal = 12.dp, vertical = 8.dp)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(VoizaSurfaceHigh)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.Campaign,
                    contentDescription = null,
                    tint = Cyan,
                )
                Text(
                    text = event.text,
                    color = OnDarkHigh,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
