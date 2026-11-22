package com.voiza.app.data.notifications

/**
 * Validates the untrusted extras carried by an FCM notification before they reach app navigation.
 * A notification target is not opened until the signed-in member has a valid session.
 */
internal object NotificationTargetPolicy {
    private val uuidPattern = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    fun isValidPartnerId(partnerId: String?): Boolean =
        !partnerId.isNullOrBlank() && uuidPattern.matches(partnerId)

    fun partnerIdFrom(type: String?, partnerId: String?): String? =
        partnerId?.takeIf { type == "direct_message" && isValidPartnerId(it) }

    fun canOpenPartner(hasSession: Boolean, partnerId: String?): Boolean =
        hasSession && isValidPartnerId(partnerId)
}
