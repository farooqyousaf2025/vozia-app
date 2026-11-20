package com.voiza.app.ui.screens.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.Wallet
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabPosition
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.voiza.app.domain.model.BannerPlacement
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.RankingLeader
import com.voiza.app.domain.model.RankingPeriod
import com.voiza.app.domain.model.RoomCategory
import com.voiza.app.domain.model.RoomSort
import com.voiza.app.domain.model.RoomStatus
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.domain.model.RoomType
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.components.DiamondChip
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.FlameBadge
import com.voiza.app.ui.components.ListenerBadge
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaTextButton
import com.voiza.app.ui.components.banner.PromoBannerStrip
import com.voiza.app.ui.screens.quests.DailyRewardDialog
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.GiftPink
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.VoizaAccentGradient
import com.voiza.app.ui.theme.VoizaHeroGradient
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaTheme
import com.voiza.app.ui.theme.WarningAmber
import com.voiza.app.ui.util.label
import com.voiza.app.viewmodel.HomeViewModel
import com.voiza.app.viewmodel.QuestsViewModel
import com.voiza.app.viewmodel.RankingsViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * Home lobby with a Voiza bottom bar (Rooms only — Wallet/Profile are
 * separate routes reached from the bar), category tabs driving the API
 * filter, and a pull-to-refresh room grid.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    onOpenRoom: (String) -> Unit,
    onCreateRoom: () -> Unit,
    onOpenWallet: () -> Unit,
    onOpenStore: () -> Unit,
    onOpenProfile: () -> Unit,
    onOpenRankings: () -> Unit,
    viewModel: HomeViewModel = viewModel(
        factory = voizaViewModelFactory { HomeViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val questsViewModel: QuestsViewModel = viewModel(factory = voizaViewModelFactory { QuestsViewModel() })
    val questsState by questsViewModel.state.collectAsStateWithLifecycle()
    // The entry card's avatars are the server's own monthly top three, not a local guess.
    val rankingsPreview: RankingsViewModel = viewModel(
        factory = voizaViewModelFactory { RankingsViewModel(initialPeriod = RankingPeriod.MONTH) },
    )
    val previewState by rankingsPreview.state.collectAsStateWithLifecycle()
    var rewardOpen by remember { mutableStateOf(false) }
    // The lobby opens without a search box; the top-bar icon reveals it. An active query keeps it
    // open on its own so the member can always see (and clear) what the grid is filtered by.
    var searchOpen by remember { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        questsViewModel.refresh()
        rankingsPreview.refresh()
    }

    // Quick Join is answered by the server, so the screen only follows the id it hands back.
    LaunchedEffect(state.quickJoinRoomId) {
        state.quickJoinRoomId?.let { roomId ->
            viewModel.quickJoinHandled()
            onOpenRoom(roomId)
        }
    }

    Scaffold(
        containerColor = androidx.compose.material3.MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = VoizaSurface, tonalElevation = 0.dp) {
                NavigationBarItem(
                    selected = true,
                    onClick = {},
                    icon = { Icon(Icons.Default.Home, contentDescription = "Rooms") },
                    label = { Text("Rooms") },
                    colors = navItemColors(),
                )
                NavigationBarItem(
                    selected = false,
                    onClick = onOpenStore,
                    icon = { Icon(Icons.Default.ShoppingCart, contentDescription = "Store") },
                    label = { Text("Store") },
                    colors = navItemColors(),
                )
                NavigationBarItem(
                    selected = false,
                    onClick = onOpenWallet,
                    icon = { Icon(Icons.Default.Wallet, contentDescription = "Wallet") },
                    label = { Text("Wallet") },
                    colors = navItemColors(),
                )
                NavigationBarItem(
                    selected = false,
                    onClick = onOpenProfile,
                    icon = { Icon(Icons.Default.Person, contentDescription = "Profile") },
                    label = { Text("Profile") },
                    colors = navItemColors(),
                )
            }
        },
    ) { innerPadding ->
        Column(modifier = Modifier.padding(innerPadding)) {
            HomeTopBar(
                user = state.user,
                onWalletClick = onOpenWallet,
                rewardAvailable = questsState.snapshot?.checkIn?.available == true,
                onOpenReward = { rewardOpen = true },
                onOpenSearch = { searchOpen = true },
            )
            if (rewardOpen) {
                questsState.snapshot?.let { snapshot ->
                    snapshot.checkIn?.let { checkIn ->
                        DailyRewardDialog(
                            checkIn = checkIn,
                            resetTimezone = snapshot.resetTimezone,
                            claiming = questsState.claiming,
                            onClaim = questsViewModel::checkIn,
                            onDismiss = { rewardOpen = false },
                        )
                    }
                }
            }

            val tabs = listOf(RoomCategory.POPULAR, RoomCategory.PARTY, RoomCategory.MUSIC)
            TabRow(
                selectedTabIndex = tabs.indexOf(state.category).coerceAtLeast(0),
                containerColor = Color.Transparent,
                contentColor = OnDarkHigh,
                divider = {},
                indicator = { tabPositions ->
                    Box(
                        Modifier
                            .tabIndicatorOffsetCompat(tabPositions, tabs.indexOf(state.category))
                            .height(3.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(VoizaAccentGradient),
                    )
                },
            ) {
                tabs.forEach { cat ->
                    Tab(
                        selected = state.category == cat,
                        onClick = { viewModel.selectCategory(cat) },
                        text = {
                            Text(
                                text = cat.label(),
                                fontSize = 13.sp,
                                fontWeight = if (state.category == cat) FontWeight.Bold else FontWeight.Medium,
                                color = if (state.category == cat) OnDarkHigh else OnDarkMedium,
                            )
                        },
                    )
                }
            }

            DiscoveryRow(
                search = state.search,
                searchOpen = searchOpen || state.search.isNotBlank(),
                sort = state.sort,
                showingMyRooms = state.showingMyRooms,
                quickJoinPending = state.quickJoinPending,
                quickJoinError = state.quickJoinError,
                onSearch = viewModel::setSearch,
                onCloseSearch = {
                    searchOpen = false
                    viewModel.setSearch("")
                },
                onSelectSort = viewModel::selectSort,
                onToggleMyRooms = viewModel::toggleMyRooms,
                onQuickJoin = viewModel::quickJoin,
            )

            RankingsEntryCard(
                leaders = previewState.data?.leaders?.take(3) ?: emptyList(),
                onClick = onOpenRankings,
            )

            // What the operator is running on the wall right now, above the grid rather than inside
            // it: a campaign that scrolled away with the rooms would be one a member could never
            // happen to see twice, and it draws nothing at all while no HOME banner is live.
            PromoBannerStrip(
                placement = BannerPlacement.HOME,
                modifier = Modifier.padding(start = 12.dp, end = 12.dp),
            )

            Box(modifier = Modifier.fillMaxSize()) {
                when {
                    state.loading && state.rooms.isEmpty() -> LoadingProgress(overlay = true)

                    state.error != null && state.rooms.isEmpty() -> EmptyState(
                        icon = Icons.Default.Search,
                        title = state.error ?: "Could not load rooms",
                        subtitle = "Pull down to try again",
                    )

                    state.rooms.isEmpty() && state.search.isNotBlank() -> EmptyState(
                        icon = Icons.Default.Search,
                        title = "Nothing matches \"${state.search.trim()}\"",
                        subtitle = "The server searched every open room it knows about, not just this screen",
                    )

                    state.rooms.isEmpty() && state.showingMyRooms -> EmptyState(
                        icon = Icons.Default.Home,
                        title = "You are not hosting a room",
                        subtitle = "Open one below and it will appear here",
                    )

                    state.rooms.isEmpty() -> EmptyState(
                        icon = Icons.Default.Home,
                        title = "No rooms here yet",
                        subtitle = "Be the first — open your own room below",
                    )

                    else -> PullToRefreshBox(
                        isRefreshing = state.refreshing,
                        onRefresh = viewModel::refresh,
                    ) {
                        LazyVerticalGrid(
                            columns = GridCells.Adaptive(minSize = 160.dp),
                            contentPadding = PaddingValues(12.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                            modifier = Modifier.fillMaxSize(),
                        ) {
                            items(state.rooms, key = { it.id }) { room ->
                                RoomCard(room = room, onClick = { onOpenRoom(room.id) })
                            }
                        }
                    }
                }

                // FAB: open your own room
                Box(contentAlignment = Alignment.BottomEnd, modifier = Modifier.fillMaxSize()) {
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .padding(18.dp)
                            .size(56.dp)
                            .clip(RoundedCornerShape(18.dp))
                            .background(VoizaAccentGradient)
                            .clickable { onCreateRoom() },
                    ) {
                        Icon(
                            imageVector = Icons.Default.Add,
                            contentDescription = "Create room",
                            tint = OnDarkHigh,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Discovery controls. Every choice here becomes a query parameter for the server: search runs
 * against all open rooms, "Trending" is the last 24h of gift value on the ledger, and "My Room"
 * is `GET /api/rooms/mine`. Nothing is filtered from the rows already on screen, because a room
 * ranked 200th is invisible to a client-side filter.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun DiscoveryRow(
    search: String,
    searchOpen: Boolean,
    sort: RoomSort,
    showingMyRooms: Boolean,
    quickJoinPending: Boolean,
    quickJoinError: String?,
    onSearch: (String) -> Unit,
    onCloseSearch: () -> Unit,
    onSelectSort: (RoomSort) -> Unit,
    onToggleMyRooms: () -> Unit,
    onQuickJoin: () -> Unit,
) {
    var query by remember(search) { mutableStateOf(search) }
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(searchOpen) {
        if (searchOpen && !showingMyRooms) focusRequester.requestFocus()
    }

    Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        if (searchOpen && !showingMyRooms) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it.take(60) },
                placeholder = { Text("Search rooms, hosts\u2026", fontSize = 13.sp) },
                leadingIcon = { Icon(Icons.Default.Search, contentDescription = null, tint = OnDarkMedium) },
                trailingIcon = {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Close search",
                        tint = OnDarkMedium,
                        modifier = Modifier.clickable {
                            query = ""
                            onCloseSearch()
                        },
                    )
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(
                    onSearch = { onSearch(query.trim()) },
                ),
                colors = voizaFieldColors(),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focusRequester),
            )
            Spacer(Modifier.height(8.dp))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            FilterChip(
                selected = showingMyRooms,
                onClick = onToggleMyRooms,
                label = { Text("My Room", fontSize = 12.sp) },
                colors = voizaChipColors(),
            )
            Spacer(Modifier.weight(1f))
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .height(34.dp)
                    .clip(RoundedCornerShape(17.dp))
                    .background(VoizaAccentGradient)
                    .clickable(enabled = !quickJoinPending, onClick = onQuickJoin),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                    modifier = Modifier.padding(horizontal = 14.dp),
                ) {
                    if (quickJoinPending) {
                        CircularProgressIndicator(
                            strokeWidth = 2.dp,
                            color = OnDarkHigh,
                            modifier = Modifier.size(14.dp),
                        )
                    } else {
                        Icon(
                            imageVector = Icons.Default.Bolt,
                            contentDescription = null,
                            tint = OnDarkHigh,
                            modifier = Modifier.size(15.dp),
                        )
                    }
                    Spacer(Modifier.width(5.dp))
                    Text(
                        text = if (quickJoinPending) "Finding\u2026" else "Quick Join",
                        color = OnDarkHigh,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }

        quickJoinError?.let {
            Text(
                text = it,
                color = DangerRed,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 6.dp),
            )
        }

        // `mine` answers with the caller's rooms in a fixed order, so sort chips would promise a
        // filter the endpoint does not offer.
        if (!showingMyRooms) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .padding(top = 8.dp)
                    .horizontalScroll(rememberScrollState()),
            ) {
                RoomSort.entries.forEach { option ->
                    FilterChip(
                        selected = sort == option,
                        onClick = { onSelectSort(option) },
                        label = { Text(option.label, fontSize = 12.sp) },
                        colors = voizaChipColors(),
                    )
                }
            }
        }
    }
}

/**
 * The landing's door into the three boards. The faces are the server's own monthly top three —
 * while the answer is still in flight the card simply carries the title and the More affordance.
 */
@Composable
private fun RankingsEntryCard(
    leaders: List<RankingLeader>,
    onClick: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(VoizaSurfaceHigh)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Icon(
            imageVector = Icons.Default.EmojiEvents,
            contentDescription = null,
            tint = WarningAmber,
            modifier = Modifier.size(26.dp),
        )
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "Rankings",
                color = OnDarkHigh,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = leaders.firstOrNull()?.let { "This month \u00b7 ${it.user.username} leads" }
                    ?: "Host, rich and gifter boards",
                color = OnDarkMedium,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (leaders.isNotEmpty()) {
            Box(modifier = Modifier.width(28.dp + 18.dp * (leaders.size - 1))) {
                leaders.forEachIndexed { index, leader ->
                    Avatar(
                        url = leader.user.avatarUrl,
                        name = leader.user.username,
                        size = 28.dp,
                        ringBrush = Brush.linearGradient(listOf(WarningAmber, GiftPink)),
                        modifier = Modifier
                            .offset(x = 18.dp * index)
                            .zIndex((leaders.size - index).toFloat()),
                    )
                }
            }
            Spacer(Modifier.width(8.dp))
        }
        Text(text = "More", color = OnDarkMedium, fontSize = 12.sp)
        Icon(
            imageVector = Icons.Default.ChevronRight,
            contentDescription = null,
            tint = OnDarkMedium,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun HomeTopBar(
    user: com.voiza.app.domain.model.User?,
    onWalletClick: () -> Unit,
    rewardAvailable: Boolean,
    onOpenReward: () -> Unit,
    onOpenSearch: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .background(VoizaHeroGradient)
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Avatar(
            url = user?.avatarUrl,
            name = user?.username,
            size = 40.dp,
            frame = user?.profileFrame,
        )
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = user?.username ?: "Guest",
                color = OnDarkHigh,
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp,
                maxLines = 1,
            )
            Text(
                text = user?.let { "Room #${it.id.take(4)} \u2726" } ?: "Welcome to Voiza",
                color = OnDarkMedium,
                fontSize = 11.sp,
            )
        }
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(VoizaSurfaceHigh)
                .clickable(onClick = onOpenSearch),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Default.Search,
                contentDescription = "Search rooms",
                tint = Cyan,
                modifier = Modifier.size(20.dp),
            )
        }
        Spacer(Modifier.width(8.dp))
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(VoizaSurfaceHigh)
                .clickable(onClick = onOpenReward),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Default.CardGiftcard,
                contentDescription = "Daily reward",
                tint = GiftPink,
                modifier = Modifier.size(20.dp),
            )
            if (rewardAvailable) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(2.dp)
                        .size(9.dp)
                        .clip(CircleShape)
                        .background(GiftPink),
                )
            }
        }
        Spacer(Modifier.width(8.dp))
        DiamondChip(
            balance = user?.diamondBalance,
            onClick = onWalletClick,
        )
    }
}

/** Cover-topped card with host avatar, listener badge, gift flame, lock icon. */
@Composable
fun RoomCard(
    room: RoomSummary,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(16.dp))
            .background(VoizaSurfaceHigh)
            .clickable(onClick = onClick),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(110.dp)
                .background(VoizaHeroGradient),
        ) {
            if (!room.coverUrl.isNullOrBlank()) {
                AsyncImage(
                    model = room.coverUrl.asAssetUrl(),
                    contentDescription = room.title,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            // Overlay badges
            Row(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                ListenerBadge(count = room.listenerCount)
                if (room.totalGiftValue > 0) FlameBadge(value = room.totalGiftValue)
            }
            if (room.type == RoomType.PRIVATE) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(8.dp)
                        .size(24.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color(0xB3000000)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = Icons.Default.Lock,
                        contentDescription = "Private room",
                        tint = WarningTint,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
        }
        Column(modifier = Modifier.padding(10.dp)) {
            Text(
                text = room.title,
                color = OnDarkHigh,
                fontWeight = FontWeight.Bold,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(url = room.host.avatarUrl, name = room.host.username, size = 20.dp)
                Spacer(Modifier.width(6.dp))
                Text(
                    text = room.host.username,
                    color = OnDarkMedium,
                    fontSize = 11.sp,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun navItemColors() = NavigationBarItemDefaults.colors(
    selectedIconColor = Fuchsia,
    selectedTextColor = OnDarkHigh,
    unselectedIconColor = OnDarkMedium,
    unselectedTextColor = OnDarkMedium,
    indicatorColor = VoizaSurface,
)

/** Gradient tab indicator. */
private fun Modifier.tabIndicatorOffsetCompat(
    tabPositions: List<TabPosition>,
    selectedIndex: Int,
): Modifier = this.tabIndicatorOffset(
    tabPositions[selectedIndex.coerceIn(0, (tabPositions.size - 1).coerceAtLeast(0))]
)

private val WarningTint = Color(0xFFFFC246)

// ---------------------------------------------------------------------------
// Android Studio previews. These render in the Design/Split pane with sample
// data only — no ViewModel, no network — so the look can be edited live.
// ---------------------------------------------------------------------------

private val previewUser = com.voiza.app.domain.model.User(
    id = "preview-0001",
    phone = "",
    username = "Ayesha",
    avatarUrl = null,
    bio = null,
    gender = null,
    countryCode = null,
    diamondBalance = 12500,
    rCoinBalance = 3400,
    totalGiftsSent = 0,
    totalGiftsReceived = 0,
    userType = "USER",
    status = "ACTIVE",
    isVerified = true,
)

private fun previewRoom(
    id: String,
    title: String,
    type: RoomType,
    listeners: Int,
    giftValue: Long,
) = RoomSummary(
    id = id,
    roomNumber = 1001,
    title = title,
    description = null,
    coverUrl = null,
    category = RoomCategory.PARTY,
    type = type,
    seatCapacity = 8,
    status = RoomStatus.ACTIVE,
    listenerCount = listeners,
    totalGiftValue = giftValue,
    host = MiniUser(id = "host-$id", username = "DJ Spark", avatarUrl = null),
)

@Preview(name = "Home top bar", showBackground = true)
@Composable
private fun HomeTopBarPreview() {
    VoizaTheme {
        HomeTopBar(
            user = previewUser,
            onWalletClick = {},
            rewardAvailable = true,
            onOpenReward = {},
            onOpenSearch = {},
        )
    }
}

@Preview(name = "Discovery row (lobby)", showBackground = true)
@Composable
private fun DiscoveryRowPreview() {
    VoizaTheme {
        Box(Modifier.background(androidx.compose.material3.MaterialTheme.colorScheme.background)) {
            DiscoveryRow(
                search = "",
                searchOpen = false,
                sort = RoomSort.DEFAULT,
                showingMyRooms = false,
                quickJoinPending = false,
                quickJoinError = null,
                onSearch = {},
                onCloseSearch = {},
                onSelectSort = {},
                onToggleMyRooms = {},
                onQuickJoin = {},
            )
        }
    }
}

@Preview(name = "Discovery row (search open)", showBackground = true)
@Composable
private fun DiscoveryRowSearchOpenPreview() {
    VoizaTheme {
        Box(Modifier.background(androidx.compose.material3.MaterialTheme.colorScheme.background)) {
            DiscoveryRow(
                search = "",
                searchOpen = true,
                sort = RoomSort.TRENDING,
                showingMyRooms = false,
                quickJoinPending = false,
                quickJoinError = null,
                onSearch = {},
                onCloseSearch = {},
                onSelectSort = {},
                onToggleMyRooms = {},
                onQuickJoin = {},
            )
        }
    }
}

@Preview(name = "Rankings entry card", showBackground = true)
@Composable
private fun RankingsEntryCardPreview() {
    VoizaTheme {
        Box(Modifier.background(androidx.compose.material3.MaterialTheme.colorScheme.background)) {
            RankingsEntryCard(
                leaders = listOf(
                    RankingLeader(1, MiniUser("l1", "Noor", null), 90000),
                    RankingLeader(2, MiniUser("l2", "Zain", null), 70000),
                    RankingLeader(3, MiniUser("l3", "Mira", null), 50000),
                ),
                onClick = {},
            )
        }
    }
}

@Preview(name = "Room cards", showBackground = true)
@Composable
private fun RoomCardsPreview() {
    VoizaTheme {
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier
                .background(androidx.compose.material3.MaterialTheme.colorScheme.background)
                .padding(12.dp),
        ) {
            RoomCard(
                room = previewRoom("a", "Late Night Beats", RoomType.PUBLIC, 128, 52000),
                onClick = {},
                modifier = Modifier.weight(1f),
            )
            RoomCard(
                room = previewRoom("b", "VIP Lounge", RoomType.PRIVATE, 12, 0),
                onClick = {},
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
fun HomeScreenPreview() {
    HomeScreen(onOpenRoom = {}, onCreateRoom = {}, onOpenWallet = {}, onOpenStore = {}, onOpenProfile = {}, onOpenRankings = {})
}
