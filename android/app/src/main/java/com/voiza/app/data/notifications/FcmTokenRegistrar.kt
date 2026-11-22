package com.voiza.app.data.notifications

import android.content.Context
import android.util.Log
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.di.ServiceLocator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Keeps the current FCM token locally across sessions, then associates it with the
 * authenticated member. Registration and logout are serialized so a late PUT cannot
 * re-register a token after the matching DELETE has completed.
 */
object FcmTokenRegistrar {
    private const val TAG = "FcmTokenRegistrar"
    private const val PREFS = "voiza_push_registration"
    private const val KEY_DEVICE_TOKEN = "device_fcm_token"
    private const val KEY_LEGACY_PENDING_TOKEN = "pending_fcm_token"
    private const val KEY_REGISTERED_TOKEN = "registered_fcm_token"
    private const val KEY_REGISTERED_USER = "registered_user_id"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val registrationMutex = Mutex()

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var unregisterInProgress = false

    fun initialize(context: Context) {
        appContext = context.applicationContext
    }

    fun persistAndSync(context: Context, token: String) {
        if (token.isBlank()) return
        val app = context.applicationContext
        initialize(app)
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val previous = currentToken(prefs)
        prefs.edit().apply {
            putString(KEY_DEVICE_TOKEN, token)
            remove(KEY_LEGACY_PENDING_TOKEN)
            if (previous != token) {
                remove(KEY_REGISTERED_TOKEN)
                remove(KEY_REGISTERED_USER)
            }
        }.apply()
        syncPending(app)
    }

    fun syncPending(context: Context) {
        val app = context.applicationContext
        initialize(app)
        ServiceLocator.init(app)
        if (unregisterInProgress || !ServiceLocator.sessionManager.hasSession) return

        scope.launch {
            registrationMutex.withLock {
                if (unregisterInProgress || !ServiceLocator.sessionManager.hasSession) return@withLock
                val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val token = currentToken(prefs) ?: return@withLock
                val userId = ServiceLocator.sessionManager.user.value?.id ?: return@withLock
                if (
                    prefs.getString(KEY_REGISTERED_TOKEN, null) == token &&
                    prefs.getString(KEY_REGISTERED_USER, null) == userId
                ) return@withLock

                runCatching {
                    ServiceLocator.apiService.setDeviceToken(mapOf("deviceToken" to token))
                }.onSuccess {
                    // Keep the actual FCM token for the next login; only remember which
                    // authenticated account has the server-side registration.
                    if (
                        currentToken(prefs) == token &&
                        ServiceLocator.sessionManager.user.value?.id == userId
                    ) {
                        prefs.edit()
                            .putString(KEY_REGISTERED_TOKEN, token)
                            .putString(KEY_REGISTERED_USER, userId)
                            .remove(KEY_LEGACY_PENDING_TOKEN)
                            .apply()
                    }
                }.onFailure {
                    Log.w(TAG, "FCM token registration will retry on the next app/token refresh", it)
                }
            }
        }
    }

    /**
     * Capture the old bearer before local logout. The mutex makes a registration already
     * in flight finish first; a later login is re-registered after this DELETE completes.
     */
    fun unregister(api: VoizaApiService, authorization: String) {
        val app = appContext ?: return
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        // Capture before the logout caller clears local session state or a token rotates.
        val tokenToRemove = currentToken(prefs)
        unregisterInProgress = true
        scope.launch {
            registrationMutex.withLock {
                runCatching {
                    if (tokenToRemove.isNullOrBlank()) {
                        api.clearAllDeviceTokens(authorization)
                    } else {
                        api.clearDeviceToken(mapOf("deviceToken" to tokenToRemove), authorization)
                    }
                }
                    .onFailure { Log.w(TAG, "FCM unregister failed; the next login will register again", it) }
                app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .remove(KEY_REGISTERED_TOKEN)
                    .remove(KEY_REGISTERED_USER)
                    .apply()
                unregisterInProgress = false
            }
            // A second account may have signed in while logout's network call was in flight.
            if (ServiceLocator.sessionManager.hasSession) syncPending(app)
        }
    }

    private fun currentToken(prefs: android.content.SharedPreferences): String? {
        val token = prefs.getString(KEY_DEVICE_TOKEN, null)
            ?: prefs.getString(KEY_LEGACY_PENDING_TOKEN, null)
        if (token != null && prefs.getString(KEY_DEVICE_TOKEN, null) == null) {
            prefs.edit()
                .putString(KEY_DEVICE_TOKEN, token)
                .remove(KEY_LEGACY_PENDING_TOKEN)
                .apply()
        }
        return token
    }
}
