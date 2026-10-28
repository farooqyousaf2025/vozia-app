package com.voiza.app.ui.screens.room

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.SportsEsports
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material.icons.filled.VoiceChat
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.DiamondChip
import com.voiza.app.ui.components.ListenerBadge
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.FlameBadge
import com.voiza.app.ui.screens.gift.GiftDialog
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.GiftPink
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.VoizaAccentGradient
import com.voiza.app.ui.theme.VoizaHeroGradient
import com.voiza.app.viewmodel.PartyRoomViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * The core experience. Owns: join -> LiveKit connect (publish only when
 * canPublish AND RECORD_AUDIO granted) -> seat grid with speaking rings,
 * audience strip, chat overlay, action bar, host sheet, gift dialog and the
 * queued full-screen gift animation.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PartyRoomScreen(
    roomId: String,
    onLeaveRoom: () -> Unit,
    onOpenGames: () -> Unit,
    onEditRoom: () -> Unit,
    viewModel: PartyRoomViewModel = viewModel(
        key = "room-$roomId",
        factory = voizaViewModelFactory { PartyRoomViewModel(roomId) },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // Runtime mic permission: request once we may publish without the grant.
    var permissionAsked by remember { mutableStateOf(false) }
    // Viewer preference for the danmaku layer; not persisted by design.
    var barrageOn by remember { mutableStateOf(true) }
    val micLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        viewModel.onMicPermissionResult(granted)
    }
    LaunchedEffect(state.canPublish, state.joined) {
        if (state.joined && state.canPublish && !permissionAsked) {
            permissionAsked = true
            micLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    // Room closed by host or server, or we were kicked out of a seat -> exit.
    LaunchedEffect(state.roomClosed, state.kicked) {
        if (state.roomClosed || state.kicked) {
            viewModel.leaveRoom()
            onLeaveRoom()
        }
    }

    // Entry flourish: once per room visit, not on every recomposition/retry.
    var welcomeVisible by remember(roomId) { mutableStateOf(false) }
    LaunchedEffect(state.joined) { if (state.joined) welcomeVisible = true }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(VoizaHeroGradient),
    ) {
        // Theme wallpaper from the backend, then the ambient loop it pairs with.
        RoomWallpaper(wallpaperUrl = state.room?.themeWallpaper)
        if (state.joined) {
            // The server picks the loop from the room category.
            AmbientRoomEffect(effectUrl = state.room?.ambientEffect)
        }
        if (state.loading) {
            LoadingProgress(overlay = true)
        } else {
            Column(modifier = Modifier
                .fillMaxSize()
                .imePadding()) {

                RoomTopBar(
                    title = state.room?.title ?: "Room",
                    roomNumber = state.room?.roomNumber,
                    language = state.room?.language,
                    region = state.room?.region,
                    listenerCount = state.listenerCount,
                    totalGiftValue = state.room?.totalGiftValue ?: 0,
                    diamondBalance = state.user?.diamondBalance,
                    isHost = state.isHost,
                    socketConnected = true,
                    livekitConnected = state.livekitState == com.voiza.app.data.livekit.LkConnectionState.CONNECTED,
                    onCloseRoom = viewModel::hostCloseRoom,
                    onOpenGames = onOpenGames,
                    onEditRoom = onEditRoom,
                    onBack = {
                        viewModel.leaveRoom()
                        onLeaveRoom()
                    },
                )

                // Host-written house rules, for everyone in the room to read.
                state.room?.rules?.takeIf { it.isNotBlank() }?.let { rules ->
                    RulesBanner(rules = rules)
                }

                // ---- Operator warning (host only; sent on the private channel) ----
                state.operatorWarning?.let { warning ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 4.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(Color(0xE6C8A233))
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                    ) {
                        Text(
                            text = "Voiza moderation: $warning",
                            color = OnDarkHigh,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f),
                        )
                        IconButton(
                            onClick = viewModel::dismissWarning,
                            modifier = Modifier.size(20.dp),
                        ) {
                            Icon(
                                Icons.Default.Close,
                                contentDescription = "Dismiss warning",
                                tint = OnDarkHigh,
                                modifier = Modifier.size(16.dp),
                            )
                        }
                    }
                }

                // ---- Seats (with the danmaku layer floating over them) ----
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                ) {
                    SeatGrid(
                        seats = state.seats,
                        speakingLevels = state.speakingLevels,
                        onSeatClick = viewModel::onSeatTapped,
                    )
                    BarrageOverlay(
                        messages = state.chat,
                        enabled = barrageOn,
                        emojis = state.emojis,
                        codePattern = state.emojiCodePattern,
                        modifier = Modifier.align(Alignment.TopStart),
                    )
                    // Small gifts scroll here; big ones take the whole screen via
                    // GiftEffectOverlay below.
                    GiftTickerColumn(
                        events = state.giftTicker,
                        onFinished = viewModel::onTickerFinished,
                        modifier = Modifier
                            .align(Alignment.CenterEnd)
                            .padding(end = 10.dp),
                    )
                    EntryBanner(
                        event = state.entryBanner,
                        onDismiss = viewModel::clearEntryBanner,
                        modifier = Modifier
                            .align(Alignment.BottomStart)
                            .padding(start = 12.dp, bottom = 6.dp),
                    )
                }

                // ---- Audience strip (tap for the full roster) ----
                AudienceStrip(
                    audience = state.audience,
                    count = state.listenerCount,
                    handRaisedCount = state.handRaises.size,
                    barrageOn = barrageOn,
                    onToggleBarrage = { barrageOn = !barrageOn },
                    onOpenList = viewModel::openAudienceList,
                    modifier = Modifier.padding(vertical = 6.dp),
                )

                // ---- Chat overlay (semi-transparent, sits above actions) ----
                ChatOverlay(
                    messages = state.chat,
                    onSend = viewModel::sendChat,
                    emojis = state.emojis,
                    codePattern = state.emojiCodePattern,
                    modifier = Modifier.padding(bottom = 4.dp),
                )

                // ---- Action bar ----
                RoomActionBar(
                    seated = state.seated,
                    canPublish = state.canPublish,
                    micMuted = state.micMuted,
                    handRaised = state.handRaised,
                    likeTotal = state.likeTotal,
                    onToggleMic = viewModel::toggleOwnMic,
                    onRaiseHand = viewModel::toggleRaiseHand,
                    onLike = viewModel::onLikeTapped,
                    onOpenGifts = viewModel::openGiftDialog,
                    onLeave = {
                        viewModel.leaveRoom()
                        onLeaveRoom()
                    },
                )
            }
        }

        // Error snackbar-ish line
        state.error?.let { err ->
            Box(
                contentAlignment = Alignment.TopCenter,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 96.dp),
            ) {
                Text(
                    text = err,
                    color = OnDarkHigh,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .clip(RoundedCornerShape(10.dp))
                        .background(Color(0xE6FF5B6E))
                        .clickable { viewModel.clearError() }
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
        }

        // Hearts fly out of the like button. The layer has no clickable child, so
        // it never blocks the bar underneath it.
        HeartLayer(
            signal = state.hearts,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 18.dp, bottom = 92.dp)
                .size(width = 92.dp, height = 200.dp),
        )

        // Null until the catalogue answers, and null forever if the operator has no
        // welcome animation — then the room simply opens without a flourish.
        if (welcomeVisible && state.welcomeEffect != null) {
            WelcomeEffect(
                welcomeUrl = state.welcomeEffect,
                onFinished = { welcomeVisible = false },
            )
        }

        // Another member's paid entry flourish, named by the server on their join payload.
        // Their banner still shows either way; this only adds the scene they bought.
        if (state.entryFlourish != null) {
            WelcomeEffect(
                welcomeUrl = state.entryFlourish,
                onFinished = viewModel::clearEntryFlourish,
            )
        }
    }

    // Password gate for PRIVATE rooms.
    if (state.needsPassword) {
        var pw by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { },
            containerColor = Color(0xFF151233),
            title = { Text("Private room", color = OnDarkHigh) },
            text = {
                OutlinedTextField(
                    value = pw,
                    onValueChange = { pw = it.take(16) },
                    label = { Text("Room password", fontSize = 13.sp) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Fuchsia,
                        unfocusedBorderColor = Color(0xFF3D3670),
                        focusedTextColor = OnDarkHigh,
                        unfocusedTextColor = OnDarkHigh,
                    ),
                )
            },
            confirmButton = {
                VoizaActionButton(text = "Join", enabled = pw.isNotBlank()) {
                    viewModel.submitRoomPassword(pw)
                }
            },
            dismissButton = {
                TextButton(onClick = onLeaveRoom) {
                    Text("Back", color = OnDarkMedium)
                }
            },
        )
    }

    // Host per-seat controls.
    HostControlsSheet(
        seat = state.hostControlsSeat,
        isHost = state.isHost,
        onDismiss = viewModel::dismissHostControls,
        onToggleLock = viewModel::hostToggleLock,
        onToggleMute = viewModel::hostToggleMute,
        onKick = viewModel::hostKick,
    )

    // Full roster: who is on mic, who is waiting to speak, who is listening.
    AudienceListSheet(
        visible = state.audienceSheetVisible,
        seats = state.seats,
        audience = state.audience,
        handRaises = state.handRaises,
        hostId = state.room?.host?.id,
        onDismiss = viewModel::closeAudienceList,
    )

    // Gift catalogue dialog.
    GiftDialog(
        state = state,
        onTapGift = viewModel::tapGiftTile,
        onSelectCategory = viewModel::setGiftCategory,
        onSelectReceiver = viewModel::selectReceiver,
        onQuantitySet = viewModel::setGiftQuantity,
        onSend = viewModel::sendSelectedGift,
        onOpenRanking = viewModel::openRanking,
        onDismiss = viewModel::closeGiftDialog,
    )

    // Who is carrying the room, opened from the gift panel.
    GiftRankingSheet(
        visible = state.rankingVisible,
        board = state.rankingBoard,
        window = state.rankingWindow,
        leaderboard = state.ranking,
        loading = state.rankingLoading,
        error = state.rankingError,
        onSelectBoard = viewModel::setRankingBoard,
        onSelectWindow = viewModel::setRankingWindow,
        onDismiss = viewModel::closeRanking,
    )

    // Full-screen queued gift animation.
    GiftEffectOverlay(
        queue = state.giftQueue,
        onFinished = viewModel::onGiftEffectFinished,
    )
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

@Composable
private fun RoomTopBar(
    title: String,
    roomNumber: Int?,
    language: String?,
    region: String?,
    listenerCount: Int,
    totalGiftValue: Long,
    diamondBalance: Int?,
    isHost: Boolean,
    socketConnected: Boolean,
    livekitConnected: Boolean,
    onCloseRoom: () -> Unit,
    onOpenGames: () -> Unit,
    onEditRoom: () -> Unit,
    onBack: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 8.dp),
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Leave", tint = OnDarkHigh)
        }
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = title,
                    color = OnDarkHigh,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                )
                if (roomNumber != null) {
                    Spacer(Modifier.width(6.dp))
                    Text("#$roomNumber", color = OnDarkMedium, fontSize = 11.sp)
                }
                // Only what the host actually stated; a room with no language says nothing.
                val tags = listOfNotNull(language, region).joinToString(" \u00B7 ")
                if (tags.isNotBlank()) {
                    Spacer(Modifier.width(6.dp))
                    Text(tags, color = Cyan, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                ListenerBadge(count = listenerCount)
                if (totalGiftValue > 0) FlameBadge(value = totalGiftValue)
                // Connection pip: socket + livekit health at a glance.
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(
                            when {
                                livekitConnected && socketConnected -> Mint
                                livekitConnected || socketConnected -> Color(0xFFFFC246)
                                else -> Color(0xFFFF5B6E)
                            }
                        ),
                    content = {},
                )
            }
        }
        DiamondChip(balance = diamondBalance)
        // The match desk belongs to this room, so it opens from here and the room
        // entry stays on the back stack (voice connection survives the visit).
        IconButton(onClick = onOpenGames) {
            Icon(
                imageVector = Icons.Default.SportsEsports,
                contentDescription = "Games",
                tint = Cyan,
            )
        }
        if (isHost) {
            IconButton(onClick = onEditRoom) {
                Icon(
                    imageVector = Icons.Default.Edit,
                    contentDescription = "Edit room",
                    tint = OnDarkHigh,
                )
            }
            IconButton(onClick = onCloseRoom) {
                Icon(
                    imageVector = Icons.Default.Close,
                    contentDescription = "Close room",
                    tint = Color(0xFFFF5B6E),
                )
            }
        }
    }
}

/**
 * House rules the host wrote. Two lines until tapped, because a rule list should not push the
 * seats off screen on a phone.
 */
@Composable
private fun RulesBanner(rules: String) {
    var expanded by remember(rules) { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0x4D231F4E))
            .clickable { expanded = !expanded }
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Text(
            text = "House rules",
            color = Cyan,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(2.dp))
        Text(
            text = rules,
            color = OnDarkHigh,
            fontSize = 12.sp,
            maxLines = if (expanded) 12 else 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

// ---------------------------------------------------------------------------
// Audience strip
// ---------------------------------------------------------------------------
@Composable
private fun AudienceStrip(
    audience: List<com.voiza.app.domain.model.MiniUser>,
    count: Int,
    handRaisedCount: Int,
    barrageOn: Boolean,
    onToggleBarrage: () -> Unit,
    onOpenList: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier.padding(horizontal = 12.dp),
    ) {
        // The whole chip opens the roster sheet.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(Color(0x40231F4E))
                .clickable(onClick = onOpenList)
                .padding(horizontal = 10.dp, vertical = 5.dp),
        ) {
            Text(
                text = "Audience \u00B7 $count",
                color = OnDarkHigh,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
            )
            if (handRaisedCount > 0) {
                Spacer(Modifier.width(6.dp))
                Icon(
                    imageVector = Icons.Default.VoiceChat,
                    contentDescription = "$handRaisedCount waiting to speak",
                    tint = GiftPink,
                    modifier = Modifier.size(12.dp),
                )
                Text(
                    text = " $handRaisedCount",
                    color = GiftPink,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            Spacer(Modifier.width(5.dp))
            Text("\u203A", color = OnDarkMedium, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(10.dp))
        androidx.compose.foundation.lazy.LazyRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.weight(1f),
        ) {
            items(audience.size) { idx ->
                val u = audience[idx]
                Avatar(url = u.avatarUrl, name = u.username, size = 26.dp)
            }
        }
        // Barrage (danmaku) on/off, TUIKit-style.
        Text(
            text = if (barrageOn) "Barrage on" else "Barrage off",
            color = if (barrageOn) Cyan else OnDarkMedium,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(Color(0x40231F4E))
                .clickable(onClick = onToggleBarrage)
                .padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

// ---------------------------------------------------------------------------
// Bottom action bar
// ---------------------------------------------------------------------------

@Composable
private fun RoomActionBar(
    seated: Boolean,
    canPublish: Boolean,
    micMuted: Boolean,
    handRaised: Boolean,
    likeTotal: Long,
    onToggleMic: () -> Unit,
    onRaiseHand: () -> Unit,
    onLike: () -> Unit,
    onOpenGifts: () -> Unit,
    onLeave: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xCC120F2B))
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .padding(bottom = 6.dp),
    ) {
        // Mic: only active when seated & publishing-capable.
        ActionCircle(
            enabled = canPublish,
            gradient = if (micMuted || !canPublish) null else VoizaAccentGradient,
            background = if (micMuted || !canPublish) Color(0xFF241F3D) else Color.Transparent,
            onClick = onToggleMic,
        ) {
            Icon(
                imageVector = if (micMuted) Icons.Default.MicOff else Icons.Default.Mic,
                contentDescription = if (micMuted) "Unmute" else "Mute",
                tint = if (!canPublish) Color(0xFF6A6490) else OnDarkHigh,
            )
        }

        // Raise hand (audience only).
        if (!seated) {
            ActionCircle(
                enabled = true,
                gradient = if (handRaised) VoizaAccentGradient else null,
                background = if (handRaised) Color.Transparent else Color(0xFF241F3D),
                onClick = onRaiseHand,
            ) {
                Icon(
                    imageVector = Icons.Default.VoiceChat,
                    contentDescription = "Raise hand",
                    tint = if (handRaised) OnDarkHigh else OnDarkMedium,
                )
            }
            Text(
                text = if (handRaised) "Requested" else "Raise hand",
                color = if (handRaised) Cyan else OnDarkMedium,
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }

        Spacer(Modifier.weight(1f))

        // Likes. The server counts them; this button only reports intent, and the
        // number shown is always the server's total.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ActionCircle(
                enabled = true,
                gradient = null,
                background = Color(0xFF241F3D),
                onClick = onLike,
            ) {
                Icon(Icons.Default.Favorite, contentDescription = "Like the room", tint = GiftPink)
            }
            Text(
                text = likeLabel(likeTotal),
                color = GiftPink,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
            )
        }

        // Gift box — the money button.
        ActionCircle(
            enabled = true,
            gradient = Brush.horizontalGradient(listOf(Color(0xFFFF6EC7), Fuchsia)),
            background = Color.Transparent,
            onClick = onOpenGifts,
        ) {
            Icon(Icons.Default.CardGiftcard, contentDescription = "Gifts", tint = OnDarkHigh)
        }

        // Leave.
        ActionCircle(
            enabled = true,
            gradient = null,
            background = Color(0x33FF5B6E),
            onClick = onLeave,
        ) {
            Icon(Icons.Default.PersonOff, contentDescription = "Leave room", tint = Color(0xFFFF5B6E))
        }
    }
}

/** A like count a viewer can read at a glance without scrolling the bar. */
private fun likeLabel(total: Long): String =
    if (total < 10_000) total.toString() else "${total / 1000}k+"

@Composable
private fun ActionCircle(
    enabled: Boolean,
    gradient: Brush?,
    background: Color,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(46.dp)
            .clip(CircleShape)
            .then(if (gradient != null && enabled) Modifier.background(gradient) else Modifier.background(background))
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier),
    ) { content() }
}

// ---------------------------------------------------------------------------
// Small shared bits (kept local to this file to avoid cross-file churn)
// ---------------------------------------------------------------------------

@Composable
private fun VoizaActionButton(
    text: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    TextButton(onClick = onClick, enabled = enabled) {
        Text(
            text = text,
            color = if (enabled) Fuchsia else OnDarkMedium,
            fontWeight = FontWeight.Bold,
        )
    }
}
