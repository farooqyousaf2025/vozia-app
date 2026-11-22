package com.voiza.app.data.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.AssertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationTargetPolicyTest {
    private val partnerId = "a3a0ab33-9141-4c9f-a1ce-e128ca55f4c2"

    @Test
    fun `only direct message payloads with a UUID become navigation targets`() {
        assertEquals(partnerId, NotificationTargetPolicy.partnerIdFrom("direct_message", partnerId))
        assertNull(NotificationTargetPolicy.partnerIdFrom("gift", partnerId))
        assertNull(NotificationTargetPolicy.partnerIdFrom("direct_message", "not-a-uuid"))
        assertNull(NotificationTargetPolicy.partnerIdFrom(null, partnerId))
        assertNull(NotificationTargetPolicy.partnerIdFrom("DIRECT_MESSAGE", partnerId))
    }

    @Test
    fun `mock notification data cannot create an unsafe navigation target`() {
        assertEquals(partnerId, NotificationTargetPolicy.partnerIdFrom("direct_message", partnerId))
        assertNull(NotificationTargetPolicy.partnerIdFrom("direct_message", "javascript:alert(1)"))
        assertNull(NotificationTargetPolicy.partnerIdFrom("room", partnerId))
        assertNull(NotificationTargetPolicy.partnerIdFrom("direct_message", "00000000-0000-0000-0000-000000000000/../settings"))
    }

    @Test
    fun `notification tap waits for an authenticated session and a valid partner`() {
        assertTrue(NotificationTargetPolicy.canOpenPartner(true, partnerId))
        assertFalse(NotificationTargetPolicy.canOpenPartner(false, partnerId))
        assertFalse(NotificationTargetPolicy.canOpenPartner(true, null))
        assertFalse(NotificationTargetPolicy.canOpenPartner(true, "not-a-uuid"))
    }

    @Test
    fun `mock push appears only in background when every notification gate is enabled`() {
        assertTrue(
            NotificationTargetPolicy.shouldDisplay(
                appInForeground = false,
                appNotificationsEnabled = true,
                runtimePermissionGranted = true,
                activityChannelEnabled = true,
            ),
        )
    }

    @Test
    fun `foreground app never receives a duplicate system notification`() {
        assertFalse(
            NotificationTargetPolicy.shouldDisplay(
                appInForeground = true,
                appNotificationsEnabled = true,
                runtimePermissionGranted = true,
                activityChannelEnabled = true,
            ),
        )
    }

    @Test
    fun `disabled app notifications block mock notification display`() {
        assertFalse(
            NotificationTargetPolicy.shouldDisplay(
                appInForeground = false,
                appNotificationsEnabled = false,
                runtimePermissionGranted = true,
                activityChannelEnabled = true,
            ),
        )
    }

    @Test
    fun `missing Android runtime permission blocks mock notification display`() {
        assertFalse(
            NotificationTargetPolicy.shouldDisplay(
                appInForeground = false,
                appNotificationsEnabled = true,
                runtimePermissionGranted = false,
                activityChannelEnabled = true,
            ),
        )
    }

    @Test
    fun `muted activity channel blocks mock notification display`() {
        assertFalse(
            NotificationTargetPolicy.shouldDisplay(
                appInForeground = false,
                appNotificationsEnabled = true,
                runtimePermissionGranted = true,
                activityChannelEnabled = false,
            ),
        )
    }

    @Test
    fun `mock direct message preserves content and carries only its validated partner target`() {
        val presentation = NotificationTargetPolicy.mockPushPresentation(
            title = "New message",
            body = "Hello from a friend",
            data = mapOf("type" to "direct_message", "partnerId" to partnerId),
        )

        assertEquals("New message", presentation.title)
        assertEquals("Hello from a friend", presentation.body)
        assertEquals(partnerId, presentation.partnerId)
        assertTrue(NotificationTargetPolicy.canOpenPartner(true, presentation.partnerId))
    }

    @Test
    fun `non message mock push does not attach a partner navigation target`() {
        val presentation = NotificationTargetPolicy.mockPushPresentation(
            title = "Room update",
            body = "A room event occurred",
            data = mapOf("type" to "gift", "partnerId" to partnerId),
        )

        assertEquals("Room update", presentation.title)
        assertEquals("A room event occurred", presentation.body)
        assertNull(presentation.partnerId)
    }

    @Test
    fun `malformed direct message target is removed before notification navigation`() {
        val presentation = NotificationTargetPolicy.mockPushPresentation(
            title = "New message",
            body = "Tap to view",
            data = mapOf("type" to "direct_message", "partnerId" to "javascript:alert(1)"),
        )

        assertNull(presentation.partnerId)
        assertFalse(NotificationTargetPolicy.canOpenPartner(true, presentation.partnerId))
    }

    @Test
    fun `empty mock push content receives safe user facing defaults`() {
        val presentation = NotificationTargetPolicy.mockPushPresentation(
            title = "   ",
            body = "",
            data = emptyMap(),
        )

        assertEquals("Vozia notification", presentation.title)
        assertEquals("You have a new update.", presentation.body)
        assertNull(presentation.partnerId)
    }
}
