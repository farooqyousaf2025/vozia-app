package com.voiza.app.data.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.voiza.app.MainActivity
import com.voiza.app.R
import com.voiza.app.data.remote.SessionManager
import com.voiza.app.data.socket.VoizaSocketClient
import com.voiza.app.domain.model.GiftAnimatedEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Heads-up notifications for the room events a user misses with the screen off:
 * a gift addressed to them, an operator warning, and being removed from a room.
 *
 * Delivery rides on the room socket, which stays connected while the app is
 * backgrounded, so this works without any third-party account. Moving it to real
 * push is a transport swap only: hand the FCM registration token to
 * `PUT /api/auth/me/device-token` and the server side already sends.
 */
class VoizaNotifier(
    private val context: Context,
    private val socket: VoizaSocketClient,
    private val session: SessionManager,
) {
    private val manager: NotificationManager =
        context.getSystemService(NotificationManager::class.java)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    init {
        // A channel per urgency: Android 8+ silences a notification whose channel
        // was created without importance, and the user can retune it from there.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ACTIVITY,
                    "Room activity",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "Gifts, warnings and moderation events in rooms you joined."
                },
            )
        }
        observe()
    }

    private fun observe() {
        scope.launch {
            socket.giftAnimated.collect { event ->
                if (!shouldNotify() || !isForMe(event)) return@collect
                notify(
                    id = event.hashCode(),
                    title = "${event.sender.username} sent you ${event.gift.name}",
                    body = "\u2756 ${event.totalDiamonds} \u2192 you earned \u25C9 ${event.totalRCoins}",
                )
            }
        }
        scope.launch {
            socket.hostWarnings.collect { warning ->
                if (!shouldNotify()) return@collect
                notify(id = NOTIFICATION_WARNING, title = "Room warning", body = warning.message)
            }
        }
        scope.launch {
            socket.kickedFrom.collect {
                if (!shouldNotify()) return@collect
                notify(id = NOTIFICATION_KICKED, title = "Removed from the room", body = "The host ended your turn in this room.")
            }
        }
    }

    /**
     * Only while the app is not in the foreground and the room screen is not
     * already showing the same thing.
     */
    private fun shouldNotify(): Boolean =
        !ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) && canPost()

    private fun canPost(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    private fun isForMe(event: GiftAnimatedEvent): Boolean {
        val me = session.user.value?.id ?: return false
        return event.receiver.id == me
    }

    private fun notify(id: Int, title: String, body: String) {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        // FLAG_IMMUTABLE is mandatory on Android 12+, and minSdk is already 24.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val notification = NotificationCompat.Builder(context, CHANNEL_ACTIVITY)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(context, id, intent, flags))
            .build()
        manager.notify(id, notification)
    }

    companion object {
        const val CHANNEL_ACTIVITY = "voiza_activity"
        private const val NOTIFICATION_WARNING = 9_001
        private const val NOTIFICATION_KICKED = 9_002
    }
}
