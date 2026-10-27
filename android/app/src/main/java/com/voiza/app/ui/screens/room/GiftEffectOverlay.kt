package com.voiza.app.ui.screens.room

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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.animateLottieCompositionAsState
import com.airbnb.lottie.compose.rememberLottieComposition
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.GiftSoundPlayer
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.components.rememberGiftSoundPlayer
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.GiftPink
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.WarningAmber
import kotlinx.coroutines.delay
import kotlin.random.Random

/**
 * Full-screen gift effect driven by the room:gift_animated queue in
 * PartyRoomViewModel. When the gift carries a Lottie `animationUrl` the
 * generated overlay plays and the sender banner rides along at the bottom;
 * without one, the Compose fallback paints a particle burst around the icon.
 */
@Composable
fun GiftEffectOverlay(
    queue: List<GiftAnimatedEvent>,
    onFinished: (GiftAnimatedEvent) -> Unit,
) {
    val current = queue.firstOrNull() ?: return

    // One overlay at a time; DialogProperties prevents touch stealing from chat.
    Dialog(
        onDismissRequest = { onFinished(current) },
        properties = DialogProperties(
            dismissOnBackPress = true,
            dismissOnClickOutside = true,
            usePlatformDefaultWidth = false,
        ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0x66000000)),
            contentAlignment = Alignment.Center,
        ) {
            // The player is remembered per overlay: a gift sound is a one-shot, and
            // disposing the dialog must not leave it playing into the room.
            val soundPlayer = rememberGiftSoundPlayer()
            GiftAnimation(event = current, soundPlayer = soundPlayer, onFinished = { onFinished(current) })
        }
    }
}

@Composable
private fun GiftAnimation(
    event: GiftAnimatedEvent,
    soundPlayer: GiftSoundPlayer,
    onFinished: () -> Unit,
) {
    // The sound rides the overlay, so it starts with the animation and is
    // abandoned with it (a skipped overlay must not leave a chime hanging).
    LaunchedEffect(event) { soundPlayer.play(event.gift.soundUrl.asAssetUrl()) }

    val animationUrl = (event.animationUrl ?: event.gift.animationUrl).asAssetUrl()
    if (animationUrl != null) {
        LottieGift(event = event, url = animationUrl, onFinished = onFinished)
    } else {
        BurstGift(event = event, onFinished = onFinished)
    }
}

/** Generated overlay from the backend, played once end to end. */
@Composable
private fun LottieGift(
    event: GiftAnimatedEvent,
    url: String,
    onFinished: () -> Unit,
) {
    val composition by rememberLottieComposition(LottieCompositionSpec.Url(url))
    // iterations defaults to 1: a gift overlay plays exactly once.
    // ignoreSystemAnimatorScale because a 0 animator scale makes the library
    // divide the speed by it, which would end the overlay on the first frame.
    val progress by animateLottieCompositionAsState(
        composition,
        ignoreSystemAnimatorScale = true,
    )

    Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
        LottieAnimation(
            composition = composition,
            progress = { progress },
            modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 48.dp),
        )
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 56.dp),
        ) {
            AnimatedVisibility(visible = progress > 0.06f, enter = fadeIn(tween(240))) {
                GiftBanner(event)
            }
            GiftValueLine(event)
        }
    }

    LaunchedEffect(composition, progress) {
        if (composition != null && progress >= 1f) onFinished()
    }
    // A slow or dead URL must not wedge the queue: cap the slot regardless.
    LaunchedEffect(url) {
        delay(LOTTIE_MAX_MS)
        onFinished()
    }
}

private const val LOTTIE_MAX_MS = 6_000L

@Composable
private fun BurstGift(
    event: GiftAnimatedEvent,
    onFinished: () -> Unit,
) {
    // Master timeline: 0f -> 1f across DURATION_MS; particles and the sprite
    // derive their transforms from it so everything stays in sync.
    val progress = remember { Animatable(0f) }
    val burstSeed = remember { Random(System.currentTimeMillis()) }

    LaunchedEffect(event) {
        progress.snapTo(0f)
        progress.animateTo(
            targetValue = 1f,
            animationSpec = tween(durationMillis = DURATION_MS, easing = LinearEasing),
        )
        onFinished()
    }

    Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
        // Particle burst layer.
        Canvas(modifier = Modifier.fillMaxSize()) {
            val p = progress.value
            val cx = size.width / 2f
            val cy = size.height / 2f
            val count = PARTICLE_COUNT
            repeat(count) { i ->
                val angle = (i * 137.5f + burstSeed.nextFloat() * 40f) * kotlin.math.PI.toFloat() / 180f
                val maxR = size.minDimension * (0.28f + burstSeed.nextFloat() * 0.26f)
                val r = maxR * p.coerceIn(0f, 1f)
                val x = cx + kotlin.math.cos(angle) * r
                val y = cy + kotlin.math.sin(angle) * r * 0.8f - size.height * 0.06f * p
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
            // Gift sprite: rises + grows then fades with the timeline.
            AnimatedVisibility(
                visible = progress.value < 0.94f,
                enter = fadeIn(tween(180)) + scaleIn(initialScale = 0.4f, animationSpec = tween(320)),
                exit = fadeOut(tween(220)) + scaleOut(targetScale = 1.3f, animationSpec = tween(220)),
            ) {
                val lift = progress.value
                Box(contentAlignment = Alignment.Center) {
                    // Glow disc behind the icon.
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

            // Sender -> receiver banner.
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

@Composable
private fun GiftBanner(event: GiftAnimatedEvent) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(
                Brush.horizontalGradient(
                    listOf(Fuchsia.copy(alpha = 0.85f), Cyan.copy(alpha = 0.85f))
                )
            )
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Avatar(url = event.sender.avatarUrl, name = event.sender.username, size = 26.dp)
        Text(
            text = " ${event.sender.username} sent ",
            color = OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = "${event.gift.name} \u00D7${event.quantity} ",
            color = Color(0xFFFFF3B0),
            fontSize = 12.sp,
            fontWeight = FontWeight.Black,
        )
        Text(text = "to ", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Avatar(url = event.receiver.avatarUrl, name = event.receiver.username, size = 26.dp)
        Text(
            text = " ${event.receiver.username}",
            color = OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/** Diamonds spent / R-coins earned. */
@Composable
private fun GiftValueLine(event: GiftAnimatedEvent) {
    Text(
        // \u2756 diamond, \u25C9 coin
        text = "\u2756 ${event.totalDiamonds} \u2192 \u25C9 ${event.totalRCoins}",
        color = Cyan.copy(alpha = 0.9f),
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
    )
}

/** Sprite lift curve: rises ~90dp over the timeline with an ease-out feel. */
private fun liftOffset(lift: Float): androidx.compose.ui.unit.Dp =
    (-90f * (1f - (1f - lift) * (1f - lift))).dp

private const val DURATION_MS = 2600
private const val PARTICLE_COUNT = 26
