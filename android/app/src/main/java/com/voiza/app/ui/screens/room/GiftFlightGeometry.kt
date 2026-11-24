package com.voiza.app.ui.screens.room

import androidx.compose.ui.geometry.Offset
import com.voiza.app.domain.model.Seat

/**
 * Seat identity and coordinate helpers for gift flights. Compose reports positions in root pixels;
 * the overlay needs local dp coordinates so its icon arrives at the actual avatar rather than an
 * estimated grid location.
 */
internal object GiftFlightGeometry {
    fun senderSeat(seats: List<Seat>, senderId: String): Seat? =
        seats.firstOrNull { it.user?.id == senderId }

    fun receiverSeat(
        seats: List<Seat>,
        receiverId: String,
        receiverSeatIndex: Int?,
        hostId: String?,
    ): Seat? {
        seats.firstOrNull { it.user?.id == receiverId }?.let { return it }
        receiverSeatIndex?.let { index ->
            seats.firstOrNull { it.seatIndex == index }?.let { return it }
        }
        // Seat zero is the permanent host slot. Use it only when the event really targets the host;
        // an unrelated audience recipient must never be animated to the host by accident.
        return if (receiverId == hostId) seats.firstOrNull { it.seatIndex == 0 } else null
    }

    fun toOverlayLocal(globalCenter: Offset, overlayOrigin: Offset, density: Float): Offset {
        require(density > 0f) { "Display density must be positive" }
        return (globalCenter - overlayOrigin) / density
    }
}
