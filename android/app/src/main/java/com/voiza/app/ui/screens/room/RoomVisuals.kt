package com.voiza.app.ui.screens.room

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import coil.compose.AsyncImage
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.LottieConstants
import com.airbnb.lottie.compose.animateLottieCompositionAsState
import com.airbnb.lottie.compose.rememberLottieComposition
import com.voiza.app.domain.model.DEFAULT_AMBIENT_EFFECT
import com.voiza.app.ui.components.asAssetUrl

// ---------------------------------------------------------------------------
// Room look. The backend generates one wallpaper and a set of Lottie overlays
// per theme slug (registry: backend/public/themes/manifest.json) and serves
// them from its own origin, so the app derives paths instead of shipping art.
// An unknown slug simply 404s and the plain gradient underneath shows through.
// ---------------------------------------------------------------------------

private const val WELCOME_ANIMATION = "/welcome.json"

/**
 * Theme wallpaper stretched over the room, with a scrim: every surface in the
 * room screen is translucent, so this has to stay readable at any brightness.
 */
@Composable
fun RoomWallpaper(theme: String?, modifier: Modifier = Modifier) {
    val slug = theme?.trim()?.takeIf { it.isNotEmpty() } ?: return
    Box(modifier = modifier.fillMaxSize()) {
        AsyncImage(
            model = "/themes/$slug/wallpaper.png".asAssetUrl(),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
        )
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        listOf(Color(0x73140D1F), Color(0xA6140D1F), Color(0xCC0B0714)),
                    )
                ),
        )
    }
}

/** Entry flourish, played once per join and drawn above the room content. */
@Composable
fun WelcomeEffect(onFinished: () -> Unit, modifier: Modifier = Modifier) {
    LottieOverlay(WELCOME_ANIMATION, iterations = 1, onFinished = onFinished, alpha = 1f, modifier = modifier)
}

/**
 * Quiet, endless loop behind the room. The URL is the server's choice for this
 * room's category, so a party and a music room do not wear the same effect.
 */
@Composable
fun AmbientRoomEffect(effectUrl: String?, modifier: Modifier = Modifier) {
    LottieOverlay(
        effectUrl ?: DEFAULT_AMBIENT_EFFECT,
        iterations = LottieConstants.IterateForever,
        onFinished = null,
        alpha = 0.45f,
        modifier = modifier,
    )
}

@Composable
private fun LottieOverlay(
    path: String,
    iterations: Int,
    onFinished: (() -> Unit)?,
    alpha: Float,
    modifier: Modifier = Modifier,
) {
    val url = path.asAssetUrl() ?: return
    val composition by rememberLottieComposition(LottieCompositionSpec.Url(url))
    // ignoreSystemAnimatorScale: these are content, not UI chrome. With the
    // system animator scale at 0 the library divides the speed by that scale,
    // which jumps every overlay to its final frame (invisible for overlays
    // whose last frame fades out).
    val progress by animateLottieCompositionAsState(
        composition,
        iterations = iterations,
        ignoreSystemAnimatorScale = true,
    )
    LottieAnimation(
        composition = composition,
        progress = { progress },
        modifier = modifier.fillMaxSize().alpha(alpha),
    )
    if (onFinished != null) {
        LaunchedEffect(composition, progress) {
            if (composition != null && progress >= 1f) onFinished()
        }
    }
}
