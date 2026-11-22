package com.voiza.app.data.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationTargetPolicyTest {
    private val partnerId = "a3a0ab33-9141-4c9f-a1ce-e128ca55f4c2"

    @Test
    fun `only direct message payloads with a UUID become navigation targets`() {
        assertEquals(partnerId, NotificationTargetPolicy.partnerIdFrom("direct_message", partnerId))
        assertEquals(null, NotificationTargetPolicy.partnerIdFrom("gift", partnerId))
        assertEquals(null, NotificationTargetPolicy.partnerIdFrom("direct_message", "not-a-uuid"))
        assertEquals(null, NotificationTargetPolicy.partnerIdFrom(null, partnerId))
    }

    @Test
    fun `mock notification data cannot create an unsafe navigation target`() {
        assertEquals(partnerId, NotificationTargetPolicy.partnerIdFrom("direct_message", partnerId))
        assertEquals(null, NotificationTargetPolicy.partnerIdFrom("direct_message", "javascript:alert(1)"))
        assertEquals(null, NotificationTargetPolicy.partnerIdFrom("room", partnerId))
    }

    @Test
    fun `notification tap waits for an authenticated session`() {
        assertTrue(NotificationTargetPolicy.canOpenPartner(true, partnerId))
        assertFalse(NotificationTargetPolicy.canOpenPartner(false, partnerId))
        assertFalse(NotificationTargetPolicy.canOpenPartner(true, null))
    }
}
