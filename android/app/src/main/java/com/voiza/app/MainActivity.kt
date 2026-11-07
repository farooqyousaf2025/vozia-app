package com.voiza.app

import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.navigation.compose.rememberNavController
import com.voiza.app.di.ServiceLocator
import com.voiza.app.ui.components.banner.BannerNavigator
import com.voiza.app.ui.components.banner.LocalBannerNavigator
import com.voiza.app.ui.components.banner.LocalBannerStore
import com.voiza.app.ui.components.banner.SplashBannerOverlay
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
                val navController = rememberNavController()
                // The banner list belongs to the process rather than to a route, so it is handed to
                // every surface from here: four screens, one request, and a tap that navigates through
                // the graph this activity already owns instead of a navController passed down by hand.
                val bannerNavigator = remember(navController) {
                    BannerNavigator(this) { route ->
                        navController.navigate(route) { launchSingleTop = true }
                    }
                }
                CompositionLocalProvider(
                    LocalBannerStore provides ServiceLocator.bannersStore,
                    LocalBannerNavigator provides bannerNavigator,
                ) {
                    Box(modifier = Modifier.fillMaxSize()) {
                        Surface(
                            modifier = Modifier.fillMaxSize(),
                            color = androidx.compose.material3.MaterialTheme.colorScheme.background,
                        ) {
                            VoizaNavHost(
                                startOnHome = startOnHome,
                                onLogout = { /* nav graph already reset to auth */ },
                                navController = navController,
                            )
                        }
                        // Above the graph, and only while a SPLASH campaign is live: with nothing to
                        // show the app opens exactly as it did before this overlay existed.
                        SplashBannerOverlay()
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // Do NOT disconnect LiveKit here on config changes; only when the
        // activity is truly finishing.
        if (isFinishing) {
            // Leave the room, but do not cancel the manager's scope: it is a process singleton that
            // ServiceLocator never rebuilds, so cancelling it here would leave the next
            // MainActivity — a process death is not required, rotation plus finish is enough —
            // holding a manager whose event collector and connect coroutine are already dead.
            ServiceLocator.liveKitRoomManager.disconnect()
            ServiceLocator.socketClient.disconnect()
        }
    }
}
