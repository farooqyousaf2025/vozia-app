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
// Room look. Every URL here is the server's: themes and Lottie loops are rows an
// operator maintains in the database (room_themes / visual_effects, migration
// 0015), and art added from the admin panel lives in the upload store at
// /uploads/<uuid>.png. A client that turned a theme slug into a path would 404
// on work that exists, so nothing in this file derives anything.
// A null URL means there is nothing to draw and the gradient underneath shows.
// ---------------------------------------------------------------------------

/**
 * Theme wallpaper stretched over the room, with a scrim: every surface in the
 * room screen is translucent, so this has to stay readable at any brightness.
 */
@Composable
fun RoomWallpaper(wallpaperUrl: String?, modifier: Modifier = Modifier) {
    val url = wallpaperUrl.asAssetUrl() ?: return
    Box(modifier = modifier.fillMaxSize()) {
        AsyncImage(
            model = url,
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

/**
 * Entry flourish, played once per join and drawn above the room content. Named by
 * `GET /api/rooms/themes`, so retiring it is an operator's decision rather than a release.
 */
@Composable
fun WelcomeEffect(welcomeUrl: String?, onFinished: () -> Unit, modifier: Modifier = Modifier) {
    LottieOverlay(welcomeUrl, iterations = 1, onFinished = onFinished, alpha = 1f, modifier = modifier)
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
    path: String?,
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
