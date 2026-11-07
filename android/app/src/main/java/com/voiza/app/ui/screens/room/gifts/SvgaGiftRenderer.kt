package com.voiza.app.ui.screens.room.gifts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.ui.screens.room.gifts.svga.SvgaPlayer
import com.voiza.app.ui.theme.OnDarkHigh
import kotlinx.coroutines.delay

/**
 * SVGA gift art: the format designers actually ship, played by the decoder in [SvgaArtLayer].
 *
 * The container itself is decoded by [com.voiza.app.ui.screens.room.gifts.svga] — see that package
 * for what owning that code costs. What is decided here is only what a *gift* adds around a movie:
 * the caption the room has to see, and the burst that stands in when there is no art to play.
 *
 * ### When the burst still plays
 *
 * A paid gift is announced even when its art is broken, so every one of these hands the slot to
 * [BurstGiftRenderer] with the icon the operator uploaded, and nothing about the sender, receiver,
 * quantity, combo or ledger totals changes:
 *
 *  * the URL is unreachable, non-2xx, or larger than the loader's ceiling — including a request the
 *    overlay itself cancelled;
 *  * the bytes are not an SVGA container at all, are truncated, or hold no sprites, no canvas size
 *    or no usable frame data;
 *  * every image in the file fails to decode.
 *
 * A file that parses but whose *individual* layer will not decode is not a fallback case: that
 * layer is dropped and the rest of the movie plays, because a partially-drawn gift is still the
 * gift the viewer paid for.
 *
 * ### The clocks
 *
 * Two of them, both bounded. The download gets [SVGA_LOAD_BUDGET_MS]; past that the burst takes
 * over, so a dead URL cannot hold the queue open. The animation itself then gets
 * `giftSlotMs(event, SVGA_MAX_MS)` — the catalogue's declared lifetime when it has one, exactly as
 * the Lottie and MP4 renderers use it. The slot starts when the art is ready rather than when the
 * gift arrives, so a two-second CDN round trip does not eat half of a five-second animation; the
 * price of that choice is that a slow download can stretch how long one gift owns the screen, which
 * is why the download budget is the shorter of the two.
 */
@Composable
internal fun SvgaGiftRenderer(
    event: GiftAnimatedEvent,
    url: String,
    onFinished: () -> Unit,
) {
    // null: still loading. SvgaPlayer: art to draw. SVGA_NO_ART: no art, burst instead.
    var art by remember(url) { mutableStateOf<Any?>(null) }

    LaunchedEffect(url) {
        art = loadSvgaArt(url) ?: SVGA_NO_ART
    }

    if (art == SVGA_NO_ART) {
        BurstGiftRenderer(event = event, onFinished = onFinished)
        return
    }

    val player = art as? SvgaPlayer
    if (player != null) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            SvgaArtLayer(
                player = player,
                slotMs = giftSlotMs(event, SVGA_MAX_MS),
                onFinished = onFinished,
                modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 48.dp),
            )
            GiftCaption(event)
        }
    } else {
        // A download that is simply slow, not yet past its budget, must not look like a blank
        // overlay forever: the burst owns this slot the moment the budget runs out.
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            // The art is still coming down the wire; the room is told who paid while it waits.
            WaitingCaption(
                event,
                "${event.gift.name} \u00D7 ${event.quantity}",
                Modifier.align(Alignment.BottomCenter).padding(bottom = 56.dp),
            )
        }
        LaunchedEffect(url) {
            delay(SVGA_LOAD_BUDGET_MS)
            if (art == null) art = SVGA_NO_ART
        }
    }
}

/**
 * The gift's own caption with the name of the art still to come printed above it.
 *
 * [GiftCaption] is what the room reads once the movie is on screen; while the file is downloading
 * there is nothing to attribute the send to, so the queue says the gift's name and count alone.
 */
@Composable
private fun WaitingCaption(event: GiftAnimatedEvent, label: String, modifier: Modifier = Modifier) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = modifier,
    ) {
        Text(text = label, color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        GiftCaption(event)
    }
}

/** Play ceiling for art the catalogue gave no lifetime to. */
internal const val SVGA_MAX_MS = 6_000L
