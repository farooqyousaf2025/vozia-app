package com.voiza.app.ui.screens.room

import androidx.compose.ui.geometry.Offset
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class GiftFlightGeometryTest {
    private fun occupied(index: Int, userId: String) = Seat(
        seatIndex = index,
        status = SeatStatus.OCCUPIED,
        isMuted = false,
        isSpeaker = true,
        user = MiniUser(id = userId, username = userId, avatarUrl = null),
    )

    private fun emptyHostSeat() = Seat(
        seatIndex = 0,
        status = SeatStatus.EMPTY,
        isMuted = true,
        isSpeaker = false,
        user = null,
    )

    @Test
    fun `sender anchor follows the seated member identity`() {
        val sender = occupied(3, "sender")
        assertSame(sender, GiftFlightGeometry.senderSeat(listOf(occupied(0, "host"), sender), "sender"))
        assertNull(GiftFlightGeometry.senderSeat(listOf(occupied(0, "host")), "audience-member"))
    }

    @Test
    fun `an audience sender starts from their measured avatar`() {
        val avatarCenter = Offset(280f, 760f)
        val resolved = GiftFlightGeometry.senderCenterInRoot(
            senderId = "listener",
            seats = listOf(occupied(0, "host")),
            seatCentersInRoot = mapOf(0 to Offset(180f, 220f)),
            audienceCentersInRoot = mapOf("listener" to avatarCenter),
        )

        assertEquals(avatarCenter, resolved)
    }

    @Test
    fun `a seated sender anchor takes precedence over an audience entry`() {
        val seatCenter = Offset(180f, 220f)
        val resolved = GiftFlightGeometry.senderCenterInRoot(
            senderId = "sender",
            seats = listOf(occupied(2, "sender")),
            seatCentersInRoot = mapOf(2 to seatCenter),
            audienceCentersInRoot = mapOf("sender" to Offset(280f, 760f)),
        )

        assertEquals(seatCenter, resolved)
    }

    @Test
    fun `an audience receiver can be targeted at their visible avatar`() {
        val avatarCenter = Offset(280f, 760f)
        val resolved = GiftFlightGeometry.receiverCenterInRoot(
            receiverId = "listener",
            seats = listOf(occupied(0, "host")),
            receiverSeatIndex = null,
            hostId = "host",
            seatCentersInRoot = mapOf(0 to Offset(180f, 220f)),
            audienceCentersInRoot = mapOf("listener" to avatarCenter),
        )

        assertEquals(avatarCenter, resolved)
    }

    @Test
    fun `receiver identity wins over a stale seat index`() {
        val receiver = occupied(5, "receiver")
        val seats = listOf(occupied(0, "host"), occupied(2, "other"), receiver)

        assertSame(receiver, GiftFlightGeometry.receiverSeat(seats, "receiver", 2, "host"))
    }

    @Test
    fun `receiver seat index is used when receiver is not currently seated`() {
        val target = occupied(4, "other")
        assertSame(target, GiftFlightGeometry.receiverSeat(listOf(target), "audience-member", 4, "host"))
    }

    @Test
    fun `host fallback is restricted to gifts actually addressed to the host`() {
        val host = emptyHostSeat()
        assertSame(host, GiftFlightGeometry.receiverSeat(listOf(host), "host", null, "host"))
        assertNull(GiftFlightGeometry.receiverSeat(listOf(host), "audience-member", null, "host"))
    }

    @Test
    fun `root pixel coordinates are translated into overlay local dp coordinates`() {
        val local = GiftFlightGeometry.toOverlayLocal(
            globalCenter = Offset(420f, 260f),
            overlayOrigin = Offset(100f, 60f),
            density = 2f,
        )

        assertEquals(Offset(160f, 100f), local)
    }
}
