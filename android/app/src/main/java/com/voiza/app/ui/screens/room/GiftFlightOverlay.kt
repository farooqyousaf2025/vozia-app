package com.voiza.app.ui.screens.room

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.zIndex
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.domain.model.Seat
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.VoizaBackground
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.sin

/**
 * A short sender-to-receiver flourish for every confirmed room gift. The layer spans the room root
 * so audience-strip anchors remain visible above the strip; no seat state or payment state changes.
 */
@Composable
fun GiftFlightOverlay(
    events: List<GiftAnimatedEvent>,
    seats: List<Seat>,
    seatCentersInRoot: Map<Int, Offset> = emptyMap(),
    audienceCentersInRoot: Map<String, Offset> = emptyMap(),
    audienceFallbackCenterInRoot: Offset? = null,
    seatLayerFallbackCenterInRoot: Offset? = null,
    coordinateOriginInRoot: Offset = Offset.Zero,
    hostId: String? = null,
    modifier: Modifier = Modifier,
) {
    val uniqueEvents = events.filterIndexed { index, event ->
        event.eventId == null || events.indexOfFirst { it.eventId == event.eventId } == index
    }
    BoxWithConstraints(modifier = modifier) {
        val width = maxWidth.value
        val height = maxHeight.value
        val density = LocalDensity.current.density
        val ordered = remember(seats) { seats.sortedBy { it.seatIndex } }

        uniqueEvents.forEachIndexed { eventIndex, event ->
            val eventKey = event.eventId ?: "legacy-$eventIndex"
            val senderSeat = GiftFlightGeometry.senderSeat(ordered, event.sender.id)
            val receiverSeat = GiftFlightGeometry.receiverSeat(
                seats = ordered,
                receiverId = event.receiver.id,
                receiverSeatIndex = event.seatIndex,
                hostId = hostId,
            )

            // Resolve actual anchors first. When a LazyRow avatar is off-screen, the strip center
            // is the honest fallback; a missing seat measurement falls back to the speaker area.
            val measuredStartRoot = GiftFlightGeometry.senderCenterInRoot(
                senderId = event.sender.id,
                seats = ordered,
                seatCentersInRoot = seatCentersInRoot,
                audienceCentersInRoot = audienceCentersInRoot,
            )
            val measuredEndRoot = GiftFlightGeometry.receiverCenterInRoot(
                receiverId = event.receiver.id,
                seats = ordered,
                receiverSeatIndex = event.seatIndex,
                hostId = hostId,
                seatCentersInRoot = seatCentersInRoot,
                audienceCentersInRoot = audienceCentersInRoot,
            )
            val fallbackStartRoot = GiftFlightGeometry.fallbackCenterInRoot(
                isSeated = senderSeat != null,
                audienceStripCenterInRoot = audienceFallbackCenterInRoot,
                seatLayerCenterInRoot = seatLayerFallbackCenterInRoot,
            )
            val fallbackEndRoot = GiftFlightGeometry.fallbackCenterInRoot(
                isSeated = receiverSeat != null,
                audienceStripCenterInRoot = audienceFallbackCenterInRoot,
                seatLayerCenterInRoot = seatLayerFallbackCenterInRoot,
            )
            val start = (measuredStartRoot ?: fallbackStartRoot)
                ?.let { GiftFlightGeometry.toOverlayLocal(it, coordinateOriginInRoot, density) }
                ?: (width / 2f to height * 0.88f)
            val end = (measuredEndRoot ?: fallbackEndRoot)
                ?.let { GiftFlightGeometry.toOverlayLocal(it, coordinateOriginInRoot, density) }
                ?: (width / 2f to height * 0.12f)

            var visible by remember(eventKey) { mutableStateOf(false) }
            val progress = remember(eventKey) { Animatable(0f) }

            LaunchedEffect(eventKey) {
                visible = true
                progress.snapTo(0f)
                progress.animateTo(1f, tween(900, easing = LinearOutSlowInEasing))
                delay(350)
                visible = false
            }

            if (visible) {
                val p = progress.value
                val x = start.first + (end.first - start.first) * p
                val arc = sin(PI.toFloat() * p) * 54f
                val y = start.second + (end.second - start.second) * p - arc
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .offset(x = (x - 25f).dp, y = (y - 25f).dp)
                        .size(50.dp)
                        .zIndex(20f)
                        .clip(CircleShape)
                        .background(
                            Brush.radialGradient(
                                listOf(Fuchsia.copy(alpha = 0.85f), DiamondGold.copy(alpha = 0.72f), VoizaBackground.copy(alpha = 0.92f))
                            )
                        )
                        .padding(5.dp),
                ) {
                    AsyncImage(
                        model = event.gift.iconUrl.asAssetUrl(),
                        contentDescription = "${event.gift.name} sent to ${event.receiver.username}",
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.size(38.dp),
                    )
                    if (event.quantity > 1) {
                        Text(
                            text = "×${event.quantity}",
                            color = OnDarkHigh,
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Black,
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .clip(CircleShape)
                                .background(VoizaBackground)
                                .padding(horizontal = 4.dp, vertical = 1.dp),
                        )
                    }
                }
            }
        }
    }
}

