package com.voiza.app.data.notifications

import android.content.Context
import com.voiza.app.di.ServiceLocator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Keeps the latest FCM token until a member session exists, then registers it
 * using the authenticated API. Token refresh and login are both safe to retry.
 */
object FcmTokenRegistrar {
    private const val PREFS = "voiza_push_registration"
    private const val KEY_PENDING_TOKEN = "pending_fcm_token"

    fun persistAndSync(context: Context, token: String) {
        if (token.isBlank()) return
        val app = context.applicationContext
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_PENDING_TOKEN, token).apply()
        syncPending(app)
    }

    fun syncPending(context: Context) {
        val app = context.applicationContext
        ServiceLocator.init(app)
        if (!ServiceLocator.sessionManager.hasSession) return
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val token = prefs.getString(KEY_PENDING_TOKEN, null) ?: return
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            runCatching {
                ServiceLocator.apiService.setDeviceToken(mapOf("deviceToken" to token))
            }.onSuccess {
                // Do not erase a newer token that may have rotated during the request.
                if (prefs.getString(KEY_PENDING_TOKEN, null) == token) {
                    prefs.edit().remove(KEY_PENDING_TOKEN).apply()
                }
            }
        }
    }
}
