package com.voiza.app.ui.components

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/**
 * Plays the short effect that a gift carries (`gifts.sound_url`) over the voice
 * room. Sounds are one-shots under a second, so a fresh MediaPlayer per event is
 * cheaper than pooling and keeps the state machine trivial.
 */
class GiftSoundPlayer(private val context: Context) {
    private val audio: AudioManager = context.getSystemService(AudioManager::class.java)
    private var player: MediaPlayer? = null
    private var focus: AudioFocusRequest? = null

    fun play(url: String?) {
        val target = url?.takeIf { it.isNotBlank() } ?: return
        stop()
        duckOthers()
        player = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    // Sonification: the platform may lower its own volumes for it,
                    // and it never wakes the screen or counts as media playback.
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            setOnPreparedListener { start() }
            // A broken or offline sound URL must not look like a failed gift: the
            // overlay is visual, so the audio error is swallowed here on purpose.
            setOnErrorListener { _, _, _ -> true }
            setOnCompletionListener { stop() }
            isLooping = false
            try {
                setDataSource(target)
                prepareAsync()
            } catch (_: Exception) {
                stop()
            }
        }
    }

    fun stop() {
        player?.run {
            try {
                if (isPlaying) stop()
            } catch (_: IllegalStateException) {
                // Already released or never prepared; nothing to stop.
            }
            release()
        }
        player = null
        unduck()
    }

    /**
     * LiveKit drives the room audio, so this only asks the system to lower
     * everything else for the length of the effect. API 26+ has the typed focus
     * request; on older devices the sound simply plays at media volume.
     */
    private fun duckOthers() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            .build()
        focus = request
        audio.requestAudioFocus(request)
    }

    private fun unduck() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        focus?.let { audio.abandonAudioFocusRequest(it) }
        focus = null
    }
}

/** Tied to the overlay's lifetime so leaving the room cannot leave a sound playing. */
@Composable
fun rememberGiftSoundPlayer(): GiftSoundPlayer {
    val context = LocalContext.current
    val giftSound = remember(context) { GiftSoundPlayer(context) }
    DisposableEffect(giftSound) {
        onDispose { giftSound.stop() }
    }
    return giftSound
}
