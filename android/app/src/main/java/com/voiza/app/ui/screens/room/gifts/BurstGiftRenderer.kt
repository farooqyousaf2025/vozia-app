package com.voiza.app.ui.screens.room.gifts

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.GiftPink
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.WarningAmber
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/**
 * The renderer with no art file: a generated burst around the gift's own icon.
 *
 * This is what the room sees for a gift whose catalogue row has no animation, and for a format
 * Android has no player for yet — the send was paid for, so the room is told who sent what, with
 * the icon the operator uploaded, rather than watching a blank overlay time out.
 */
@Composable
internal fun BurstGiftRenderer(
    event: GiftAnimatedEvent,
    onFinished: () -> Unit,
) {
    // Master timeline: 0f -> 1f across the gift's slot; particles and the sprite
    // derive their transforms from it so everything stays in sync.
    val progress = remember { Animatable(0f) }
    val burstSeed = remember { Random(System.currentTimeMillis()) }
    val slotMs = remember(event) { giftSlotMs(event, DEFAULT_BURST_MS) }

    LaunchedEffect(event, slotMs) {
        progress.snapTo(0f)
        progress.animateTo(
            targetValue = 1f,
            animationSpec = tween(durationMillis = slotMs.toInt(), easing = LinearEasing),
        )
        onFinished()
    }

    Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val p = progress.value
            val cx = size.width / 2f
            val cy = size.height / 2f
            repeat(PARTICLE_COUNT) { i ->
                val angle = (i * 137.5f + burstSeed.nextFloat() * 40f) * PI.toFloat() / 180f
                val maxR = size.minDimension * (0.28f + burstSeed.nextFloat() * 0.26f)
                val r = maxR * p.coerceIn(0f, 1f)
                val x = cx + cos(angle) * r
                val y = cy + sin(angle) * r * 0.8f - size.height * 0.06f * p
                val alpha = (1f - p).coerceIn(0f, 1f) * 0.9f
                val radius = (2.5f + burstSeed.nextFloat() * 4f) * (1f - p * 0.6f)
                drawCircle(
                    color = when (i % 3) {
                        0 -> GiftPink.copy(alpha = alpha)
                        1 -> Cyan.copy(alpha = alpha)
                        else -> WarningAmber.copy(alpha = alpha)
                    },
                    radius = radius,
                    center = Offset(x, y),
                )
            }
        }

        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.padding(bottom = 40.dp),
        ) {
            AnimatedVisibility(
                visible = progress.value < 0.94f,
                enter = fadeIn(tween(180)) + scaleIn(initialScale = 0.4f, animationSpec = tween(320)),
                exit = fadeOut(tween(220)) + scaleOut(targetScale = 1.3f, animationSpec = tween(220)),
            ) {
                val lift = progress.value
                Box(contentAlignment = Alignment.Center) {
                    Canvas(modifier = Modifier.size(190.dp)) {
                        drawCircle(
                            brush = Brush.radialGradient(
                                listOf(GiftPink.copy(alpha = 0.45f * (1f - lift * 0.5f)), Color.Transparent),
                            ),
                            radius = size.minDimension / 2f,
                        )
                    }
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier
                            .size(150.dp)
                            .offset(y = liftOffset(progress.value)),
                    ) {
                        AsyncImage(
                            model = event.gift.iconUrl.asAssetUrl(),
                            contentDescription = event.gift.name,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.size(110.dp),
                        )
                        Text(
                            text = "${event.gift.name} \u00D7 ${event.quantity}",
                            color = OnDarkHigh,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
            }

            AnimatedVisibility(
                visible = progress.value > 0.06f,
                enter = fadeIn(tween(240)) + scaleIn(initialScale = 0.85f),
                exit = fadeOut(tween(200)),
            ) {
                GiftBanner(event)
            }

            GiftValueLine(event)
        }
    }
}

/** Sprite lift curve: rises ~90dp over the timeline with an ease-out feel. */
private fun liftOffset(lift: Float): Dp = (-90f * (1f - (1f - lift) * (1f - lift))).dp

/** A generated burst has no file to report its own length, so the gift that declares nothing gets this. */
private const val DEFAULT_BURST_MS = 2_600L
private const val PARTICLE_COUNT = 26
