package com.voiza.app.ui.screens.friends

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.material3.Switch
import androidx.compose.ui.platform.LocalContext

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.Conversation
import com.voiza.app.domain.model.DirectMessage
import com.voiza.app.domain.model.FriendRequest
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.User
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.ListSkeleton
import com.voiza.app.ui.screens.home.voizaFieldColors
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.Violet
import com.voiza.app.ui.theme.VioletLight
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.viewmodel.FriendsTab
import com.voiza.app.viewmodel.FriendsViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * Friends, pending requests and direct messages (migration 0049).
 *
 * Every row is the server's copy. Accepting a request removes it locally only after the server
 * confirms the edge; a message is appended only when the POST returns the stored row, so a failed
 * send never leaves an unsent bubble behind.
 */
@Composable
fun FriendsScreen(
    onBack: () -> Unit,
    initialTab: FriendsTab = FriendsTab.FRIENDS,
    viewModel: FriendsViewModel = viewModel(
        factory = voizaViewModelFactory { FriendsViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var newFriendId by remember { mutableStateOf("") }
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val locationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        if (result.values.any { it }) viewModel.setLocationSharing(true)
        else viewModel.setLocationSharing(false)
    }

    // GPS is observed only while this screen is resumed and sharing is enabled.
    DisposableEffect(state.locationSharingEnabled, context, lifecycleOwner) {
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        var listener: LocationListener? = null
        fun stopUpdates() {
            listener?.let { try { manager.removeUpdates(it) } catch (_: SecurityException) { } }
            listener = null
        }
        fun startUpdates() {
            if (!state.locationSharingEnabled || listener != null) return
            val fine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            val coarse = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
            if (!fine && !coarse) return
            val provider = if (fine && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) LocationManager.GPS_PROVIDER else manager.getProviders(true).firstOrNull() ?: return
            val callback = object : LocationListener {
                override fun onLocationChanged(location: Location) {
                    viewModel.updateLocation(location.latitude, location.longitude)
                }
            }
            listener = callback
            try { manager.requestLocationUpdates(provider, 60_000L, 0f, callback, Looper.getMainLooper()) }
            catch (_: SecurityException) { listener = null }
        }
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) startUpdates()
            if (event == Lifecycle.Event.ON_PAUSE) stopUpdates()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) startUpdates()
        onDispose {
            stopUpdates()
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.load() }

    // The shell's Messages tab lands straight on the conversation list.
    LaunchedEffect(initialTab) {
        if (state.tab != initialTab) viewModel.selectTab(initialTab)
    }

    LaunchedEffect(state.message) {
        // The message is consumed by the effect so a rotate does not replay an old confirmation.
        if (state.message != null) viewModel.consumeMessage()
    }

    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp),
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
            }
            Text("Friends", color = OnDarkHigh, fontSize = 19.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            IconButton(onClick = viewModel::load) {
                Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = OnDarkMedium)
            }
        }

        val tabs = FriendsTab.entries
        TabRow(
            selectedTabIndex = tabs.indexOf(state.tab).coerceAtLeast(0),
            containerColor = Color.Transparent,
            contentColor = OnDarkHigh,
            divider = {},
            indicator = { positions ->
                Box(
                    Modifier
                        .tabIndicatorOffset(positions[tabs.indexOf(state.tab).coerceAtLeast(0)])
                        .height(3.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(com.voiza.app.ui.theme.VoizaAccentGradient),
                )
            },
        ) {
            tabs.forEach { tab ->
                val selected = state.tab == tab
                Tab(
                    selected = selected,
                    onClick = { viewModel.selectTab(tab) },
                    text = {
                        Text(
                            text = when (tab) {
                                FriendsTab.FRIENDS -> "Friends"
                                FriendsTab.REQUESTS -> "Requests"
                                FriendsTab.MESSAGES -> "Messages"
                            },
                            fontSize = 14.sp,
                            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                            color = if (selected) Violet else OnDarkMedium,
                        )
                    },
                )
            }
        }

        Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
            when {
                state.loading && state.friends.isEmpty() && state.incoming.isEmpty() && state.conversations.isEmpty() ->
                    ListSkeleton(rows = 6, modifier = Modifier.padding(20.dp))

                state.isGuest -> EmptyState(
                    icon = Icons.Default.Person,
                    title = "Log in to see your friends",
                    subtitle = "Friends and messages belong to your account.",
                    action = {
                        VoizaButton(text = "Back", onClick = onBack, height = 44, modifier = Modifier.width(140.dp))
                    },
                )

                state.error != null && state.friends.isEmpty() && state.incoming.isEmpty() && state.conversations.isEmpty() ->
                    EmptyState(
                        icon = Icons.Default.Person,
                        title = state.error ?: "Nothing loaded",
                        subtitle = "Nothing here is cached — the lists come from the server",
                        action = {
                            VoizaButton(text = "Try again", onClick = viewModel::load, height = 44, modifier = Modifier.width(140.dp))
                        },
                    )

                else -> when (state.tab) {
                    FriendsTab.FRIENDS -> FriendsList(
                        state = state,
                        newFriendId = newFriendId,
                        onNewFriendId = { newFriendId = it },
                        onAdd = {
                            viewModel.sendFriendRequest(newFriendId.trim())
                            if (newFriendId.isNotBlank()) newFriendId = ""
                        },
                        onOpen = viewModel::openConversation,
                        onUnfriend = viewModel::unfriend,
                        onLocationSharingChange = { enabled ->
                            if (!enabled) viewModel.setLocationSharing(false)
                            else {
                                val allowed = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                                if (allowed) viewModel.setLocationSharing(true)
                                else locationPermissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION))
                            }
                        },
                    )

                    FriendsTab.REQUESTS -> RequestsList(state = state, viewModel = viewModel)

                    FriendsTab.MESSAGES -> MessagesPane(
                        state = state,
                        onDraft = viewModel::onDraftChange,
                        onSend = viewModel::sendMessage,
                        onOpen = viewModel::openConversation,
                    )
                }
            }

            if (state.error != null && (state.friends.isNotEmpty() || state.incoming.isNotEmpty() || state.conversations.isNotEmpty())) {
                Text(
                    text = state.error ?: "",
                    color = DangerRed,
                    fontSize = 12.sp,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(12.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(VoizaSurfaceHigh)
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun FriendsList(
    state: FriendsViewModel.FriendsUiState,
    newFriendId: String,
    onNewFriendId: (String) -> Unit,
    onAdd: () -> Unit,
    onOpen: (MiniUser) -> Unit,
    onUnfriend: (String) -> Unit,
    onLocationSharingChange: (Boolean) -> Unit,
) {
    LazyColumn(
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            VoizaCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Share live distance", color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        Text("Distance is visible only when both friends opt in. Sharing is optional and revocable.", color = OnDarkMedium, fontSize = 11.sp)
                    }
                    Switch(checked = state.locationSharingEnabled, onCheckedChange = onLocationSharingChange)
                }
            }
        }
        item {
            VoizaCard {
                Text("Add a friend", color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = newFriendId,
                    onValueChange = onNewFriendId,
                    label = { Text("Member ID") },
                    singleLine = true,
                    colors = voizaFieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                VoizaButton(
                    text = if (state.busy) "Sending…" else "Send request",
                    onClick = onAdd,
                    enabled = newFriendId.isNotBlank() && !state.busy,
                    height = 44,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        item {
            Text(
                text = "Your friends (${state.friends.size})",
                color = OnDarkMedium,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
        if (state.friends.isEmpty()) {
            item {
                EmptyState(
                    icon = Icons.Default.Person,
                    title = "No friends yet",
                    subtitle = "Add a member by ID, then say hello once they accept.",
                )
            }
        } else {
            items(state.friends, key = { it.id }) { friend ->
                VoizaCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Avatar(url = friend.avatarUrl, name = friend.username, size = 42.dp)
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(friend.username, color = OnDarkHigh, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("VIP ${friend.vipLevel}", color = OnDarkMuted, fontSize = 11.sp)
                            val meters = state.friendDistances[friend.id]
                            Text(
                                text = if (meters == null) "Distance unavailable" else if (meters < 1000) "$meters m away" else String.format("%.1f km away", meters / 1000.0),
                                color = if (meters == null) OnDarkMuted else Cyan,
                                fontSize = 10.sp,
                            )
                        }
                        SmallAction(label = "Chat", onClick = { onOpen(friend) })
                        Spacer(Modifier.width(6.dp))
                        SmallAction(label = "Remove", onClick = { onUnfriend(friend.id) }, tint = DangerRed)
                    }
                }
            }
        }
    }
}

@Composable
private fun RequestsList(
    state: FriendsViewModel.FriendsUiState,
    viewModel: FriendsViewModel,
) {
    LazyColumn(
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            Text("Incoming (${state.incoming.size})", color = OnDarkMedium, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        }
        if (state.incoming.isEmpty()) {
            item { EmptyState(icon = Icons.Default.PersonAdd, title = "No incoming requests") }
        } else {
            items(state.incoming, key = { it.id }) { request ->
                RequestRow(
                    request = request,
                    myId = state.user?.id.orEmpty(),
                    busy = state.busy,
                    onAccept = { viewModel.acceptRequest(request.id) },
                    onDecline = { viewModel.declineRequest(request.id) },
                )
            }
        }
        item {
            Text(
                text = "Sent (${state.outgoing.size})",
                color = OnDarkMedium,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = 10.dp),
            )
        }
        if (state.outgoing.isEmpty()) {
            item { EmptyState(icon = Icons.Default.PersonAdd, title = "No sent requests") }
        } else {
            items(state.outgoing, key = { it.id }) { request ->
                VoizaCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Avatar(url = request.addressee.avatarUrl, name = request.addressee.username, size = 38.dp)
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text(request.addressee.username, color = OnDarkHigh, fontWeight = FontWeight.SemiBold)
                            Text(request.statusLabel, color = OnDarkMuted, fontSize = 11.sp)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RequestRow(
    request: FriendRequest,
    myId: String,
    busy: Boolean,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
) {
    val other = request.otherParty(myId)
    VoizaCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(url = other.avatarUrl, name = other.username, size = 38.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(other.username, color = OnDarkHigh, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(request.statusLabel, color = OnDarkMuted, fontSize = 11.sp)
            }
            IconButton(onClick = onDecline, enabled = !busy) {
                Icon(Icons.Default.Close, contentDescription = "Decline", tint = DangerRed)
            }
            IconButton(onClick = onAccept, enabled = !busy) {
                Icon(Icons.Default.Check, contentDescription = "Accept", tint = Mint)
            }
        }
    }
}

@Composable
private fun MessagesPane(
    state: FriendsViewModel.FriendsUiState,
    onDraft: (String) -> Unit,
    onSend: () -> Unit,
    onOpen: (MiniUser) -> Unit,
) {
    val partner = state.openPartner
    if (partner == null) {
        LazyColumn(
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            item { Text("Conversations (${state.conversations.size})", color = OnDarkMedium, fontSize = 12.sp, fontWeight = FontWeight.SemiBold) }
            if (state.conversations.isEmpty()) {
                item {
                    EmptyState(
                        icon = Icons.AutoMirrored.Filled.Send,
                        title = "No conversations yet",
                        subtitle = "Open a friend from the Friends tab to start one.",
                    )
                }
            } else {
                items(state.conversations, key = { it.id }) { conversation ->
                    ConversationRow(conversation = conversation, onClick = { onOpen(conversation.partner) })
                }
            }
        }
        return
    }

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
            Avatar(url = partner.avatarUrl, name = partner.username, size = 36.dp)
            Spacer(Modifier.width(10.dp))
            Text(partner.username, color = OnDarkHigh, fontWeight = FontWeight.Bold)
        }
        LazyColumn(
            reverseLayout = true,
            contentPadding = PaddingValues(vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxWidth().weight(1f),
        ) {
            items(state.messages, key = { it.id }) { message ->
                MessageBubble(message = message, mine = message.senderId == state.user?.id)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
            OutlinedTextField(
                value = state.draft,
                onValueChange = onDraft,
                label = { Text("Message") },
                singleLine = true,
                colors = voizaFieldColors(),
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            IconButton(onClick = onSend, enabled = state.draft.isNotBlank() && !state.busy) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send", tint = if (state.busy) OnDarkMuted else Violet)
            }
        }
    }
}

@Composable
private fun ConversationRow(conversation: Conversation, onClick: () -> Unit) {
    // The pair is keyed by the other member on the server, so the row always names the partner.
    val partner = conversation.partner
    VoizaCard(modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Avatar(url = partner.avatarUrl, name = partner.username, size = 40.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(partner.username, color = OnDarkHigh, fontWeight = FontWeight.SemiBold)
                Text(
                    text = conversation.lastMessagePreview
                        ?: if (conversation.lastMessageAt == null) "No messages yet" else "Open to view messages",
                    color = OnDarkMuted,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (conversation.unreadCount > 0) {
                Text(
                    text = conversation.unreadCount.toString(),
                    color = OnDarkHigh,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                    modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(Violet).padding(horizontal = 8.dp, vertical = 3.dp),
                )
            }
            Spacer(Modifier.width(6.dp))
            SmallAction(label = "Open", onClick = onClick)
        }
    }
}

@Composable
private fun MessageBubble(message: DirectMessage, mine: Boolean) {
    val background = if (mine) VoizaSurfaceHigh else VoizaSurfaceHigh.copy(alpha = 0.80f)
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
    ) {
        Text(
            text = message.content,
            color = OnDarkHigh,
            fontSize = 13.sp,
            modifier = Modifier
                .clip(RoundedCornerShape(14.dp))
                .background(background)
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .fillMaxWidth(0.8f),
        )
        Row(
            modifier = Modifier.fillMaxWidth(0.8f).padding(top = 2.dp, end = 3.dp),
            horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = messageTime(message.createdAt),
                color = OnDarkMuted,
                fontSize = 9.sp,
            )
            if (mine) {
                Spacer(Modifier.width(6.dp))
                Text(
                    text = if (message.readAt != null) "Read ✓✓" else "Sent ✓",
                    color = if (message.readAt != null) Cyan else OnDarkMuted,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

private fun messageTime(value: String): String {
    val parsed = runCatching {
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.parse(value)
    }.getOrNull() ?: return ""
    return SimpleDateFormat("h:mm a", Locale.getDefault()).format(parsed)
}

@Composable
private fun SmallAction(label: String, onClick: () -> Unit, tint: Color = VioletLight) {
    Text(
        text = label,
        color = tint,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(VoizaSurfaceHigh)
            .clickable(onClick = onClick)
            .padding(horizontal = 9.dp, vertical = 6.dp),
    )
}
