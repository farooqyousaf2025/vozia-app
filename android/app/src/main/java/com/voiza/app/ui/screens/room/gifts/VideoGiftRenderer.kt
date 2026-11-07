package com.voiza.app.ui.screens.room.gifts

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.voiza.app.domain.model.GiftAnimatedEvent

/**
 * MP4 gift art: the video the operator uploaded, with who paid for it underneath.
 *
 * The decoder, its surface and both of its clocks live in [VideoArtLayer]; this adds the caption,
 * because a gift is the one scene the room has to attribute. A file the platform decoder rejects
 * still announces the send — the caption is drawn whether or not the picture arrives.
 */
@Composable
internal fun VideoGiftRenderer(
    event: GiftAnimatedEvent,
    url: String,
    onFinished: () -> Unit,
) {
    Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
        VideoArtLayer(
            url = url,
            slotMs = giftSlotMs(event, VIDEO_MAX_MS),
            onFinished = onFinished,
            modifier = Modifier.fillMaxSize(),
        )
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 56.dp),
        ) {
            GiftCaption(event)
        }
    }
}

/** Ceiling for a video that declares no lifetime in the catalogue. */
internal const val VIDEO_MAX_MS = 8_000L
