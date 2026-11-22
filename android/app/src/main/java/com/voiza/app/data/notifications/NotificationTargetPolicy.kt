package com.voiza.app.data.notifications

/**
 * The presentation prepared for a local mock push before it is handed to Android's notification
 * manager. Only a validated direct-message target is allowed to become an Activity extra.
 */
internal data class MockPushPresentation(
    val title: String,
    val body: String,
    val partnerId: String?,
)

/**
 * Validates notification visibility and the untrusted extras carried by mock or FCM pushes.
 * A navigation target is not opened until the signed-in member has a valid session.
 */
internal object NotificationTargetPolicy {
    private val uuidPattern = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    fun isValidPartnerId(partnerId: String?): Boolean =
        !partnerId.isNullOrBlank() && uuidPattern.matches(partnerId)

    fun partnerIdFrom(type: String?, partnerId: String?): String? =
        partnerId?.takeIf { type == "direct_message" && isValidPartnerId(it) }

    fun canOpenPartner(hasSession: Boolean, partnerId: String?): Boolean =
        hasSession && isValidPartnerId(partnerId)

    /**
     * Keep all four visibility gates in one pure function so their combination is unit-testable:
     * foreground state, app-wide notification setting, Android runtime permission and channel.
     */
    fun shouldDisplay(
        appInForeground: Boolean,
        appNotificationsEnabled: Boolean,
        runtimePermissionGranted: Boolean,
        activityChannelEnabled: Boolean,
    ): Boolean =
        !appInForeground &&
            appNotificationsEnabled &&
            runtimePermissionGranted &&
            activityChannelEnabled

    /** Convert untrusted mock-push data into the exact content passed to the native notifier. */
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
