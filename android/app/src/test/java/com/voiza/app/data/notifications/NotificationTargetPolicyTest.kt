package com.voiza.app.data.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
    }

    @Test
    fun `mock notification data cannot create an unsafe navigation target`() {
        assertEquals(partnerId, NotificationTargetPolicy.partnerIdFrom("direct_message", partnerId))
        assertNull(NotificationTargetPolicy.partnerIdFrom("direct_message", "javascript:alert(1)"))
        assertNull(NotificationTargetPolicy.partnerIdFrom("room", partnerId))
        assertNull(NotificationTargetPolicy.partnerIdFrom("direct_message", ""))
    }

    @Test
    fun `notification tap waits for an authenticated session`() {
        assertTrue(NotificationTargetPolicy.canOpenPartner(true, partnerId))
        assertFalse(NotificationTargetPolicy.canOpenPartner(false, partnerId))
        assertFalse(NotificationTargetPolicy.canOpenPartner(true, null))
        assertTrue(NotificationTargetPolicy.canOpenPartner(true, partnerId.uppercase()))
        assertFalse(NotificationTargetPolicy.canOpenPartner(false, partnerId.uppercase()))
    }

    @Test
    fun `mock push is displayed in background when Android notification settings allow it`() {
        assertTrue(
            NotificationTargetPolicy.shouldPostNotification(
                isAppForeground = false,
                notificationsEnabled = true,
                postNotificationsPermissionGranted = true,
                channelEnabled = true,
            ),
        )
    }

    @Test
    fun `mock push is suppressed while app is foregrounded`() {
        assertFalse(
            NotificationTargetPolicy.shouldPostNotification(
                isAppForeground = true,
                notificationsEnabled = true,
                postNotificationsPermissionGranted = true,
                channelEnabled = true,
            ),
        )
    }

    @Test
    fun `mock push is suppressed when any Android notification gate is disabled`() {
        assertFalse(
            NotificationTargetPolicy.shouldPostNotification(
                isAppForeground = false,
                notificationsEnabled = false,
                postNotificationsPermissionGranted = true,
                channelEnabled = true,
            ),
        )
        assertFalse(
            NotificationTargetPolicy.shouldPostNotification(
                isAppForeground = false,
                notificationsEnabled = true,
                postNotificationsPermissionGranted = false,
                channelEnabled = true,
            ),
        )
        assertFalse(
            NotificationTargetPolicy.shouldPostNotification(
                isAppForeground = false,
                notificationsEnabled = true,
                postNotificationsPermissionGranted = true,
                channelEnabled = false,
            ),
        )
    }

    @Test
    fun `mock push content uses safe defaults and only DM payloads carry a partner target`() {
        assertEquals(
            MockPushPresentation(
                title = "Vozia notification",
                body = "You have a new update.",
                partnerId = partnerId,
            ),
            NotificationTargetPolicy.mockPushPresentation(
                title = " ",
                body = "",
                data = mapOf("type" to "direct_message", "partnerId" to partnerId),
            ),
        )

        assertEquals(
            MockPushPresentation(
                title = "Gift received",
                body = "A friend sent you a gift.",
                partnerId = null,
            ),
            NotificationTargetPolicy.mockPushPresentation(
                title = "Gift received",
                body = "A friend sent you a gift.",
                data = mapOf("type" to "gift", "partnerId" to partnerId),
            ),
        )
    }

    @Test
    fun `malformed DM target is removed from mock push presentation`() {
        val presentation = NotificationTargetPolicy.mockPushPresentation(
            title = "New message",
            body = "You received a message.",
            data = mapOf("type" to "direct_message", "partnerId" to "javascript:alert(1)"),
        )

        assertEquals("New message", presentation.title)
        assertEquals("You received a message.", presentation.body)
        assertNull(presentation.partnerId)
    }
}
