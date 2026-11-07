package com.voiza.app.ui.screens.room

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.components.rememberGiftSoundPlayer
import com.voiza.app.ui.screens.room.gifts.GiftRenderer

/**
 * Full-screen gift effect driven by the room:gift_animated queue in PartyRoomViewModel.
 *
 * Scheduling lives in RoomEffects and the art lives in ui/screens/room/gifts; this is the window
 * the queue plays in and the sound that rides with it. Which renderer opens the gift is the
 * catalogue row's decision, not this file's.
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
            LaunchedEffect(current) { soundPlayer.play(current.gift.soundUrl.asAssetUrl()) }
            GiftRenderer(
                event = current,
                animationUrl = (current.animationUrl ?: current.gift.animationUrl).asAssetUrl(),
                onFinished = { onFinished(current) },
            )
        }
    }
}
