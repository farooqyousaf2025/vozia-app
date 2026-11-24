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
import androidx.compose.material.icons.filled.FlashOn
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.tooling.preview.Preview
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
import com.voiza.app.domain.model.PkBattle
import com.voiza.app.domain.model.PkSide
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.DiamondChip
import com.voiza.app.ui.components.ListenerBadge
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.FlameBadge
import com.voiza.app.ui.components.StatusPill
import com.voiza.app.ui.components.StatusTone
import com.voiza.app.ui.screens.gift.GiftDialog
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.GiftPink
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.VoizaAccentGradient
import com.voiza.app.ui.theme.VoizaHeroGradient
import com.voiza.app.ui.theme.WarningAmber
import com.voiza.app.viewmodel.PartyRoomViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory
import kotlinx.coroutines.delay
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.Violet
import com.voiza.app.ui.theme.VioletLight
import com.voiza.app.ui.theme.VoizaBackground
import com.voiza.app.ui.theme.VoizaGoldGradient
import com.voiza.app.ui.theme.VoizaOutline
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaSurfaceVariant

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
    onOpenPk: () -> Unit,
    onEditRoom: () -> Unit,
    viewModel: PartyRoomViewModel = viewModel(
        key = "room-$roomId",
        factory = voizaViewModelFactory { PartyRoomViewModel(roomId) },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val socketConnected by viewModel.socketConnected.collectAsStateWithLifecycle()
    // All anchors are measured in root pixels. The flight layer is a root-level sibling, above
    // the audience strip, so a gift can travel between the strip and seats without being covered.
    val seatCentersInRoot = remember { mutableStateMapOf<Int, Offset>() }
    val audienceCentersInRoot = remember { mutableStateMapOf<String, Offset>() }
    var rootOverlayOriginInRoot by remember { mutableStateOf(Offset.Zero) }
    var seatLayerFallbackCenterInRoot by remember { mutableStateOf<Offset?>(null) }
    var audienceStripCenterInRoot by remember { mutableStateOf<Offset?>(null) }

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
            .background(VoizaHeroGradient)
            .onGloballyPositioned { coordinates ->
                val origin = coordinates.positionInRoot()
                if (origin != rootOverlayOriginInRoot) rootOverlayOriginInRoot = origin
            },
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
                    socketConnected = socketConnected,
                    livekitConnected = state.livekitState == com.voiza.app.data.livekit.LkConnectionState.CONNECTED,
                    onCloseRoom = viewModel::hostCloseRoom,
                    onOpenGames = onOpenGames,
                    onEditRoom = onEditRoom,
                    onBack = {
                        viewModel.leaveRoom()
                        onLeaveRoom()
                    },
                )

                // A short-lived line about something that just happened to *this* member: a seat
                // invite, an approved request. The server decided it; this only reports it back.
                state.roomNotice?.let { notice ->
                    LaunchedEffect(notice) {
                        delay(5_000)
                        viewModel.dismissRoomNotice()
                    }
                    RoomNoticePill(
                        text = notice,
                        onClick = viewModel::dismissRoomNotice,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
                    )
                }

                // The notice the host pinned for everyone, and the host's way to write it.
                AnnouncementBanner(
                    text = state.room?.announcement,
                    isHost = state.isHost,
                    onPin = viewModel::openAnnouncementEditor,
                )

                // Host-written house rules, for everyone in the room to read.
                state.room?.rules?.takeIf { it.isNotBlank() }?.let { rules ->
                    RulesBanner(rules = rules)
                }

                // PK: a live score strip when a battle is on, or the host's way in when it is not.
                PkRoomBanner(
                    battle = state.battle,
                    roomId = roomId,
                    isHost = state.isHost,
                    onClick = {
                        viewModel.refreshBattle()
                        onOpenPk()
                    },
                )

                // ---- Operator warning (host only; sent on the private channel) ----
                state.operatorWarning?.let { warning ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 4.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(DiamondGold.copy(alpha = 0.92f))
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                    ) {
                        Text(
                            text = "Voiza moderation: $warning",
                            color = VoizaBackground,
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
                                tint = VoizaBackground,
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
                        .weight(1f)
                        .onGloballyPositioned { coordinates ->
                            val origin = coordinates.positionInRoot()
                            val center = origin + Offset(coordinates.size.width / 2f, coordinates.size.height / 2f)
                            if (center != seatLayerFallbackCenterInRoot) seatLayerFallbackCenterInRoot = center
                        },
                ) {
                    SeatGrid(
                        seats = state.seats,
                        speakingLevels = state.speakingLevels,
                        onSeatClick = viewModel::onSeatTapped,
                        onSeatCenterPositioned = { seatIndex, center ->
                            if (seatCentersInRoot[seatIndex] != center) seatCentersInRoot[seatIndex] = center
                        },
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
                    seats = state.seats,
                    count = state.listenerCount,
                    handRaisedCount = state.handRaises.size,
                    barrageOn = barrageOn,
                    onToggleBarrage = { barrageOn = !barrageOn },
                    onOpenList = viewModel::openAudienceList,
                    onAvatarCenterPositioned = { userId, center ->
                        if (center == null) audienceCentersInRoot.remove(userId)
                        else if (audienceCentersInRoot[userId] != center) audienceCentersInRoot[userId] = center
                    },
                    onStripCenterPositioned = { center ->
                        if (audienceStripCenterInRoot != center) audienceStripCenterInRoot = center
                    },
                    modifier = Modifier.padding(vertical = 6.dp),
                )

                // ---- Chat overlay (semi-transparent, sits above actions) ----
                ChatOverlay(
                    messages = state.chat,
                    onSend = viewModel::sendChat,
                    emojis = state.emojis,
                    codePattern = state.emojiCodePattern,
                    onOpenMember = viewModel::openMemberSheet,
                    modifier = Modifier.padding(bottom = 4.dp),
                )

                // ---- Quick reactions (the operator's emoji, flown on a tap) ----
                ReactionStrip(
                    emojis = state.emojis,
                    onReaction = viewModel::sendReaction,
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

        // Draw gift flights at the room root, above both speaker seats and the audience strip.
        // The layer has no clickable content, so chat and room controls remain interactive.
        if (!state.loading && state.joined) {
            GiftFlightOverlay(
                events = state.giftTicker + state.giftQueue,
                seats = state.seats,
                seatCentersInRoot = seatCentersInRoot.toMap(),
                audienceCentersInRoot = audienceCentersInRoot.toMap(),
                audienceFallbackCenterInRoot = audienceStripCenterInRoot,
                seatLayerFallbackCenterInRoot = seatLayerFallbackCenterInRoot,
                coordinateOriginInRoot = rootOverlayOriginInRoot,
                hostId = state.room?.host?.id,
                modifier = Modifier.fillMaxSize(),
            )
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
                        .background(DangerRed.copy(alpha = 0.92f))
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

        // Reactions fly from the strip, so this box starts at its left edge and climbs over the
        // seats. No clickable child, so the chat underneath still scrolls through it.
        ReactionLayer(
            signal = state.reactions,
            modifier = Modifier
                .align(Alignment.BottomStart)
                .padding(start = 20.dp, bottom = 118.dp)
                .size(width = 150.dp, height = 220.dp),
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

        // ...and the ride they paid to arrive in, routed by the container the store row says the
        // file is in. A member with no `entryRide` on their join never reaches this line.
        val arrival = state.entryRide
        val wornRide = arrival?.user?.entryRide
        if (arrival != null && wornRide != null) {
            EntryRideOverlay(
                ride = wornRide,
                username = arrival.user.username,
                avatarUrl = arrival.user.avatarUrl,
                onFinished = viewModel::clearEntryRide,
            )
        }
    }

    // Password gate for PRIVATE rooms.
    if (state.needsPassword) {
        var pw by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { },
            containerColor = VoizaSurfaceHigh,
            title = { Text("Private room", color = OnDarkHigh) },
            text = {
                OutlinedTextField(
                    value = pw,
                    onValueChange = { pw = it.take(32) },
                    label = { Text("Room password", fontSize = 13.sp) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Fuchsia,
                        unfocusedBorderColor = VoizaOutline,
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

    // The host pins the notice every member sees above the seats.
    if (state.announcementEditorVisible) {
        AnnouncementEditorDialog(
            current = state.room?.announcement,
            onDismiss = viewModel::closeAnnouncementEditor,
            onSave = viewModel::setAnnouncement,
        )
    }

    // The host's seat invitation: the seat already exists, so this is the member's call about their
    // own microphone. There is no way out of it except an answer.
    state.invitedToSeat?.let { seatIndex ->
        AlertDialog(
            onDismissRequest = { },
            containerColor = VoizaSurfaceHigh,
            title = { Text("The host invited you up", color = OnDarkHigh) },
            text = {
                Text(
                    text = "Seat $seatIndex is yours. Your microphone stays off until you accept.",
                    color = OnDarkMedium,
                    fontSize = 13.sp,
                )
            },
            confirmButton = {
                VoizaActionButton(text = "Speak", enabled = true) { viewModel.acceptSeatInvite() }
            },
            dismissButton = {
                TextButton(onClick = viewModel::declineSeatInvite) {
                    Text("Not now", color = OnDarkMedium)
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
        speakerQueue = state.speakerQueue,
        hostId = state.room?.host?.id,
        isHost = state.isHost,
        invitableSeatIndex = state.invitableSeatIndex,
        onDismiss = viewModel::closeAudienceList,
        onApprove = viewModel::approveSpeakerRequest,
        onReject = viewModel::rejectSpeakerRequest,
        onInvite = viewModel::inviteListener,
        onOpenMember = viewModel::openMemberSheet,
    )

    // Somebody else's card: follow, report, block. Opened from a roster row or a held chat line.
    state.memberSheet?.let { card ->
        MemberSheet(
            member = card.member,
            relationship = card.relationship,
            busy = card.busy,
            error = card.error,
            onDismiss = viewModel::closeMemberSheet,
            onToggleFollow = viewModel::toggleFollow,
            onOpenReport = viewModel::openReportForm,
            onToggleBlock = viewModel::toggleBlock,
        )
        if (card.reportOpen) {
            ReportDialog(
                member = card.member,
                busy = card.busy,
                error = card.error,
                onDismiss = viewModel::closeReportForm,
                onSubmit = viewModel::submitReport,
            )
        }
    }

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
                    Text(tags, color = VioletLight, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                ListenerBadge(count = listenerCount)
                if (totalGiftValue > 0) FlameBadge(value = totalGiftValue)
                // Connection pill: socket + livekit health, labelled rather than a bare pip.
                val tone = when {
                    livekitConnected && socketConnected -> StatusTone.LIVE
                    livekitConnected || socketConnected -> StatusTone.WARN
                    else -> StatusTone.ERROR
                }
                StatusPill(
                    label = when (tone) {
                        StatusTone.LIVE -> "Live"
                        StatusTone.WARN -> "Syncing"
                        else -> "Offline"
                    },
                    tone = tone,
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
                tint = VioletLight,
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
                    tint = DangerRed,
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
            .background(VoizaSurfaceVariant.copy(alpha = 0.30f))
            .clickable { expanded = !expanded }
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Text(
            text = "House rules",
            color = VioletLight,
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

/**
 * The notice pinned above the seats. Members read it and nothing else; the host taps it to write
 * it, and keeps the affordance while it is empty so there is a way to pin the first line.
 */
@Composable
private fun AnnouncementBanner(
    text: String?,
    isHost: Boolean,
    onPin: () -> Unit,
) {
    val pinned = text?.takeIf { it.isNotBlank() }
    if (pinned == null && !isHost) return

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (pinned != null) Violet.copy(alpha = 0.25f) else Color(0x26FFFFFF))
            .clickable(enabled = isHost, onClick = onPin)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    ) {
        Icon(
            imageVector = Icons.Default.VoiceChat,
            contentDescription = null,
            tint = if (pinned != null) GiftPink else OnDarkMedium,
            modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.width(8.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = if (pinned != null) "Pinned by the host" else "Pin a notice",
                color = if (pinned != null) GiftPink else OnDarkMedium,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(1.dp))
            Text(
                text = pinned ?: "Tap to write what everyone should know",
                color = if (pinned == null) OnDarkMedium else OnDarkHigh,
                fontSize = 12.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (isHost) {
            Icon(
                imageVector = Icons.Default.Edit,
                contentDescription = "Edit pinned notice",
                tint = OnDarkMedium,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}

/** Composer for the pinned notice. Saving blank is the host's way to clear it, same as the API. */
@Composable
private fun AnnouncementEditorDialog(
    current: String?,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    var text by remember { mutableStateOf(current.orEmpty()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = VoizaSurfaceHigh,
        title = { Text("Pinned notice", color = OnDarkHigh) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it.take(300) },
                label = { Text("Notice for the room", fontSize = 13.sp) },
                minLines = 3,
                maxLines = 6,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Fuchsia,
                    unfocusedBorderColor = VoizaOutline,
                    focusedTextColor = OnDarkHigh,
                    unfocusedTextColor = OnDarkHigh,
                ),
            )
        },
        confirmButton = {
            VoizaActionButton(text = "Pin", enabled = text.isNotBlank()) { onSave(text.trim()) }
        },
        dismissButton = {
            Row {
                TextButton(onClick = { onSave("") }) {
                    Text("Clear", color = OnDarkMedium)
                }
                TextButton(onClick = onDismiss) {
                    Text("Cancel", color = OnDarkMedium)
                }
            }
        },
    )
}

/**
 * One line about something the server just did to this member. Tapping dismisses it; otherwise the
 * room stops showing it a few seconds later.
 */
@Composable
private fun RoomNoticePill(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(Mint.copy(alpha = 0.20f))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Text(text = text, color = Mint, fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

// ---------------------------------------------------------------------------
// PK strip
// ---------------------------------------------------------------------------

/**
 * The room's PK line. A live battle shows the two totals and the clock the server sent; with no
 * battle, the host gets the way into the desk and everybody else sees nothing. Tapping it opens
 * the PK screen as a child route, so the voice connection is not torn down.
 */
@Composable
private fun PkRoomBanner(
    battle: PkBattle?,
    roomId: String,
    isHost: Boolean,
    onClick: () -> Unit,
) {
    if (battle == null && !isHost) return

    val nowMs = rememberPkClock(enabled = battle?.isActive == true)
    val mySide = battle?.sideOf(roomId)
    val mine = when (mySide) {
        PkSide.A -> battle?.scoreA
        PkSide.B -> battle?.scoreB
        null -> null
    }
    val theirs = when (mySide) {
        PkSide.A -> battle?.scoreB
        PkSide.B -> battle?.scoreA
        null -> null
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Violet.copy(alpha = 0.20f))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Icon(
            Icons.Default.FlashOn,
            contentDescription = null,
            tint = if (battle?.isActive == true) WarningAmber else VioletLight,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(8.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = when {
                    battle == null -> "PK battle"
                    battle.isActive -> "PK \u00B7 ${battle.opponentOf(roomId)?.title.orEmpty()}"
                    else -> "PK invitation \u00B7 ${battle.opponentOf(roomId)?.title.orEmpty()}"
                },
                color = OnDarkHigh,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = when {
                    battle == null -> "Challenge another room \u2014 gifts decide the winner"
                    battle.isActive -> "This room %,d \u00B7 them %,d".format(mine ?: 0, theirs ?: 0)
                    mySide == PkSide.A -> "Waiting for the other host to answer"
                    else -> "Challenged \u2014 open to answer"
                },
                color = OnDarkMedium,
                fontSize = 10.sp,
                maxLines = 1,
            )
        }
        Text(
            text = when {
                battle == null -> "Open"
                battle.isActive -> battle.clockLabel(battle.remainingAt(nowMs))
                else -> "Waiting"
            },
            color = if (battle?.isActive == true) WarningAmber else VioletLight,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

/** A one-second clock for the strip; it only reads the device against the server's deadline. */
@Composable
private fun rememberPkClock(enabled: Boolean): Long {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(enabled) {
        while (enabled) {
            now = System.currentTimeMillis()
            kotlinx.coroutines.delay(1_000)
        }
    }
    return if (enabled) now else System.currentTimeMillis()
}

// ---------------------------------------------------------------------------
// Audience strip
// ---------------------------------------------------------------------------
@Composable
private fun AudienceStrip(
    audience: List<com.voiza.app.domain.model.MiniUser>,
    seats: List<com.voiza.app.domain.model.Seat>,
    count: Int,
    handRaisedCount: Int,
    barrageOn: Boolean,
    onToggleBarrage: () -> Unit,
    onOpenList: () -> Unit,
    onAvatarCenterPositioned: (String, Offset?) -> Unit,
    onStripCenterPositioned: (Offset) -> Unit,
    modifier: Modifier = Modifier,
) {
    // The room snapshot can include speakers as well as listeners. Only the actual audience
    // avatars belong in this strip and can be used as off-seat gift-flight anchors.
    val seatedIds = seats.asSequence()
        .filter { it.status == com.voiza.app.domain.model.SeatStatus.OCCUPIED }
        .mapNotNull { it.user?.id }
        .toSet()
    val listeners = audience.filterNot { it.id in seatedIds }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .padding(horizontal = 12.dp)
            .onGloballyPositioned { coordinates ->
                val origin = coordinates.positionInRoot()
                onStripCenterPositioned(origin + Offset(coordinates.size.width / 2f, coordinates.size.height / 2f))
            },
    ) {
        // The whole chip opens the roster sheet.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(VoizaSurfaceVariant.copy(alpha = 0.25f))
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
                    tint = VioletLight,
                    modifier = Modifier.size(12.dp),
                )
                Text(
                    text = " $handRaisedCount",
                    color = VioletLight,
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
            items(listeners.size, key = { idx -> listeners[idx].id }) { idx ->
                val user = listeners[idx]
                // LazyRow disposes avatars that scroll out of view. Remove their measured anchors
                // too, so a later gift never starts from a stale, off-screen position.
                DisposableEffect(user.id) {
                    onDispose { onAvatarCenterPositioned(user.id, null) }
                }
                Avatar(
                    url = user.avatarUrl,
                    name = user.username,
                    size = 26.dp,
                    modifier = Modifier.onGloballyPositioned { coordinates ->
                        val origin = coordinates.positionInRoot()
                        onAvatarCenterPositioned(
                            user.id,
                            origin + Offset(coordinates.size.width / 2f, coordinates.size.height / 2f),
                        )
                    },
                )
            }
        }
        // Barrage (danmaku) on/off, TUIKit-style.
        Text(
            text = if (barrageOn) "Barrage on" else "Barrage off",
            color = if (barrageOn) VioletLight else OnDarkMedium,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(VoizaSurfaceVariant.copy(alpha = 0.25f))
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
            .background(VoizaBackground.copy(alpha = 0.80f))
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .padding(bottom = 6.dp),
    ) {
        // Mic: only active when seated & publishing-capable.
        ActionCircle(
            enabled = canPublish,
            gradient = if (micMuted || !canPublish) null else VoizaAccentGradient,
            background = if (micMuted || !canPublish) VoizaSurfaceVariant else Color.Transparent,
            onClick = onToggleMic,
        ) {
            Icon(
                imageVector = if (micMuted) Icons.Default.MicOff else Icons.Default.Mic,
                contentDescription = if (micMuted) "Unmute" else "Mute",
                tint = if (!canPublish) OnDarkMuted else OnDarkHigh,
            )
        }

        // Raise hand (audience only).
        if (!seated) {
            ActionCircle(
                enabled = true,
                gradient = if (handRaised) VoizaAccentGradient else null,
                background = if (handRaised) Color.Transparent else VoizaSurfaceVariant,
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
                color = if (handRaised) VioletLight else OnDarkMedium,
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
                background = VoizaSurfaceVariant,
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
            gradient = VoizaGoldGradient,
            background = Color.Transparent,
            onClick = onOpenGifts,
        ) {
            Icon(Icons.Default.CardGiftcard, contentDescription = "Gifts", tint = OnDarkHigh)
        }

        // Leave.
        ActionCircle(
            enabled = true,
            gradient = null,
            background = DangerRed.copy(alpha = 0.20f),
            onClick = onLeave,
        ) {
            Icon(Icons.Default.PersonOff, contentDescription = "Leave room", tint = DangerRed)
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


@Preview(showBackground = true)
@Composable
fun PartyRoomScreenPreview() {
    PartyRoomScreen(roomId = "demo", onLeaveRoom = {}, onOpenGames = {}, onOpenPk = {}, onEditRoom = {})
}
