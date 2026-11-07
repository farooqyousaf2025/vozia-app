package com.voiza.app.ui.screens.room.gifts

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.domain.model.GiftAnimationFormat
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.OnDarkHigh

/**
 * The gift engine's one door to a paid animation.
 *
 * The format is the catalogue's, chosen by the backend from the bytes that were uploaded — not
 * from a file name — so the file at [animationUrl] is only guaranteed to open in the renderer this
 * `when` picks. A gift with no animation file is not a broken gift: it was paid for and the room
 * still has to see it, so it plays through the generated burst around the icon.
 */
@Composable
fun GiftRenderer(
    event: GiftAnimatedEvent,
    animationUrl: String?,
    onFinished: () -> Unit,
) {
    if (animationUrl == null) {
        BurstGiftRenderer(event = event, onFinished = onFinished)
        return
    }
    when (event.gift.animationFormat) {
        GiftAnimationFormat.MP4 -> VideoGiftRenderer(event = event, url = animationUrl, onFinished = onFinished)
        GiftAnimationFormat.SVGA -> SvgaGiftRenderer(event = event, url = animationUrl, onFinished = onFinished)
        GiftAnimationFormat.LOTTIE -> LottieGiftRenderer(event = event, url = animationUrl, onFinished = onFinished)
    }
}

/**
 * How long the room hands the screen to one paid animation.
 *
 * The declared lifetime is the operator's answer, in the same row as the art, and it is the only
 * clock a scene has when the file itself never reports an end — a video that stalls on a black
 * frame, or a remote Lottie JSON that never arrived. A gift reads it from its catalogue row and a
 * ride from the store row it wears; [fallbackMs] is each caller's own ceiling, used for the honest
 * zero that means "play it for its own length" and for a number no renderer should hold a room to.
 */
internal fun animationSlotMs(declaredMs: Int, fallbackMs: Long): Long =
    if (declaredMs in MIN_SLOT_MS..MAX_SLOT_MS) declaredMs.toLong() else fallbackMs

internal fun giftSlotMs(event: GiftAnimatedEvent, fallbackMs: Long): Long =
    animationSlotMs(event.gift.durationMs, fallbackMs)

/** Shorter than this is a blink; longer than an operator should hand one animation the screen. Matches the admin panel. */
private const val MIN_SLOT_MS = 250
private const val MAX_SLOT_MS = 30_000

/** Who paid for what, over the animation. Renderers own the screen, so this rides at the bottom. */
@Composable
fun GiftCaption(event: GiftAnimatedEvent) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        GiftBanner(event)
        GiftValueLine(event)
    }
}

@Composable
fun GiftBanner(event: GiftAnimatedEvent) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(
                Brush.horizontalGradient(
                    listOf(Fuchsia.copy(alpha = 0.85f), Cyan.copy(alpha = 0.85f))
                )
            )
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Avatar(url = event.sender.avatarUrl, name = event.sender.username, size = 26.dp)
        Text(
            text = " ${event.sender.username} sent ",
            color = OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = "${event.gift.name} \u00D7${event.quantity} ",
            color = Color(0xFFFFF3B0),
            fontSize = 12.sp,
            fontWeight = FontWeight.Black,
        )
        Text(text = "to ", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Avatar(url = event.receiver.avatarUrl, name = event.receiver.username, size = 26.dp)
        Text(
            text = " ${event.receiver.username}",
            color = OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
        GiftComboBadge(event)
    }
}

/** Diamonds spent / R-coins earned, both as the ledger recorded them, plus what a box rolled. */
@Composable
fun GiftValueLine(event: GiftAnimatedEvent) {
    Text(
        // \u2756 diamond, \u25C9 coin. A box names its own prize first, because that is the number
        // the room is reacting to; the credit either side of the arrow is what the draw paid.
        text = buildString {
            event.lucky?.headline?.let { append("LUCKY ${it.label}  ") }
            append("\u2756 ${event.totalDiamonds} \u2192 \u25C9 ${event.totalRCoins}")
        },
        color = Cyan.copy(alpha = 0.9f),
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
    )
}

/**
 * The server's combo tally, shown while a repeat send is being counted.
 *
 * Nothing is added up here: each event arrives with its window's running count already on it, so a
 * device that reconnects mid-combo reads what the room read, and taps that never reached the
 * server never appear on screen. [compact] is the ticker's smaller type.
 */
@Composable
fun GiftComboBadge(event: GiftAnimatedEvent, compact: Boolean = false) {
    if (event.comboId == null || event.comboCount <= 1) return
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .padding(start = if (compact) 4.dp else 6.dp)
            .clip(RoundedCornerShape(percent = if (compact) 30 else 50))
            .background(Color(0xFFFFD24D))
            .padding(horizontal = 7.dp, vertical = if (compact) 1.dp else 3.dp),
    ) {
        Text(
            text = "COMBO \u00D7${event.comboCount}",
            color = Color(0xFF2A1B00),
            fontSize = if (compact) 8.sp else 11.sp,
            fontWeight = FontWeight.Black,
        )
    }
}
