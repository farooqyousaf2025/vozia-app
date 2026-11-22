package com.voiza.app.data.notifications

import com.google.firebase.messaging.FirebaseMessagingService
import com.voiza.app.di.ServiceLocator

/** Receives token rotations; message payloads with a notification block are shown by FCM. */
class VoizaFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        ServiceLocator.init(applicationContext)
        FcmTokenRegistrar.persistAndSync(applicationContext, token)
    }
}
