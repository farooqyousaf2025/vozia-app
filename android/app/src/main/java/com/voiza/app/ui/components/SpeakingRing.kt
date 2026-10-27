package com.voiza.app.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.Fuchsia

/**
 * Animated pulse ring behind seat content while a participant is speaking.
 * [level] is the LiveKit audio level (0.0..1.0); the ring amplitude scales
 * with it so louder voices glow bigger. Renders nothing when idle.
 */
@Composable
fun SpeakingRing(
    level: Double,
    modifier: Modifier = Modifier,
) {
    if (level <= IDLE_THRESHOLD) return

    val transition = rememberInfiniteTransition(label = "speaking")
    val progress by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1100),
            repeatMode = RepeatMode.Restart,
        ),
        label = "speakingProgress",
    )
    // Amplitude follows the live level, clamped so quiet voices still show.
    val amplitude = (0.35f + level.toFloat().coerceIn(0f, 1f) * 0.65f)

    Box(modifier = modifier.fillMaxSize()) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val maxRadius = size.minDimension / 2f
            // Stroke has no alpha parameter across Compose versions, so the fade
            // rides on the gradient colours instead.
            val ringAlpha = (1f - progress).coerceIn(0f, 1f)
            val ringBrush = Brush.sweepGradient(
                listOf(
                    Fuchsia.copy(alpha = ringAlpha),
                    Cyan.copy(alpha = ringAlpha),
                    Fuchsia.copy(alpha = ringAlpha),
                ),
            )

            // Expanding pulse ring.
            drawArc(
                brush = ringBrush,
                startAngle = 0f,
                sweepAngle = 360f * (1f - progress),
                useCenter = false,
                topLeft = androidx.compose.ui.geometry.Offset(
                    (size.width - maxRadius * 2f * amplitude) / 2f,
                    (size.height - maxRadius * 2f * amplitude) / 2f,
                ),
                size = Size(maxRadius * 2f * amplitude, maxRadius * 2f * amplitude),
                style = androidx.compose.ui.graphics.drawscope.Stroke(
                    width = (2.5f + 3f * (1f - progress) * amplitude).dp.toPx(),
                ),
            )
            // Steady inner halo while voicing.
            drawCircle(
                color = Color(0x33E040FB),
                radius = maxRadius * 0.78f * amplitude,
            )
        }
    }
}

private const val IDLE_THRESHOLD = 0.02
