package com.voiza.app.ui.screens.room.gifts

import android.media.MediaPlayer
import android.net.Uri
import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay

/**
 * One MP4 played from the first frame, on a surface of its own.
 *
 * `MediaPlayer` rather than a streaming player on purpose: the file is one short, operator-uploaded
 * clip that plays from the start and is gone in seconds, and the platform class needs no new
 * dependency in the app. It is muted because the sound of the moment is the caller's decision — a
 * gift plays the catalogue's own `soundUrl`, and two audios per event would be one too many.
 *
 * [slotMs] is the ceiling the caller owns: a gift hands over the lifetime from its catalogue row,
 * an entrance ride the lifetime from the ride it wears. It is the only clock when a decoder neither
 * completes nor errors, so a stalled frame cannot hold the screen past the scene that asked for it.
 */
@Composable
internal fun VideoArtLayer(
    url: String,
    slotMs: Long,
    onFinished: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    // Held as state because the file and the surface arrive in either order: preparing during the
    // first composition is normal, and so is the SurfaceView's holder landing a frame later.
    var prepared by remember(url) { mutableStateOf(false) }
    var failed by remember(url) { mutableStateOf(false) }
    val player = remember(url) { MediaPlayer() }
    var surface by remember(url) { mutableStateOf<SurfaceHolder?>(null) }

    DisposableEffect(url) {
        onDispose { player.release() }
    }

    LaunchedEffect(url) {
        try {
            player.setScreenOnWhilePlaying(true)
            player.setVideoScalingMode(MediaPlayer.VIDEO_SCALING_MODE_SCALE_TO_FIT)
            player.setVolume(0f, 0f)
            player.setOnPreparedListener { prepared = true }
            player.setOnCompletionListener { onFinished() }
            player.setOnErrorListener { _, _, _ -> failed = true; onFinished(); true }
            player.setDataSource(context, Uri.parse(url))
            player.prepareAsync()
        } catch (err: Exception) {
            // A file the decoder rejects is not a scene: the caller still has its caption, and the
            // room gets its screen back the same beat.
            failed = true
            onFinished()
        }
    }

    LaunchedEffect(prepared, failed, surface) {
        if (failed || !prepared) return@LaunchedEffect
        val holder = surface ?: return@LaunchedEffect
        player.setSurface(holder.surface)
        player.start()
    }

    LaunchedEffect(url, slotMs) {
        delay(slotMs)
        onFinished()
    }

    if (!failed) {
        AndroidView(
            factory = { ctx ->
                SurfaceView(ctx).apply {
                    holder.addCallback(object : SurfaceHolder.Callback {
                        override fun surfaceCreated(holder: SurfaceHolder) { surface = holder }
                        override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit
                        override fun surfaceDestroyed(holder: SurfaceHolder) { surface = null }
                    })
                }
            },
            modifier = modifier,
        )
    }
}
