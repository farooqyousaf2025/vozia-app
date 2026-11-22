package com.voiza.app.data.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.view.KeyEvent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.UiDevice
import androidx.test.platform.app.InstrumentationRegistry
import com.voiza.app.MainActivity
import com.voiza.app.data.remote.SessionManager
import com.voiza.app.data.remote.dto.UserDto
import com.voiza.app.di.ServiceLocator
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Device-level checks against the production VoizaNotifier and Android NotificationManager.
 *
 * No Firebase, FCM, SMTP or backend account is required: the test invokes the same local mock
 * notification entry point used by authenticated Socket.IO push events.
 */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 33)
class MockPushNotificationDeviceTest {
    @get:Rule
    val notificationPermission: GrantPermissionRule =
        GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)

    private lateinit var context: Context
    private lateinit var notificationManager: NotificationManager
    private lateinit var device: UiDevice
    private lateinit var scenario: ActivityScenario<MainActivity>
    private val postedIds = mutableSetOf<Int>()

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
        ServiceLocator.init(context)
        ServiceLocator.sessionManager.clear()
        notificationManager = context.getSystemService(NotificationManager::class.java)
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        scenario = ActivityScenario.launch(MainActivity::class.java)
        assertTrue(
            "MainActivity did not reach the foreground",
            awaitCondition { ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) },
        )
        assertTrue("App notifications are disabled in the emulator", notificationManager.areNotificationsEnabled())
        assertTrue(
            "The room activity channel is disabled",
            notificationManager.getNotificationChannel(VoizaNotifier.CHANNEL_ACTIVITY)?.importance
                ?.let { it != NotificationManager.IMPORTANCE_NONE } ?: true,
        )
    }

    @After
    fun tearDown() {
        if (::device.isInitialized && !device.isScreenOn) device.wakeUp()
        if (::notificationManager.isInitialized) postedIds.forEach(notificationManager::cancel)
        if (serviceLocatorInitialized()) ServiceLocator.sessionManager.clear()
        if (::scenario.isInitialized) scenario.close()
    }

    @Test
    fun mockPushIsSuppressedInForegroundAndPostedAfterHomeThenSuppressedAgainOnResume() {
        val foregroundTitle = "Device test foreground ${SystemClock.elapsedRealtime()}"
        ServiceLocator.notifier.showMockPush(foregroundTitle, "Must not appear while Vozia is open", emptyMap())
        assertNull("Foreground mock push must not create a system notification", activeNotification(foregroundTitle))

        device.pressHome()
        assertTrue(
            "Process did not enter the background after pressing Home",
            awaitCondition { !ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) },
        )

        val backgroundTitle = "Device test background ${SystemClock.elapsedRealtime()}"
        val backgroundBody = "Vozia mock push reached Android while backgrounded"
        ServiceLocator.notifier.showMockPush(backgroundTitle, backgroundBody, emptyMap())

        val notification = awaitNotification(backgroundTitle)
        assertNotNull("Background mock push was not posted to NotificationManager", notification)
        assertEquals(backgroundTitle, notification?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString())
        assertEquals(backgroundBody, notification?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString())

        // Explicitly resume the same singleTask activity, as a user would tap the Vozia app icon.
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP,
            ),
        )
        assertTrue(
            "Vozia did not return to the foreground",
            awaitCondition { ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) },
        )

        val resumedTitle = "Device test resumed ${SystemClock.elapsedRealtime()}"
        ServiceLocator.notifier.showMockPush(resumedTitle, "Must not duplicate in the foreground", emptyMap())
        assertNull("Resumed app must not post another system notification", activeNotification(resumedTitle))
    }

    @Test
    fun mockPushIsPostedWhileDisplayIsOffAndRemainsInTheSystemNotificationQueue() {
        device.pressHome()
        assertTrue(
            "Process did not enter the background before screen-off",
            awaitCondition { !ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) },
        )

        if (device.isScreenOn) device.pressKeyCode(KeyEvent.KEYCODE_POWER)
        assertTrue("Emulator display did not turn off", awaitCondition { !device.isScreenOn })

        val title = "Device test screen off ${SystemClock.elapsedRealtime()}"
        ServiceLocator.notifier.showMockPush(title, "Notification queued while display is off", emptyMap())

        val notification = awaitNotification(title)
        assertNotNull("Notification was not queued while the display was off", notification)
        assertEquals(title, notification?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString())
    }

    @Test
    fun logoutAndLoginOnTheSameInstallationReplaceTheEncryptedSessionIdentity() {
        val session = SessionManager(context)
        session.clear()

        val firstUser = UserDto(
            id = "11111111-1111-4111-8111-111111111111",
            phone = "+15550000001",
            username = "device_test_one",
        )
        session.storeSession("device-test-token-one", firstUser)
        assertTrue(session.hasSession)
        assertEquals("device-test-token-one", session.token.value)
        assertEquals(firstUser.id, session.user.value?.id)

        session.clear()
        assertFalse(session.hasSession)
        assertNull(session.token.value)
        assertNull(session.user.value)

        val secondUser = UserDto(
            id = "22222222-2222-4222-8222-222222222222",
            phone = "+15550000002",
            username = "device_test_two",
        )
        session.storeSession("device-test-token-two", secondUser)
        assertTrue(session.hasSession)
        assertEquals("device-test-token-two", session.token.value)
        assertEquals(secondUser.id, session.user.value?.id)
    }

    private fun serviceLocatorInitialized(): Boolean = runCatching { ServiceLocator.sessionManager }.isSuccess

    private fun activeNotification(title: String): android.service.notification.StatusBarNotification? =
        notificationManager.activeNotifications.firstOrNull {
            it.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() == title
        }?.also { postedIds += it.id }

    private fun awaitNotification(title: String): Notification? {
        var found: Notification? = null
        val completed = awaitCondition {
            found = activeNotification(title)?.notification
            found != null
        }
        assertTrue("Timed out waiting for notification: $title", completed)
        return found
    }

    private fun awaitCondition(timeoutMs: Long = 5_000, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.elapsedRealtime() + timeoutMs
        while (SystemClock.elapsedRealtime() < deadline) {
            if (condition()) return true
            SystemClock.sleep(50)
        }
        return condition()
    }
}
