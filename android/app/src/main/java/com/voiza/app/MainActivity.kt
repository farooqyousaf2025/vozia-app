package com.voiza.app

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.rememberNavController
import com.voiza.app.data.notifications.NotificationTargetPolicy
import com.voiza.app.di.ServiceLocator
import com.voiza.app.ui.components.banner.BannerNavigator
import com.voiza.app.ui.components.banner.LocalBannerNavigator
import com.voiza.app.ui.components.banner.LocalBannerStore
import com.voiza.app.ui.components.announcement.AnnouncementTicker
import com.voiza.app.ui.components.banner.SplashBannerOverlay
import com.voiza.app.ui.navigation.Routes
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

    private var pendingMessagePartnerId by mutableStateOf<String?>(null)

    private fun messagePartnerFrom(intent: Intent?): String? =
        NotificationTargetPolicy.partnerIdFrom(
            type = intent?.getStringExtra("type"),
            partnerId = intent?.getStringExtra("partnerId"),
        )

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* the notifier re-checks on each event */ }

    private fun hasNotificationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingMessagePartnerId = messagePartnerFrom(intent)
        enableEdgeToEdge()

        // Auth-gated start destination: snapshot the session once at cold
        // start; later transitions happen inside the nav graph.
        val startOnHome = ServiceLocator.sessionManager.hasSession

        lifecycleScope.launch {
            // Validate a persisted JWT once; drops dead sessions to /auth.
            ServiceLocator.ensureSessionValid()
        }

        setContent {
            VoizaTheme {
                val navController = rememberNavController()
                val notificationPartnerId = pendingMessagePartnerId
                val sessionToken by ServiceLocator.sessionManager.token.collectAsStateWithLifecycle()
                var showNotificationPermissionRationale by remember { mutableStateOf(false) }

                LaunchedEffect(navController, notificationPartnerId) {
                    if (NotificationTargetPolicy.canOpenPartner(
                            hasSession = ServiceLocator.sessionManager.hasSession,
                            partnerId = notificationPartnerId,
                        )
                    ) {
                        navController.navigate(Routes.messages(notificationPartnerId)) {
                            launchSingleTop = true
                        }
                        pendingMessagePartnerId = null
                    }
                }

                // Ask only after a member signs in, with a clear explanation rather than
                // interrupting the first launch before the user has seen the app.
                LaunchedEffect(sessionToken) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                        !sessionToken.isNullOrBlank() &&
                        !hasNotificationPermission() &&
                        !getSharedPreferences(NOTIFICATION_PREFS, MODE_PRIVATE)
                            .getBoolean(KEY_NOTIFICATION_PROMPT_SHOWN, false)
                    ) {
                        showNotificationPermissionRationale = true
                    }
                }

                if (showNotificationPermissionRationale) {
                    AlertDialog(
                        onDismissRequest = {
                            markNotificationPromptShown()
                            showNotificationPermissionRationale = false
                        },
                        title = { Text("Stay in the loop") },
                        text = {
                            Text("Allow notifications for private messages and important room activity. You can change this anytime in Android Settings.")
                        },
                        confirmButton = {
                            TextButton(onClick = {
                                markNotificationPromptShown()
                                showNotificationPermissionRationale = false
                                notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                            }) { Text("Enable notifications") }
                        },
                        dismissButton = {
                            TextButton(onClick = {
                                markNotificationPromptShown()
                                showNotificationPermissionRationale = false
                            }) { Text("Not now") }
                        },
                    )
                }
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
                                onAuthenticated = {
                                    // Keep a notification target pending while the user is on
                                    // the auth screen; open it only after sign-in succeeds.
                                    val partnerId = pendingMessagePartnerId
                                    if (!partnerId.isNullOrBlank()) {
                                        navController.navigate(Routes.messages(partnerId)) {
                                            launchSingleTop = true
                                        }
                                        pendingMessagePartnerId = null
                                    }
                                },
                                navController = navController,
                            )
                        }
                        // App-wide ticker: top-ups, top rankers and game results, drawn above the
                        // navigation graph so every screen sees the same line.
                        AnnouncementTicker()
                        // Above the graph, and only while a SPLASH campaign is live: with nothing to
                        // show the app opens exactly as it did before this overlay existed.
                        SplashBannerOverlay()
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pendingMessagePartnerId = messagePartnerFrom(intent)
    }

    private fun markNotificationPromptShown() {
        getSharedPreferences(NOTIFICATION_PREFS, MODE_PRIVATE).edit()
            .putBoolean(KEY_NOTIFICATION_PROMPT_SHOWN, true)
            .apply()
    }

    private companion object {
        const val NOTIFICATION_PREFS = "voiza_notification_preferences"
        const val KEY_NOTIFICATION_PROMPT_SHOWN = "permission_rationale_shown"
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
