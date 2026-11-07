package com.voiza.app.ui.screens.room.gifts

import android.util.Log
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import com.voiza.app.ui.screens.room.gifts.svga.SvgaParseResult
import com.voiza.app.ui.screens.room.gifts.svga.SvgaParser
import com.voiza.app.ui.screens.room.gifts.svga.SvgaPlayer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * SVGA art, drawn by a decoder written for this app.
 *
 * There is no maintained SVGA library on any repository this build resolves from, and
 * `settings.gradle.kts` fails the build for anything else, so the container is decoded by the
 * [com.voiza.app.ui.screens.room.gifts.svga] package — which says plainly what owning that code
 * costs: vector layers, masks, matte layers and a file's own audio are not drawn, so art that
 * depends on them shows a flatter version of itself.
 *
 * A gift and an entrance ride both need this, and neither needs the other's caption, so the movie
 * and its clocks live here and each caller composes the words it owes the room around them.
 * [slotMs] is that caller's ceiling; [SvgaArtLayer] adds the frame clock of the movie itself, and
 * whichever ends first gives the screen back.
 */
@Composable
internal fun SvgaArtLayer(
    player: SvgaPlayer,
    slotMs: Long,
    onFinished: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val frameIndex = remember { mutableIntStateOf(0) }

    DisposableEffect(player) {
        onDispose { player.dispose() }
    }

    Canvas(modifier = modifier) {
        drawIntoCanvas { canvas -> player.draw(canvas.nativeCanvas, frameIndex.intValue) }
    }

    LaunchedEffect(player) {
        // The Compose frame clock, like every other animated overlay in this room: each pass waits
        // for a vsync, and the tick to draw falls out of the elapsed time rather than a per-frame
        // counter, so a dropped frame skips art rather than slowing it down.
        val startNanos = withFrameNanos { it }
        val frameNanos = (player.frameDurationMs * 1_000_000L).coerceAtLeast(1L)
        var tick = 0
        while (tick < player.frameCount) {
            frameIndex.intValue = tick
            val now = withFrameNanos { it }
            tick = ((now - startNanos) / frameNanos).toInt()
        }
        // Hold the last frame until the slot closes instead of vanishing a beat early.
        frameIndex.intValue = (player.frameCount - 1).coerceAtLeast(0)
        onFinished()
    }
    // The ceiling: a movie whose frame count lies, or a device that cannot get a vsync, must still
    // give the screen back.
    LaunchedEffect(player, slotMs) {
        delay(slotMs)
        onFinished()
    }
}

/**
 * Downloads, parses and decodes, off the main thread; null for any reason there is no art to play.
 *
 * The whole thing is one suspend call rather than a state machine because every step of it is a
 * candidate for failure and none of them are interesting to distinguish on screen.
 */
internal suspend fun loadSvgaArt(url: String): SvgaPlayer? {
    val bytes = try {
        withContext(Dispatchers.IO) { download(url) }
    } catch (error: Exception) {
        null
    } ?: return null
    return try {
        when (val parsed = SvgaParser.parse(bytes)) {
            is SvgaParseResult.Failure -> {
                Log.i(TAG, "svga art is not playable: ${parsed.reason}")
                null
            }
            is SvgaParseResult.Success -> withContext(Dispatchers.Default) {
                // prepare() decodes every sprite exactly once and says whether anything came back.
                SvgaPlayer(parsed.movie).takeIf { it.prepare() }
            }
        }
    } catch (error: Exception) {
        Log.w(TAG, "svga decode failed", error)
        null
    }
}

private suspend fun download(url: String): ByteArray? = suspendCancellableCoroutine { continuation ->
    val request = try {
        Request.Builder().url(url).build()
    } catch (error: Exception) {
        continuation.resume(null)
        return@suspendCancellableCoroutine
    }
    val call = httpClient.newCall(request)
    continuation.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (continuation.isActive) continuation.resume(null)
        }

        override fun onResponse(call: Call, response: Response) {
            response.use { reply ->
                val capped = if (!reply.isSuccessful) {
                    null
                } else {
                    try {
                        val body = reply.body
                        val declared = body?.contentLength() ?: -1L
                        if (declared > MAX_DOWNLOAD_BYTES) null
                        else body?.byteStream()?.readCapped(MAX_DOWNLOAD_BYTES)
                    } catch (error: Exception) {
                        null
                    }
                }
                if (continuation.isActive) continuation.resume(capped)
            }
        }
    })
}

/** Reads a response with a ceiling on it, so a bad `Content-Length` cannot be the only guard. */
private fun InputStream.readCapped(limit: Long): ByteArray? {
    val out = ByteArrayOutputStream(64 * 1024)
    val buffer = ByteArray(64 * 1024)
    use { source ->
        while (true) {
            val read = source.read(buffer)
            if (read < 0) break
            if (out.size().toLong() + read > limit) return null
            out.write(buffer, 0, read)
        }
    }
    return if (out.size() == 0) null else out.toByteArray()
}

/**
 * A client of its own, built once per process.
 *
 * This art is a public asset, and the app's shared client attaches the session token and logs
 * bodies — neither belongs on a request to a CDN, and neither is what the Lottie and MP4 paths do
 * with a URL either, since those hand it to a library that fetches it itself. The timeouts are
 * short because an animation is small and the room is live.
 */
private val httpClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .callTimeout(8, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
}

/** Sentinel for "no art", which a `null` player cannot tell apart from "still loading". */
internal val SVGA_NO_ART = Any()

/** How long a download may take before the caller gives up on the art it was waiting for. */
internal const val SVGA_LOAD_BUDGET_MS = 3_000L

/** SVGA files are megabytes; anything bigger is not one and is not worth decoding. */
private const val MAX_DOWNLOAD_BYTES = 24L * 1024L * 1024L

private const val TAG = "SvgaArt"
