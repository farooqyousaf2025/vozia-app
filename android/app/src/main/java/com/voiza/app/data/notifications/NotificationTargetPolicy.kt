package com.voiza.app.data.notifications

internal data class MockPushPresentation(
    val title: String,
    val body: String,
    val partnerId: String?,
)

/**
 * Pure notification decisions shared by the Android notifier and JVM regression tests.
 * Payload values are untrusted: only direct-message UUIDs may become navigation targets.
 */
internal object NotificationTargetPolicy {
    private val uuidPattern = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    fun isValidPartnerId(partnerId: String?): Boolean =
        !partnerId.isNullOrBlank() && uuidPattern.matches(partnerId)

    fun partnerIdFrom(type: String?, partnerId: String?): String? =
        partnerId?.takeIf { type == "direct_message" && isValidPartnerId(it) }

    fun canOpenPartner(hasSession: Boolean, partnerId: String?): Boolean =
        hasSession && isValidPartnerId(partnerId)

    /** Suppress heads-up notifications in the foreground or when Android/user settings block them. */
    fun shouldPostNotification(
        isAppForeground: Boolean,
        notificationsEnabled: Boolean,
        postNotificationsPermissionGranted: Boolean,
        channelEnabled: Boolean,
    ): Boolean =
        !isAppForeground &&
            notificationsEnabled &&
            postNotificationsPermissionGranted &&
            channelEnabled

    /** Normalize optional mock payload text and safely project its only supported navigation target. */
    fun mockPushPresentation(
        title: String,
        body: String,
        data: Map<String, String>,
    ): MockPushPresentation = MockPushPresentation(
        title = title.ifBlank { "Vozia notification" },
        body = body.ifBlank { "You have a new update." },
        partnerId = partnerIdFrom(data["type"], data["partnerId"]),
    )
}
