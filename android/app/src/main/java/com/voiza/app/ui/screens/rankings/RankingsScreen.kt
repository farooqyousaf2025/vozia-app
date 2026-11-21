package com.voiza.app.ui.screens.rankings

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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Diamond
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.WorkspacePremium
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.RankingBoardKind
import com.voiza.app.domain.model.RankingLeader
import com.voiza.app.domain.model.RankingPeriod
import com.voiza.app.domain.model.DiscoveryRankingKind
import com.voiza.app.domain.usecase.compactScore
import com.voiza.app.domain.usecase.podiumSlots
import com.voiza.app.domain.usecase.rankingUnitLabel
import com.voiza.app.domain.usecase.selfPlaceLabel
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.RankBadge
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaSheet
import com.voiza.app.ui.components.ListSkeleton
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.GiftPink
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.RCoinGreen
import com.voiza.app.ui.theme.VoizaBackground
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaSurfaceVariant
import com.voiza.app.ui.theme.WarningAmber
import com.voiza.app.viewmodel.RankingsViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory
import kotlinx.coroutines.delay

/**
 * The landing rankings, in the reference's shape: three themed boards, Daily/Weekly/Monthly
 * periods, a 2-1-3 podium, the long tail below it, and the caller's own row pinned at the end.
 *
 * The pill beside the periods names the window the server actually ranked ("Today", "Yesterday",
 * "Last week"…) and swaps the live board for the finished one. The gift box in the header is the
 * reward entry: a podium reward is only ever paid from a finished window, and the sheet says so
 * rather than promising a prize the live board cannot yet award.
 */
@Composable
fun RankingsScreen(
    onBack: () -> Unit,
    viewModel: RankingsViewModel = viewModel(factory = voizaViewModelFactory { RankingsViewModel() }),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val user by ServiceLocator.authRepository.currentUser.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.refresh() }

    val theme = boardTheme(state.board)
    val data = state.data
    LaunchedEffect(user?.countryCode) { viewModel.useAccountRegionIfUnset(user?.countryCode) }

    LaunchedEffect(state.message) {
        if (state.message != null) {
            delay(3500)
            viewModel.consumeMessage()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(VoizaBackground)
            // Without these the header rides under the status bar, and the system — not the
            // app — owns every tap landed on the reward entry.
            .statusBarsPadding()
            .navigationBarsPadding(),
    ) {
        // Header -----------------------------------------------------------------
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
            }
            Text(
                text = "Rankings",
                color = OnDarkHigh,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            Box {
                IconButton(onClick = viewModel::openRewardSheet) {
                    Icon(Icons.Default.CardGiftcard, contentDescription = "Podium rewards", tint = theme.accent)
                }
                if (data?.reward?.claimable == true) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(6.dp)
                            .size(9.dp)
                            .clip(CircleShape)
                            .background(DangerRed),
                    )
                }
            }
        }

        // Live discovery rankings: separate from the financial podium below.
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Live Discovery", color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.weight(1f))
                Text("Room quality · live activity", color = OnDarkMuted, fontSize = 10.sp)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                DiscoveryRankingKind.entries.forEach { kind ->
                    FilterChip(
                        selected = state.discoveryKind == kind,
                        onClick = { viewModel.selectDiscoveryKind(kind) },
                        label = { Text(kind.label, fontSize = 10.sp) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = VioletDiscovery.copy(alpha = 0.18f),
                            selectedLabelColor = VioletDiscovery,
                            labelColor = OnDarkMedium,
                        ),
                    )
                }
                Spacer(Modifier.weight(1f))
                FilterChip(
                    selected = state.discoveryRegion == null,
                    onClick = { viewModel.selectDiscoveryRegion(null) },
                    label = { Text("Global", fontSize = 10.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = VioletDiscovery.copy(alpha = 0.18f),
                        selectedLabelColor = VioletDiscovery,
                        labelColor = OnDarkMedium,
                    ),
                )
                user?.countryCode?.takeIf { it.length == 2 }?.let { code ->
                    FilterChip(
                        selected = state.discoveryRegion == code,
                        onClick = { viewModel.selectDiscoveryRegion(code) },
                        label = { Text(code.uppercase(), fontSize = 10.sp) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = VioletDiscovery.copy(alpha = 0.18f),
                            selectedLabelColor = VioletDiscovery,
                            labelColor = OnDarkMedium,
                        ),
                    )
                }
            }
            val discovery = state.discoveryData?.takeIf {
                it.kind == state.discoveryKind && it.region == state.discoveryRegion
            }
            when {
                state.discoveryLoading && discovery == null -> Text(
                    "Loading live rankings…", color = OnDarkMuted, fontSize = 11.sp,
                )
                discovery == null && state.discoveryError != null -> Text(
                    state.discoveryError, color = DangerRed, fontSize = 11.sp,
                )
                discovery?.leaders.isNullOrEmpty() -> Text(
                    "No qualifying live activity yet in this region.", color = OnDarkMuted, fontSize = 11.sp,
                )
                else -> discovery!!.leaders.take(3).forEach { leader ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(VoizaSurfaceHigh)
                            .padding(horizontal = 9.dp, vertical = 7.dp),
                    ) {
                        Text("#${leader.position}", color = WarningAmber, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.width(8.dp))
                        Avatar(url = leader.avatarUrl, name = leader.name, size = 32.dp)
                        Spacer(Modifier.width(8.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(leader.name, color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val detail = when (state.discoveryKind) {
                                DiscoveryRankingKind.ROOMS -> "Host: ${leader.hostName ?: "Community"}"
                                DiscoveryRankingKind.HOSTS -> "${leader.activeRooms} active rooms"
                                DiscoveryRankingKind.AGENCIES -> "${leader.activeHostCount ?: 0} active hosts · ${leader.activeRooms} rooms"
                            }
                            Text(detail, color = OnDarkMuted, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text("${leader.listenerCount}", color = Mint, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            Text("listeners", color = OnDarkMuted, fontSize = 9.sp)
                        }
                    }
                }
            }
        }

        // Board tabs ---------------------------------------------------------------
        val boards = RankingBoardKind.entries
        TabRow(
            selectedTabIndex = boards.indexOf(state.board).coerceAtLeast(0),
            containerColor = Color.Transparent,
            contentColor = OnDarkHigh,
            divider = {},
            indicator = { positions ->
                Box(
                    Modifier
                        .tabIndicatorOffset(positions[boards.indexOf(state.board).coerceAtLeast(0)])
                        .height(3.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(Brush.horizontalGradient(listOf(theme.accent, theme.accent.copy(alpha = 0.4f)))),
                )
            },
        ) {
            boards.forEach { kind ->
                val selected = state.board == kind
                Tab(
                    selected = selected,
                    onClick = { viewModel.selectBoard(kind) },
                    text = {
                        Text(
                            text = kind.label,
                            fontSize = 14.sp,
                            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                            color = if (selected) boardTheme(kind).accent else OnDarkMedium,
                        )
                    },
                )
            }
        }

        // Periods + the window pill --------------------------------------------------
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            RankingPeriod.entries.forEach { period ->
                FilterChip(
                    selected = state.period == period,
                    onClick = { viewModel.selectPeriod(period) },
                    label = { Text(period.label, fontSize = 12.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = theme.accent.copy(alpha = 0.18f),
                        selectedLabelColor = theme.accent,
                        labelColor = OnDarkMedium,
                    ),
                )
            }
            Spacer(Modifier.weight(1f))
            // The server's own name for the window it ranked; tapping swaps live <-> settled.
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier
                    .clip(RoundedCornerShape(14.dp))
                    .background(VoizaSurfaceHigh)
                    .clickable(onClick = viewModel::toggleSettled)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Text(
                    text = data?.windowLabel ?: "…",
                    color = OnDarkHigh,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Icon(Icons.Default.SwapHoriz, contentDescription = "Switch live / settled window", tint = OnDarkMuted, modifier = Modifier.size(14.dp))
            }
        }

        state.message?.let {
            Text(it, color = Mint, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp))
        }
        state.error?.let {
            Text(it, color = DangerRed, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp))
        }

        // The board -------------------------------------------------------------------
        Box(modifier = Modifier.fillMaxSize()) {
            when {
                state.loading && data == null -> ListSkeleton(rows = 7, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                data == null -> EmptyState(
                    icon = Icons.Default.EmojiEvents,
                    title = state.error ?: "Could not load the rankings",
                    subtitle = "Tap to try again",
                    modifier = Modifier.clickable(onClick = viewModel::load),
                )
                else -> Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Brush.verticalGradient(listOf(theme.wash, VoizaBackground))),
                ) {
                    // The board's watermark, the way the reference themes each landing.
                    Icon(
                        imageVector = theme.watermark,
                        contentDescription = null,
                        tint = theme.accent.copy(alpha = 0.07f),
                        modifier = Modifier.align(Alignment.TopEnd).padding(top = 24.dp, end = 8.dp).size(180.dp),
                    )
                    LazyColumn(
                        contentPadding = PaddingValues(bottom = 16.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        item {
                            Podium(
                                slots = podiumSlots(data.leaders),
                                theme = theme,
                                unit = data.unit,
                                settled = data.settled,
                            )
                        }
                        items(data.leaders.drop(3), key = { it.user.id }) { leader ->
                            LeaderRow(leader = leader, theme = theme, unit = data.unit)
                        }
                        item {
                            SelfRow(
                                place = selfPlaceLabel(data.self),
                                earned = data.self?.earned,
                                unit = data.unit,
                                username = user?.username,
                                avatarUrl = user?.avatarUrl,
                                signedIn = user != null,
                                theme = theme,
                            )
                        }
                    }
                }
            }
        }
    }

    // The reward entry ----------------------------------------------------------------
    VoizaSheet(
        visible = state.rewardSheetOpen,
        onDismiss = viewModel::closeRewardSheet,
        title = "Podium reward",
        subtitle = "${state.board.label} · ${rewardWindowName(data?.windowKey, data?.period)}",
    ) {
        val reward = data?.reward
        when {
            reward == null -> Column(modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp)) {
                Text(
                    text = "Finish in the top 3 of a settled window to earn bonus diamonds here.",
                    color = OnDarkHigh,
                    fontSize = 14.sp,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "Rewards are paid from finished windows only — switch the window pill to \"Yesterday\", \"Last week\" or \"Last month\" to see the result a reward is priced against.",
                    color = OnDarkMedium,
                    fontSize = 12.sp,
                )
                Spacer(Modifier.height(16.dp))
            }
            reward.claimed -> Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
            ) {
                Icon(Icons.Default.CheckCircle, contentDescription = null, tint = Mint, modifier = Modifier.size(44.dp))
                Spacer(Modifier.height(8.dp))
                Text("Collected ${reward.amount} bonus diamonds", color = OnDarkHigh, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Text("Place ${reward.position} · already paid into your bonus pocket", color = OnDarkMedium, fontSize = 12.sp)
                Spacer(Modifier.height(16.dp))
            }
            else -> Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
            ) {
                Icon(Icons.Default.WorkspacePremium, contentDescription = null, tint = theme.accent, modifier = Modifier.size(44.dp))
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "${reward.amount} bonus diamonds",
                    color = theme.accent,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                )
                Text("For place ${reward.position} on the settled ${state.board.label} board", color = OnDarkMedium, fontSize = 12.sp)
                Spacer(Modifier.height(14.dp))
                VoizaButton(
                    text = if (state.claiming) "Collecting…" else "Collect ${reward.amount} diamonds",
                    onClick = viewModel::claim,
                    enabled = !state.claiming && reward.claimable,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "Bonus diamonds spend on gifts, boxes, the store and games; they expire and cannot be withdrawn.",
                    color = OnDarkMuted,
                    fontSize = 11.sp,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(12.dp))
            }
        }
    }
}

/** The settled window's friendly name, derived from the server's own key — never a local clock. */
private fun rewardWindowName(windowKey: String?, period: RankingPeriod?): String = when {
    windowKey == null || period == null -> "settled window"
    period == RankingPeriod.DAY -> "yesterday"
    period == RankingPeriod.WEEK -> "last week"
    else -> "last month"
}

// The board themes ------------------------------------------------------------------

private data class BoardTheme(val accent: Color, val wash: Color, val watermark: ImageVector)

private val VioletDiscovery = Color(0xFFB69CFF)\n\nprivate fun boardTheme(kind: RankingBoardKind): BoardTheme = when (kind) {
    RankingBoardKind.HOST -> BoardTheme(WarningAmber, Color(0xFF2E2410), Icons.Default.EmojiEvents)
    RankingBoardKind.RICH -> BoardTheme(RCoinGreen, Color(0xFF0E2E22), Icons.Default.Diamond)
    RankingBoardKind.GIFTER -> BoardTheme(GiftPink, Color(0xFF33122B), Icons.Default.CardGiftcard)
}

// The podium ------------------------------------------------------------------------

@Composable
private fun Podium(
    slots: List<RankingLeader?>,
    theme: BoardTheme,
    unit: String,
    settled: Boolean,
) {
    Row(
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 12.dp),
    ) {
        slots.forEachIndexed { index, leader ->
            val first = index == 1
            PodiumSlot(
                leader = leader,
                place = if (first) 1 else if (index == 0) 2 else 3,
                first = first,
                theme = theme,
                unit = unit,
                modifier = Modifier.weight(1f),
            )
        }
    }
    if (settled) {
        Text(
            text = "Settled result — podium rewards are paid from this window",
            color = OnDarkMuted,
            fontSize = 11.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
        )
    }
}

@Composable
private fun PodiumSlot(
    leader: RankingLeader?,
    place: Int,
    first: Boolean,
    theme: BoardTheme,
    unit: String,
    modifier: Modifier = Modifier,
) {
    val avatarSize = if (first) 72.dp else 54.dp
    val pedestalHeight = if (first) 64.dp else if (place == 2) 44.dp else 32.dp
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = modifier) {
        if (first) {
            Icon(Icons.Default.WorkspacePremium, contentDescription = "First place", tint = WarningAmber, modifier = Modifier.size(26.dp))
            Spacer(Modifier.height(2.dp))
        }
        if (leader != null) {
            Avatar(
                url = leader.user.avatarUrl,
                name = leader.user.username,
                size = avatarSize,
                ringBrush = Brush.sweepGradient(listOf(theme.accent, theme.accent.copy(alpha = 0.3f), theme.accent)),
                ringWidth = if (first) 3.dp else 2.dp,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = leader.user.username,
                color = OnDarkHigh,
                fontSize = if (first) 13.sp else 12.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            RankBadge(rank = leader.user.rank, size = 16.dp)
            Text(
                text = "${compactScore(leader.earned)} ${rankingUnitLabel(unit)}",
                color = theme.accent,
                fontSize = if (first) 13.sp else 11.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
        } else {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier.size(avatarSize).clip(CircleShape).background(VoizaSurfaceVariant),
            ) {
                Text("?", color = OnDarkMuted, fontSize = 20.sp)
            }
            Spacer(Modifier.height(6.dp))
            Text("Waiting for a leader", color = OnDarkMuted, fontSize = 10.sp, maxLines = 1)
            Spacer(Modifier.height(16.dp))
        }
        Spacer(Modifier.height(6.dp))
        // The pedestal: first place stands tallest, in the middle.
        Box(
            contentAlignment = Alignment.TopCenter,
            modifier = Modifier
                .fillMaxWidth()
                .height(pedestalHeight)
                .clip(RoundedCornerShape(topStart = 10.dp, topEnd = 10.dp))
                .background(
                    Brush.verticalGradient(
                        listOf(theme.accent.copy(alpha = if (first) 0.55f else 0.3f), theme.accent.copy(alpha = 0.08f)),
                    ),
                ),
        ) {
            Text(
                text = place.toString(),
                color = OnDarkHigh,
                fontSize = if (first) 22.sp else 16.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

// The long tail ---------------------------------------------------------------------

@Composable
private fun LeaderRow(leader: RankingLeader, theme: BoardTheme, unit: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 5.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(VoizaSurfaceHigh.copy(alpha = 0.6f))
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Text(
            text = leader.position.toString(),
            color = OnDarkMuted,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.width(28.dp),
        )
        Avatar(url = leader.user.avatarUrl, name = leader.user.username, size = 36.dp)
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = leader.user.username,
                color = OnDarkHigh,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            RankBadge(rank = leader.user.rank, size = 14.dp)
        }
        Text(
            text = compactScore(leader.earned),
            color = theme.accent,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.width(4.dp))
        Text(rankingUnitLabel(unit), color = OnDarkMuted, fontSize = 10.sp)
    }
}

// The pinned self row ----------------------------------------------------------------

@Composable
private fun SelfRow(
    place: String,
    earned: Long?,
    unit: String,
    username: String?,
    avatarUrl: String?,
    signedIn: Boolean,
    theme: BoardTheme,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(Brush.horizontalGradient(listOf(theme.accent.copy(alpha = 0.22f), VoizaSurfaceHigh)))
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(
            text = place.ifBlank { "—" },
            color = theme.accent,
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.width(32.dp),
        )
        Avatar(url = avatarUrl, name = username ?: "You", size = 36.dp)
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = if (signedIn) (username ?: "You") else "Sign in to join the board",
                color = OnDarkHigh,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = when {
                    !signedIn -> "Your place appears here once you are signed in"
                    earned == null || place.isBlank() -> "Not ranked in this window yet"
                    else -> "${compactScore(earned)} ${rankingUnitLabel(unit)}"
                },
                color = OnDarkMedium,
                fontSize = 11.sp,
            )
        }
        if (signedIn && earned != null && place.isNotBlank()) {
            Icon(Icons.Default.EmojiEvents, contentDescription = null, tint = theme.accent.copy(alpha = 0.7f), modifier = Modifier.size(18.dp))
        }
    }
}

@Preview(showBackground = true)
@Composable
fun RankingsScreenPreview() {
    RankingsScreen(onBack = {})
}
