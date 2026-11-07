package com.voiza.app.ui.screens.room

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.EntryRide
import com.voiza.app.domain.model.GiftAnimationFormat
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.screens.room.gifts.LOTTIE_MAX_MS
import com.voiza.app.ui.screens.room.gifts.SVGA_LOAD_BUDGET_MS
import com.voiza.app.ui.screens.room.gifts.SVGA_MAX_MS
import com.voiza.app.ui.screens.room.gifts.SVGA_NO_ART
import com.voiza.app.ui.screens.room.gifts.SvgaArtLayer
import com.voiza.app.ui.screens.room.gifts.VideoArtLayer
import com.voiza.app.ui.screens.room.gifts.VIDEO_MAX_MS
import com.voiza.app.ui.screens.room.gifts.animationSlotMs
import com.voiza.app.ui.screens.room.gifts.loadSvgaArt
import com.voiza.app.ui.screens.room.gifts.svga.SvgaPlayer
import com.voiza.app.ui.theme.OnDarkHigh
import kotlinx.coroutines.delay

/**
 * The entrance cinematic a member arrives with, played over the room.
 *
 * Nothing here decides what a ride is. The server resolved the member's worn key against the store's
 * rows and put the file, the container and the ceiling on their join payload as `entryRide`, so this
 * opens that file in the renderer its own format names and holds the screen for as long as the
 * operator said. A member who owns nothing arrives with no `entryRide` at all: their banner still
 * announces them, and there is no free ride here to dress the moment.
 *
 * It is drawn in the room's own layer, under [GiftEffectOverlay]'s dialog, because a gift is what the
 * room is watching right now — an arrival that collides with one waits for it rather than covering
 * it up.
 */
@Composable
fun EntryRideOverlay(
    ride: EntryRide,
    username: String,
    avatarUrl: String?,
    onFinished: () -> Unit,
) {
    val url = ride.url.asAssetUrl()
    if (url == null) {
        // The server sent a ride with no file in it, which the mapper should already have dropped.
        // Give the screen straight back rather than holding a dark overlay for a slot nobody plays.
        LaunchedEffect(ride.key) { onFinished() }
        return
    }
    Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize().background(Color(0x66000000))) {
        RideArtLayer(
            format = ride.format,
            url = url,
            durationMs = ride.durationMs,
            onFinished = onFinished,
        )
        ArrivingLine(
            ride = ride,
            username = username,
            avatarUrl = avatarUrl,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 56.dp)
                .clip(RoundedCornerShape(50))
                .background(Color(0xB3140D1F))
                .padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

/**
 * A ride's file, opened in the renderer its container names and held for the slot its row declares.
 *
 * The room overlay and the shop's preview both need exactly this — the same routing and the same
 * ceiling — so neither can disagree about how long an arrival lasts. The format and the duration are
 * the server's answers about the uploaded bytes; nothing here reads a file extension.
 */
@Composable
internal fun RideArtLayer(
    format: GiftAnimationFormat,
    url: String,
    durationMs: Int,
    onFinished: () -> Unit,
    modifier: Modifier = Modifier.fillMaxSize(),
) {
    val slotMs = animationSlotMs(durationMs, ceilingMsFor(format))
    when (format) {
        GiftAnimationFormat.LOTTIE -> TimedEntryEffect(url = url, slotMs = slotMs, onFinished = onFinished, modifier = modifier)
        GiftAnimationFormat.MP4 -> VideoArtLayer(url = url, slotMs = slotMs, onFinished = onFinished, modifier = modifier)
        GiftAnimationFormat.SVGA -> RideSvgaArt(
            url = url,
            slotMs = slotMs,
            onFinished = onFinished,
            modifier = modifier.padding(horizontal = 24.dp, vertical = 48.dp),
        )
    }
}

/**
 * The SVGA ride: the same decoder a gift uses, with nothing standing in when the art does not come.
 *
 * A broken gift animation still plays the generated burst because somebody paid for that gift. A
 * ride is a decoration the arriving member bought for themselves, and the line at the foot of the
 * overlay already says who arrived — so a file that will not open simply does not open, and the
 * overlay hands the screen back.
 */
@Composable
private fun RideSvgaArt(url: String, slotMs: Long, onFinished: () -> Unit, modifier: Modifier) {
    // null: still loading. SvgaPlayer: art to draw. SVGA_NO_ART: nothing to play.
    var art by remember(url) { mutableStateOf<Any?>(null) }

    LaunchedEffect(url) {
        art = loadSvgaArt(url) ?: SVGA_NO_ART
    }

    if (art == SVGA_NO_ART) {
        LaunchedEffect(url) { onFinished() }
        return
    }

    val player = art as? SvgaPlayer
    if (player != null) {
        SvgaArtLayer(
            player = player,
            slotMs = slotMs,
            onFinished = onFinished,
            modifier = modifier,
        )
    } else {
        // A download that is merely slow is not a scene either: the budget bounds how long the room
        // can be covered by an overlay that has shown nothing yet.
        LaunchedEffect(url) {
            delay(SVGA_LOAD_BUDGET_MS)
            if (art == null) art = SVGA_NO_ART
        }
    }
}

/** Who the room is watching, and what they paid to arrive in. */
@Composable
private fun ArrivingLine(ride: EntryRide, username: String, avatarUrl: String?, modifier: Modifier = Modifier) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = modifier,
    ) {
        Avatar(url = avatarUrl, name = username, size = 26.dp)
        Text(
            text = "$username arrives in ",
            color = OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Text(ride.name, color = Color(0xFFFFF3B0), fontSize = 12.sp, fontWeight = FontWeight.Black)
    }
}

/**
 * The ceiling for a ride whose row declares no lifetime, per container.
 *
 * Each number is the one the matching gift renderer already holds for the same format, so an
 * operator who uploads the same file twice — once as a gift, once as a ride — gets it cut off at the
 * same beat either way.
 */
private fun ceilingMsFor(format: GiftAnimationFormat): Long = when (format) {
    GiftAnimationFormat.LOTTIE -> LOTTIE_MAX_MS
    GiftAnimationFormat.SVGA -> SVGA_MAX_MS
    GiftAnimationFormat.MP4 -> VIDEO_MAX_MS
}
