package com.voiza.app

import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.voiza.app.di.ServiceLocator
import com.voiza.app.ui.navigation.VoizaNavHost
import com.voiza.app.ui.theme.VoizaTheme
import kotlinx.coroutines.launch

/**
 * Single-activity Compose host.
 *
 * Edge-to-edge + dark theme. The LiveKit connection lives in
 * ServiceLocator.liveKitRoomManager, which is owned process-wide and driven by
 * PartyRoomViewModel (cleared -> disconnect()), so configuration changes never
 * drop audio (the manifest also pins configChanges on this activity).
 * RECORD_AUDIO is requested by the room screen right before publishing.
 */
class MainActivity : ComponentActivity() {

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* the notifier re-checks on each event */ }

    private fun hasNotificationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Auth-gated start destination: snapshot the session once at cold
        // start; later transitions happen inside the nav graph.
        val startOnHome = ServiceLocator.sessionManager.hasSession

        lifecycleScope.launch {
            // Validate a persisted JWT once; drops dead sessions to /auth.
            ServiceLocator.ensureSessionValid()
        }

        // Android 13+ needs an explicit grant before any heads-up room notification
        // can be posted; below that the permission is granted at install.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !hasNotificationPermission()
        ) {
            notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        setContent {
            VoizaTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = androidx.compose.material3.MaterialTheme.colorScheme.background,
                ) {
                    VoizaNavHost(
                        startOnHome = startOnHome,
                        onLogout = { /* nav graph already reset to auth */ },
                    )
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // Do NOT disconnect LiveKit here on config changes; only when the
        // activity is truly finishing.
        if (isFinishing) {
            ServiceLocator.liveKitRoomManager.destroy()
            ServiceLocator.socketClient.disconnect()
        }
    }
}
