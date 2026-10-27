package com.voiza.app.ui.screens.room

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.ChatMessage
import com.voiza.app.domain.model.MessageType
import com.voiza.app.ui.theme.OnDarkHigh

/**
 * Danmaku layer: messages that arrive *while the screen is open* fly
 * right-to-left over the seat area, the barrage style from the reference UI.
 * Nothing here is clickable, so seats underneath stay tappable.
 */
@Composable
fun BarrageOverlay(
    messages: List<ChatMessage>,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val lines = remember { mutableStateListOf<BarrageLine>() }
    // Id-keyed rather than size-keyed: the chat list is capped, so a size
    // comparison would silently stop the barrage once the cap is reached.
    var lastSeenId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(messages.lastOrNull()?.id) {
        val newest = messages.lastOrNull()?.id
        if (newest == null) return@LaunchedEffect
        if (lastSeenId == null) {
            // First frame: seed so join history never flies.
            lastSeenId = newest
            return@LaunchedEffect
        }
        if (newest == lastSeenId) return@LaunchedEffect
        val anchor = messages.indexOfLast { it.id == lastSeenId }
        val fresh = if (anchor >= 0) messages.subList(anchor + 1, messages.size) else messages.takeLast(1)
        fresh.take(MAX_LINES).forEach { msg ->
            val line = msg.toBarrageLine() ?: return@forEach
            if (lines.size >= MAX_LINES) lines.removeAt(0)
            lines.add(line)
        }
        lastSeenId = newest
    }

    if (!enabled) return

    Column(modifier = modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 6.dp)) {
        lines.forEach { line ->
            FlyingLine(line = line, onFinished = { lines.remove(line) })
        }
    }
}

private const val MAX_LINES = 4

/** Scroll speed in screen pixels per millisecond. */
private const val PX_PER_MS = 0.45f

private data class BarrageLine(
    val id: String,
    val text: String,
    val background: Color,
    val textColor: Color,
)

private fun ChatMessage.toBarrageLine(): BarrageLine? {
    val text = when (type) {
        MessageType.TEXT -> {
            val who = user?.username ?: return null
            "$who: $content"
        }
        else -> content
    }
    if (text.isBlank()) return null
    // Fills have to survive the dark room gradient, so the alpha is high and the
    // text colour is picked for contrast against the fill, not against the room.
    return when (type) {
        MessageType.GIFT -> BarrageLine(id, text, Color(0xCCFF6EC7), Color.White)
        MessageType.SYSTEM -> BarrageLine(id, text, Color(0xB322D3EE), Color(0xFF081018))
        MessageType.TEXT -> BarrageLine(id, text, Color(0xB30B0A1F), OnDarkHigh)
    }
}

@Composable
private fun FlyingLine(line: BarrageLine, onFinished: () -> Unit) {
    val progress = remember(line.id) { Animatable(0f) }
    var trackWidth by remember(line.id) { mutableFloatStateOf(0f) }
    var textWidth by remember(line.id) { mutableFloatStateOf(0f) }

    LaunchedEffect(trackWidth, line.id) {
        if (trackWidth <= 0f) return@LaunchedEffect
        val travel = (trackWidth + textWidth).toInt().coerceAtLeast(1)
        val duration = (travel / PX_PER_MS).toInt().coerceIn(2400, 9000)
        progress.animateTo(1f, tween(durationMillis = duration, easing = LinearEasing))
        onFinished()
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .onSizeChanged { trackWidth = it.width.toFloat() },
    ) {
        Text(
            text = line.text,
            color = line.textColor,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(line.background)
                .padding(horizontal = 10.dp, vertical = 4.dp)
                .onSizeChanged { textWidth = it.width.toFloat() }
                .graphicsLayer {
                    translationX = trackWidth - progress.value * (trackWidth + textWidth)
                },
        )
    }
}
