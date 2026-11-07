package com.voiza.app.ui.screens.room

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.voiza.app.domain.model.EmojiOption
import com.voiza.app.domain.model.ReactionSignal
import com.voiza.app.domain.usecase.RoomEffects
import com.voiza.app.ui.components.asAssetUrl
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.sin

// ---------------------------------------------------------------------------
// Quick reactions.
//
// Both halves of this feature trust the same server decision. A tap emits the emoji's *key* and
// nothing else; `room:reaction` comes back carrying the art the operator has published for that key
// right now, which is what every device in the room animates. So a viewer cannot fly a picture the
// platform never approved into somebody else's room, and a retired code simply stops being offered.
// Nothing here is stored: a reaction is decoration, not a ledger line.
// ---------------------------------------------------------------------------

/**
 * The emoji a viewer can fly, straight from `GET /api/emoji` in the picker order the operator set.
 * An empty catalogue draws no row, and there is nothing to tap.
 */
@Composable
fun ReactionStrip(
    emojis: List<EmojiOption>,
    onReaction: (EmojiOption) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (emojis.isEmpty()) return
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier.padding(horizontal = 16.dp, vertical = 2.dp),
    ) {
        emojis.take(RoomEffects.REACTION_STRIP_MAX).forEach { option ->
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .size(34.dp)
                    .clip(CircleShape)
                    .background(Color(0x66241F3D))
                    .clickable { onReaction(option) },
            ) {
                AsyncImage(
                    model = option.url.asAssetUrl(),
                    contentDescription = option.label,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.size(24.dp),
                )
            }
        }
    }
}

/**
 * The burst of art that flies up the room after a tap, whether the tap was ours or somebody else's.
 *
 * Sprites follow the same tracks as [HeartLayer] so a puff of emoji and a puff of hearts read as one
 * language. Unlike hearts these are network images, so each one is a real node rather than a path
 * drawn on a canvas — which is why the motion is expressed in `offset {}` and `graphicsLayer {}`
 * lambdas: a new frame re-places and re-draws the sprites without recomposing them, and Coil serves
 * the same picture for the whole flight. The layer has no clickable child, so it never covers the
 * chat it floats over.
 */
@Composable
fun ReactionLayer(signal: ReactionSignal, modifier: Modifier = Modifier) {
    val flying = remember { mutableStateListOf<FlyingReaction>() }
    var frameNanos by remember { mutableLongStateOf(0L) }
    var trackCursor by remember { mutableIntStateOf(0) }
    var area by remember { mutableStateOf(IntSize.Zero) }
    val spritePx = with(LocalDensity.current) { REACTION_SIZE.toPx() }

    LaunchedEffect(signal.token) {
        val emoji = signal.emoji ?: return@LaunchedEffect
        repeat(RoomEffects.REACTIONS_PER_TAP) { index ->
            if (index > 0) delay(RoomEffects.REACTION_STAGGER_MS)
            trackCursor = (trackCursor + 1) % TRACKS.size
            // Birth times come from the same clock the placement reads, so a sprite never appears
            // already mid-flight on its first frame.
            flying.add(FlyingReaction(withFrameNanos { it }, trackCursor, emoji))
            while (flying.size > RoomEffects.REACTION_MAX) flying.removeAt(0)
        }
    }

    // Drives frames only while something is in the air; an idle room costs none.
    LaunchedEffect(flying.isNotEmpty()) {
        while (flying.isNotEmpty()) {
            frameNanos = withFrameNanos { it }
            flying.removeAll { frameNanos - it.bornNanos >= REACTION_LIFE_NANOS }
        }
    }

    Box(modifier.onSizeChanged { area = it }) {
        flying.forEach { reaction ->
            AsyncImage(
                model = reaction.emoji.url.asAssetUrl(),
                contentDescription = reaction.emoji.label,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .size(REACTION_SIZE)
                    .offset {
                        val point = cubicPoint(TRACKS[reaction.trackIndex], easeOut(reaction.at(frameNanos)))
                        IntOffset(
                            ((point.x * area.width) - spritePx / 2f).toInt(),
                            ((point.y * area.height) - spritePx / 2f).toInt(),
                        )
                    }
                    .graphicsLayer {
                        val t = reaction.at(frameNanos)
                        alpha = if (t < BIRTH_FRACTION) t / BIRTH_FRACTION
                        else 1f - (t - BIRTH_FRACTION) / (1f - BIRTH_FRACTION) * 0.85f
                        // Grows into place rather than appearing at full size, so a burst seen from
                        // the edge of the strip still reads as art leaving it.
                        scaleX = 0.55f + 0.45f * t
                        scaleY = scaleX
                        rotationZ = sin(t * PI.toFloat() * 2f) * 12f
                    },
            )
        }
    }
}

/** A reaction in flight: when it was released, which track it took, and the art it carries. */
private class FlyingReaction(val bornNanos: Long, val trackIndex: Int, val emoji: EmojiOption) {

    /** How far through its flight this sprite is: 0 at release, 1 as it leaves. */
    fun at(frameNanos: Long): Float =
        ((frameNanos - bornNanos).toFloat() / REACTION_LIFE_NANOS.toFloat()).coerceIn(0f, 1f)
}

private val REACTION_LIFE_NANOS = RoomEffects.REACTION_LIFE_MS * 1_000_000L

/** Fixed so the sprite's centre can be found in the placement lambda above. */
private val REACTION_SIZE = 32.dp

/** The share of the flight spent fading in; the rest fades out, as in [HeartLayer]. */
private const val BIRTH_FRACTION = 0.12f
