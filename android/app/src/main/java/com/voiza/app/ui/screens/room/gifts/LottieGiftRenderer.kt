package com.voiza.app.ui.screens.room.gifts

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.animateLottieCompositionAsState
import com.airbnb.lottie.compose.rememberLottieComposition
import com.voiza.app.domain.model.GiftAnimatedEvent
import kotlinx.coroutines.delay

/** Generated Bodymovin overlay, played once end to end. */
@Composable
internal fun LottieGiftRenderer(
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
    // A slow or dead URL must not wedge the queue: the slot closes regardless, on the
    // catalogue's declared lifetime when it has one.
    LaunchedEffect(url, event.gift.durationMs) {
        delay(giftSlotMs(event, LOTTIE_MAX_MS))
        onFinished()
    }
}

/**
 * The ceiling for a Lottie the operator gave no lifetime. Generous enough for a composition that
 * renders late on a weak connection, short enough that a dead URL cannot hold the room's screen.
 */
internal const val LOTTIE_MAX_MS = 6_000L
