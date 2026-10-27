package com.voiza.app.ui.screens.room

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.voiza.app.domain.model.HeartSignal
import com.voiza.app.domain.usecase.RoomEffects
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.sin

/**
 * The floating hearts beside the like button.
 *
 * Own taps and inbound `room:liked` batches both arrive as a [HeartSignal], so a
 * viewer sees the same puff whether they tapped or someone across the world did.
 * Everything draws inside this box, so it never covers the buttons underneath.
 */
@Composable
fun HeartLayer(signal: HeartSignal, modifier: Modifier = Modifier) {
    val flying = remember { mutableStateListOf<FlyingHeart>() }
    var frameNanos by remember { mutableLongStateOf(0L) }
    var trackCursor by remember { mutableIntStateOf(0) }

    LaunchedEffect(signal.token) {
        if (signal.token == 0L || signal.hearts <= 0) return@LaunchedEffect
        repeat(signal.hearts.coerceAtMost(RoomEffects.HEART_MAX)) { index ->
            if (index > 0) delay(RoomEffects.HEART_STAGGER_MS)
            trackCursor = (trackCursor + 1) % TRACKS.size
            // Birth times come from the same clock the canvas reads, so a heart
            // never appears mid-flight on the first frame.
            flying.add(FlyingHeart(withFrameNanos { it }, trackCursor))
            while (flying.size > RoomEffects.HEART_MAX) flying.removeAt(0)
        }
    }

    // Drives frames only while something is in the air; an idle room costs none.
    LaunchedEffect(flying.isNotEmpty()) {
        while (flying.isNotEmpty()) {
            frameNanos = withFrameNanos { it }
            flying.removeAll { frameNanos - it.bornNanos >= HEART_LIFE_NANOS }
        }
    }

    Canvas(modifier) {
        flying.forEach { heart ->
            val t = (frameNanos - heart.bornNanos).toFloat() / HEART_LIFE_NANOS.toFloat()
            val sprite = SPRITES[heart.trackIndex % SPRITES.size]
            // One unit heart path, scaled per sprite and opened up as it climbs.
            val side = sprite.size.toPx() * (0.7f + 0.3f * t)
            val point = cubicPoint(TRACKS[heart.trackIndex], easeOut(t))
            val alpha = if (t < 0.12f) t / 0.12f else 1f - (t - 0.12f) / 0.88f * 0.85f
            withTransform({
                translate(size.width * point.x - side / 2f, size.height * point.y - side / 2f)
                scale(side, side, pivot = Offset.Zero)
                rotate(sin(t * PI.toFloat() * 2f) * 14f, pivot = Offset(0.5f, 0.5f))
            }) {
                drawPath(HEART_PATH, color = sprite.color, alpha = alpha)
            }
        }
    }
}

/** A heart in flight: when it was released and which track it took. */
private class FlyingHeart(val bornNanos: Long, val trackIndex: Int)

/**
 * Nine sprites (colour + size) so consecutive hearts are not clones; the 14dp
 * end of the range keeps the smallest one legible on a phone.
 */
private class Sprite(val color: Color, val size: Dp)

private val SPRITES = listOf(
    Sprite(Color(0xFFFF6EC7), 26.dp),
    Sprite(Color(0xFFFF4D6D), 20.dp),
    Sprite(Color(0xFFFFC94D), 17.dp),
    Sprite(Color(0xFF4DD0E1), 24.dp),
    Sprite(Color(0xFF7C4DFF), 19.dp),
    Sprite(Color(0xFFFFF3B0), 15.dp),
    Sprite(Color(0xFFE040FB), 22.dp),
    Sprite(Color(0xFF22D3EE), 18.dp),
    Sprite(Color(0xFFFFFFFF), 14.dp),
)

/**
 * Ten tracks, built from the index rather than random, so the arc a heart takes
 * is stable across recomposition. Control points are in unit space: x is the
 * layer's width and y runs 1 (bottom) up to the apex.
 */
private class Track(val start: Offset, val c1: Offset, val c2: Offset, val end: Offset)

private val TRACKS: List<Track> = (0 until 10).map { i ->
    val sway = if (i % 2 == 0) 1f else -1f
    val wide = 0.09f + 0.022f * (i % 5)
    Track(
        start = Offset(0.5f, 1f),
        c1 = Offset(0.5f + sway * wide, 0.74f),
        c2 = Offset(0.5f - sway * wide * 1.4f, 0.42f),
        end = Offset(0.5f + sway * wide * 0.7f, 0.06f + 0.035f * (i % 4)),
    )
}

private const val HEART_LIFE_NANOS = RoomEffects.HEART_LIFE_MS * 1_000_000L

private fun cubicPoint(track: Track, t: Float): Offset {
    val u = 1f - t
    return Offset(
        u * u * u * track.start.x + 3f * u * u * t * track.c1.x + 3f * u * t * t * track.c2.x + t * t * t * track.end.x,
        u * u * u * track.start.y + 3f * u * u * t * track.c1.y + 3f * u * t * t * track.c2.y + t * t * t * track.end.y,
    )
}

private fun easeOut(t: Float): Float = 1f - (1f - t) * (1f - t)

/** Unit heart, scaled to the sprite size at draw time. */
private val HEART_PATH = Path().apply {
    moveTo(0.5f, 0.94f)
    cubicTo(0.12f, 0.66f, 0.02f, 0.34f, 0.19f, 0.17f)
    cubicTo(0.34f, 0.02f, 0.5f, 0.14f, 0.5f, 0.3f)
    cubicTo(0.5f, 0.14f, 0.66f, 0.02f, 0.81f, 0.17f)
    cubicTo(0.98f, 0.34f, 0.88f, 0.66f, 0.5f, 0.94f)
    close()
}
