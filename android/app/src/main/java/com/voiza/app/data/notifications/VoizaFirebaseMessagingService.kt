package com.voiza.app.data.notifications

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.voiza.app.di.ServiceLocator

/** Receives token rotations and foreground data/notification messages from FCM. */
class VoizaFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        ServiceLocator.init(applicationContext)
        FcmTokenRegistrar.persistAndSync(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        if (message.data["type"] != TYPE_DIRECT_MESSAGE) return
        val partnerId = message.data["partnerId"]?.takeIf(UUID_PATTERN::matches) ?: return
        ServiceLocator.init(applicationContext)
        ServiceLocator.notifier.showDirectMessagePush(
            title = message.notification?.title?.takeIf(String::isNotBlank) ?: "New message",
            body = message.notification?.body?.takeIf(String::isNotBlank) ?: "Open Vozia to read and reply.",
            partnerId = partnerId,
        )
    }

    companion object {
        private const val TYPE_DIRECT_MESSAGE = "direct_message"
        private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    }
}
