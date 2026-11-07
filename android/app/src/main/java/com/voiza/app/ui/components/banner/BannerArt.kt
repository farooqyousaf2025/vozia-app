package com.voiza.app.ui.components.banner

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import coil.compose.AsyncImage
import com.airbnb.lottie.compose.LottieAnimation
import com.airbnb.lottie.compose.LottieCompositionSpec
import com.airbnb.lottie.compose.LottieConstants
import com.airbnb.lottie.compose.animateLottieCompositionAsState
import com.airbnb.lottie.compose.rememberLottieComposition
import com.voiza.app.domain.model.BannerFormat
import com.voiza.app.domain.model.PromoBanner
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.screens.room.gifts.SVGA_NO_ART
import com.voiza.app.ui.screens.room.gifts.SvgaArtLayer
import com.voiza.app.ui.screens.room.gifts.VideoArtLayer
import com.voiza.app.ui.screens.room.gifts.loadSvgaArt
import com.voiza.app.ui.screens.room.gifts.svga.SvgaPlayer

/**
 * One banner's art, opened by whichever renderer its format names.
 *
 * The format is the server's answer about the file's bytes, not a file extension: `media.service`
 * sniffs an upload and the operator declares the container on the row, so this is the gift engine's
 * routing again — plus the four stills a poster is usually made of, which is most of what a banner
 * actually is.
 *
 * A banner is not a gift or a ride: it has no screen to hand back, nobody is waiting on it to end and
 * the surface it sits on owns the clock. So every branch here keeps playing rather than finishing,
 * and none of them takes an `onFinished`.
 */
@Composable
internal fun BannerArt(banner: PromoBanner, modifier: Modifier = Modifier) {
    val url = banner.url.asAssetUrl() ?: return
    when (banner.format) {
        // A GIF or an animated WebP moves here because the process-wide ImageLoader in `VoizaApp`
        // registers Coil's animated decoder. Left on Coil's defaults this same call would draw the
        // first frame and stop, which is how a moving banner used to look like a still one.
        BannerFormat.PNG,
        BannerFormat.JPEG,
        BannerFormat.GIF,
        BannerFormat.WEBP,
        -> AsyncImage(
            model = url,
            contentDescription = banner.title.ifBlank { null },
            contentScale = ContentScale.Crop,
            modifier = modifier,
        )

        BannerFormat.LOTTIE -> LoopingLottieArt(url, modifier)
        BannerFormat.SVGA -> LoopingSvgaArt(url, modifier)
        BannerFormat.MP4 -> LoopingVideoArt(url, modifier)
    }
}

/** A Lottie scene on a loop, like the ambient art behind a room rather than a flourish that ends. */
@Composable
private fun LoopingLottieArt(url: String, modifier: Modifier) {
    val composition by rememberLottieComposition(LottieCompositionSpec.Url(url))
    val progress by animateLottieCompositionAsState(
        composition,
        // ignoreSystemAnimatorScale, for the reason every other overlay in this app gives: with the
        // device's animator scale at 0 the library jumps to the final frame, and a banner would show
        // one held pose of its own last second forever.
        iterations = LottieConstants.IterateForever,
        ignoreSystemAnimatorScale = true,
    )
    LottieAnimation(composition = composition, progress = { progress }, modifier = modifier)
}

/**
 * An MP4 on a loop.
 *
 * [VideoArtLayer] releases its player when it leaves composition, so a replay is a new player over the
 * same URL — cheap, because the platform reads the file itself rather than the app having buffered it.
 * The slot is the longest the server will ever declare, so it is the completion callback, not the
 * clock, that turns the clip over.
 */
@Composable
private fun LoopingVideoArt(url: String, modifier: Modifier) {
    var cycle by remember(url) { mutableIntStateOf(0) }
    key(cycle) {
        VideoArtLayer(
            url = url,
            slotMs = BANNER_SLOT_CEILING_MS,
            onFinished = { cycle++ },
            modifier = modifier,
        )
    }
}

/**
 * An SVGA scene played once, holding its last frame.
 *
 * Looping this container honestly would mean re-running [loadSvgaArt], and that downloads and decodes
 * the whole file again — a banner that re-fetches its own art every few seconds is worse than a scene
 * that settles. A gift and a ride never hit this because each plays its movie once and is dismissed by
 * the event that asked for it.
 */
@Composable
private fun LoopingSvgaArt(url: String, modifier: Modifier) {
    val loaded = remember(url) { mutableStateOf<Any?>(null) }
    LaunchedEffect(url) { loaded.value = loadSvgaArt(url) ?: SVGA_NO_ART }
    val player = loaded.value as? SvgaPlayer ?: return
    SvgaArtLayer(
        player = player,
        slotMs = BANNER_SLOT_CEILING_MS,
        onFinished = { },
        modifier = modifier,
    )
}

/** The server's own ceiling on `banners.duration_ms`, used wherever a file has no length to defer to. */
private const val BANNER_SLOT_CEILING_MS = 30_000L
