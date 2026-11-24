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
 * A short seat-to-seat flourish for every confirmed room gift. Coordinates mirror SeatGrid's
 * 3/4-column SpaceEvenly layout and its 104/88dp cells; no seat state or payment state is changed.
 */
@Composable
fun GiftFlightOverlay(
    events: List<GiftAnimatedEvent>,
    seats: List<Seat>,
    seatCentersInRoot: Map<Int, Offset> = emptyMap(),
    audienceCentersInRoot: Map<String, Offset> = emptyMap(),
    audienceFallbackCenterInRoot: Offset? = null,
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
        val wide = ordered.size > 9
        val columns = if (wide) 4 else 3
        val cell = if (wide) 88f else 104f
        val rowGap = if (wide) 10f else 14f
        val rowCount = (ordered.size + columns - 1) / columns
        val gridHeight = rowCount * cell + (rowCount - 1).coerceAtLeast(0) * rowGap
        val gridTop = ((height - gridHeight) / 2f).coerceAtLeast(0f)

        uniqueEvents.forEachIndexed { eventIndex, event ->
            val eventKey = event.eventId ?: "legacy-$eventIndex"
            val senderSeat = GiftFlightGeometry.senderSeat(ordered, event.sender.id)
            val receiverSeat = GiftFlightGeometry.receiverSeat(
                seats = ordered,
                receiverId = event.receiver.id,
                receiverSeatIndex = event.seatIndex,
                hostId = hostId,
            )

            // Prefer the actual Compose-measured cell centers. The old grid calculation remains a
            // first-frame fallback for the short interval before onGloballyPositioned reports.
            val measuredStartRoot = GiftFlightGeometry.senderCenterInRoot(
                senderId = event.sender.id,
                seats = ordered,
                seatCentersInRoot = seatCentersInRoot,
                audienceCentersInRoot = audienceCentersInRoot,
            ) ?: audienceFallbackCenterInRoot
            val measuredEndRoot = GiftFlightGeometry.receiverCenterInRoot(
                receiverId = event.receiver.id,
                seats = ordered,
                receiverSeatIndex = event.seatIndex,
                hostId = hostId,
                seatCentersInRoot = seatCentersInRoot,
                audienceCentersInRoot = audienceCentersInRoot,
            )
            val measuredStart = measuredStartRoot?.let {
                GiftFlightGeometry.toOverlayLocal(it, coordinateOriginInRoot, density)
            }
            val measuredEnd = measuredEndRoot?.let {
                GiftFlightGeometry.toOverlayLocal(it, coordinateOriginInRoot, density)
            }
            val fallbackStart = senderSeat?.let {
                seatCenter(it.seatIndex, ordered, columns, cell, rowGap, gridTop, width)
            } ?: (width / 2f to height * 0.88f)
            val fallbackEnd = receiverSeat?.let {
                seatCenter(it.seatIndex, ordered, columns, cell, rowGap, gridTop, width)
            } ?: (width / 2f to height * 0.12f)
            val start = measuredStart?.let { it.x to it.y } ?: fallbackStart
            val end = measuredEnd?.let { it.x to it.y } ?: fallbackEnd

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

private fun seatCenter(
    seatIndex: Int,
    seats: List<Seat>,
    columns: Int,
    cell: Float,
    rowGap: Float,
    gridTop: Float,
    width: Float,
): Pair<Float, Float> {
    val position = seats.indexOfFirst { it.seatIndex == seatIndex }.coerceAtLeast(0)
    val row = position / columns
    val rowStart = row * columns
    val rowSize = (seats.size - rowStart).coerceAtMost(columns).coerceAtLeast(1)
    val column = position - rowStart
    val x = (width + cell) * (column + 1f) / (rowSize + 1f) - cell / 2f
    val y = gridTop + row * (cell + rowGap) + cell / 2f
    return x to y
}
