package com.voiza.app.data.livekit

import android.content.Context
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.LocalAudioTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

enum class LkConnectionState { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING }

/**
 * Thin, testable wrapper around a single LiveKit [Room].
 *
 * Rules encoded here:
 *  - We only publish a local mic AudioTrack when the backend says we may
 *    (`canPublish` from the join/token response) AND the mic permission has
 *    been granted. Audience members connect as pure subscribers.
 *  - When seat changes only flip publish rights (same LiveKit room), we
 *    publish/unpublish the track instead of reconnecting the whole room.
 *  - Speaking levels are polled from participant state rather than relying on
 *    event payload signatures, so minor LiveKit SDK event-shape changes across
 *    2.x cannot break compilation or the speaking-ring UI.
 */
class LiveKitRoomManager(context: Context) {

    private val appContext = context.applicationContext

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    // A fresh Room per manager; LiveKit rooms are reusable across connect()
    // calls, so configuration changes keep working through the same instance
    // (the ViewModel owns this manager, not the composable).
    private val room: Room = LiveKit.create(appContext)

    private val _connectionState = MutableStateFlow(LkConnectionState.DISCONNECTED)
    val connectionState: StateFlow<LkConnectionState> = _connectionState.asStateFlow()

    /** identity (user id, see README assumption) -> audio level 0.0..1.0 */
    private val _speakingLevels = MutableStateFlow<Map<String, Double>>(emptyMap())
    val speakingLevels: StateFlow<Map<String, Double>> = _speakingLevels.asStateFlow()

    private val _connectedIdentities = MutableStateFlow<List<String>>(emptyList())
    val connectedIdentities: StateFlow<List<String>> = _connectedIdentities.asStateFlow()

    @Volatile
    private var micTrack: LocalAudioTrack? = null

    @Volatile
    private var mayPublish: Boolean = false

    @Volatile
    private var micPermission: Boolean = false

    @Volatile
    private var micEnabled: Boolean = true

    @Volatile
    private var currentRoomName: String? = null

    init {
        scope.launch {
            room.events.events.collect { event ->
                when (event) {
                    is RoomEvent.Connected -> {
                        _connectionState.value = LkConnectionState.CONNECTED
                        startLevelPolling()
                    }
                    is RoomEvent.Disconnected -> {
                        _connectionState.value = LkConnectionState.DISCONNECTED
                        _speakingLevels.value = emptyMap()
                        _connectedIdentities.value = emptyList()
                    }
                    is RoomEvent.Reconnecting ->
                        _connectionState.value = LkConnectionState.RECONNECTING
                    is RoomEvent.Reconnected -> {
                        _connectionState.value = LkConnectionState.CONNECTED
                        // Rights may have changed while offline: reconcile.
                        reconcilePublishing()
                    }
                    is RoomEvent.ParticipantConnected,
                    is RoomEvent.ParticipantDisconnected,
                    -> refreshParticipants()
                    else -> Unit
                }
            }
        }
    }

    /**
     * Connect (or re-connect into a different LiveKit room). If we are already
     * connected to the same [roomName] this is a no-op — seat churn must not
     * re-dial the websocket.
     */
    fun connect(url: String, token: String, roomName: String, canPublish: Boolean) {
        mayPublish = canPublish
        if (_connectionState.value == LkConnectionState.CONNECTED && currentRoomName == roomName) {
            reconcilePublishing()
            return
        }
        if (currentRoomName != null && currentRoomName != roomName) {
            hardTeardown()
        }
        currentRoomName = roomName
        _connectionState.value = LkConnectionState.CONNECTING
        scope.launch {
            runCatching { room.connect(url, token) }
                .onFailure {
                    Log.e(TAG, "LiveKit connect to $roomName failed", it)
                    _connectionState.value = LkConnectionState.DISCONNECTED
                }
        }
    }

    /** Seat changed -> publish rights changed. No reconnect when same room. */
    fun updatePublishRights(canPublish: Boolean) {
        mayPublish = canPublish
        reconcilePublishing()
    }

    /** Runtime RECORD_AUDIO grant result from the UI layer. */
    fun setMicPermissionGranted(granted: Boolean) {
        micPermission = granted
        reconcilePublishing()
    }

    /** Soft mute: keeps the track alive, toggles enabled state. */
    fun setMicrophoneEnabled(enabled: Boolean) {
        micEnabled = enabled
        micTrack?.let { track ->
            scope.launch { runCatching { track.enabled = enabled } }
        }
        // Unmute while un-seated should not fabricate a track.
        reconcilePublishing()
    }

    /** Disconnect from the LiveKit room (ViewModel.onCleared / leave). */
    fun disconnect() {
        hardTeardown()
        currentRoomName = null
        _connectionState.value = LkConnectionState.DISCONNECTED
        _speakingLevels.value = emptyMap()
        _connectedIdentities.value = emptyList()
    }

    fun destroy() {
        disconnect()
        scope.cancel()
    }

    // ---- internals -----------------------------------------------------------

    /**
     * Publishes the mic iff (mayPublish && permission && !soft-muted) and
     * removes the publication when rights are revoked. Never touches the
     * underlying connection.
     */
    private fun reconcilePublishing() {
        val shouldPublish = mayPublish && micPermission && micEnabled
        val existing = micTrack
        if (shouldPublish && existing == null) {
            scope.launch { publishMic() }
        } else if (!shouldPublish && existing != null) {
            scope.launch { unpublishMic() }
        } else if (existing != null) {
            scope.launch { runCatching { existing.enabled = micEnabled && mayPublish } }
        }
    }

    private suspend fun publishMic() {
        if (room.state != Room.State.CONNECTED || micTrack != null) return
        runCatching {
            val track = room.localParticipant.createAudioTrack()
            room.localParticipant.publishAudioTrack(track)
            track.enabled = micEnabled
            micTrack = track
        }.onFailure { Log.e(TAG, "publishMic failed", it) }
    }

    private suspend fun unpublishMic() {
        val track = micTrack ?: return
        micTrack = null
        runCatching {
            room.localParticipant.unpublishTrack(track)
        }
        runCatching { track.stop() }
    }

    private fun hardTeardown() {
        micTrack = null
        runCatching { room.disconnect() }
    }

    private var polling = false

    private fun startLevelPolling() {
        if (polling) return
        polling = true
        scope.launch {
            while (isActive && room.state == Room.State.CONNECTED) {
                val levels = HashMap<String, Double>()
                identityOf(room.localParticipant)?.let { levels[it] = room.localParticipant.audioLevel.toDouble() }
                room.remoteParticipants.values.forEach { p ->
                    identityOf(p)?.let { levels[it] = p.audioLevel.toDouble() }
                }
                _speakingLevels.value = levels
                delay(LEVEL_POLL_MS)
            }
            polling = false
        }
    }

    private fun refreshParticipants() {
        _connectedIdentities.value = room.remoteParticipants.values
            .mapNotNull { identityOf(it) }
    }

    /**
     * LiveKit identity is provisioned server-side; the backend mints tokens
     * with identity == user UUID (documented assumption in README).
     */
    private fun identityOf(participant: Participant): String? =
        participant.identity?.value

    private companion object {
        const val TAG = "LiveKitRoomManager"
        const val LEVEL_POLL_MS = 120L
    }
}
