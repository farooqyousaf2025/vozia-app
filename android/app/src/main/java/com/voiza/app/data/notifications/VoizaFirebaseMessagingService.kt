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
        val partnerId = NotificationTargetPolicy.partnerIdFrom(
            type = message.data["type"],
            partnerId = message.data["partnerId"],
        ) ?: return
        ServiceLocator.init(applicationContext)
        ServiceLocator.notifier.showDirectMessagePush(
            title = message.notification?.title?.takeIf(String::isNotBlank) ?: "New message",
            body = message.notification?.body?.takeIf(String::isNotBlank) ?: "Open Vozia to read and reply.",
            partnerId = partnerId,
        )
    }
}
