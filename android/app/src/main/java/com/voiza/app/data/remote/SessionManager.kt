package com.voiza.app.data.remote

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.gson.Gson
import com.voiza.app.data.remote.dto.UserDto
import java.security.KeyStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Persists the JWT + current user and exposes them as StateFlows so the whole app
 * (interceptor, socket, ViewModels) reacts to login/logout.
 *
 * The store is encrypted with a Keystore-backed master key: the JWT *is* the
 * session, and a rooted device or an adb-pulled data directory would otherwise
 * hand it over in clear text. Values from the pre-encryption file (`voiza_session`)
 * are copied across once and the legacy file is wiped, so upgrading does not log
 * anybody out.
 */
class SessionManager(context: Context) {

    private val appContext = context.applicationContext

    private val prefs: SharedPreferences = openSecurePrefs()

    private val gson = Gson()

    private val _token = MutableStateFlow<String?>(prefs.getString(KEY_TOKEN, null))
    val token: StateFlow<String?> = _token.asStateFlow()

    private val _user = MutableStateFlow<UserDto?>(prefs.getString(KEY_USER, null)?.let {
        runCatching { gson.fromJson(it, UserDto::class.java) }.getOrNull()
    })
    val user: StateFlow<UserDto?> = _user.asStateFlow()

    val hasSession: Boolean get() = !_token.value.isNullOrBlank()

    fun storeSession(token: String, user: UserDto) {
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_USER, gson.toJson(user))
            .apply()
        _token.value = token
        _user.value = user
    }

    fun updateUser(user: UserDto) = publish(user)

    /**
     * A `wallet:update` carries only the side the server changed (gift sender:
     * diamonds, receiver: R-coins), so a null means "keep the current copy".
     */
    fun applyWalletUpdate(diamondBalance: Int?, rCoinBalance: Int?) {
        val current = _user.value ?: return
        publish(
            current.copy(
                diamondBalance = diamondBalance ?: current.diamondBalance,
                rCoinBalance = rCoinBalance ?: current.rCoinBalance,
            ),
        )
    }

    private fun publish(user: UserDto) {
        prefs.edit().putString(KEY_USER, gson.toJson(user)).apply()
        _user.value = user
    }

    fun clear() {
        prefs.edit().clear().apply()
        _token.value = null
        _user.value = null
    }

    private fun openSecurePrefs(): SharedPreferences = try {
        EncryptedSharedPreferences.create(
            appContext,
            PREFS_NAME,
            masterKey(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        ).also { migrateLegacySession(it) }
    } catch (first: Exception) {
        // The master key lives in the hardware/backed keystore, so a device restore
        // or a factory-reset keystore wipe makes every stored value unreadable while
        // the file itself survives. Dropping the key and starting over is the only
        // recovery that keeps encryption on; it costs the user one re-login.
        Log.w(TAG, "Session store unusable, resetting the master key", first)
        try {
            KeyStore.getInstance(MASTER_KEYSTORE).apply { load(null) }.deleteEntry(MASTER_KEY_ALIAS)
            appContext.deleteSharedPreferences(PREFS_NAME)
            EncryptedSharedPreferences.create(
                appContext,
                PREFS_NAME,
                masterKey(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (second: Exception) {
            // A device with no usable keystore (a rooted ROM with a broken
            // KeyStore provider) must still run: fall back to the legacy clear-text
            // file — a different name, so it can never collide with the encrypted
            // one — and say so loudly instead of crashing on launch.
            Log.e(TAG, "Encrypted session store unavailable; using MODE_PRIVATE", second)
            appContext.getSharedPreferences(LEGACY_PREFS_NAME, Context.MODE_PRIVATE)
        }
    }

    private fun masterKey(): MasterKey =
        MasterKey.Builder(appContext, MASTER_KEY_ALIAS)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

    private fun migrateLegacySession(store: SharedPreferences) {
        if (store.getString(KEY_TOKEN, null) != null) return
        val legacy = appContext.getSharedPreferences(LEGACY_PREFS_NAME, Context.MODE_PRIVATE)
        val legacyToken = legacy.getString(KEY_TOKEN, null) ?: return
        store.edit()
            .putString(KEY_TOKEN, legacyToken)
            .putString(KEY_USER, legacy.getString(KEY_USER, null))
            .apply()
        // Remove the clear-text copy once it has been moved.
        legacy.edit().clear().apply()
    }

    private companion object {
        const val TAG = "SessionManager"
        const val PREFS_NAME = "voiza_session_secure"
        const val MASTER_KEY_ALIAS = "voiza_session_master_key"
        const val MASTER_KEYSTORE = "AndroidKeyStore"

        /** Clear-text store from before the session was encrypted. */
        const val LEGACY_PREFS_NAME = "voiza_session"

        const val KEY_TOKEN = "jwt_token"
        const val KEY_USER = "user_json"
    }
}
