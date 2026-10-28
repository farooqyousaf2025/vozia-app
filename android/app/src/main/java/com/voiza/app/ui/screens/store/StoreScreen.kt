package com.voiza.app.ui.screens.store

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.voiza.app.domain.model.OwnedStoreItem
import com.voiza.app.domain.model.ProfileFrame
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.domain.model.StoreItem
import com.voiza.app.domain.model.StoreItemKind
import com.voiza.app.domain.model.User
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.DiamondChip
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.components.VoizaSheet
import com.voiza.app.ui.components.VoizaTextButton
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.screens.room.WelcomeEffect
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaSurfaceVariant
import com.voiza.app.viewmodel.StoreViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * The cosmetic shop: rings a member wears, themes a room wears, and entry flourishes.
 *
 * Everything a card can do is a server call — the price is a label, the "owned" and "worn" marks are
 * the caller's own rows, and after a purchase the catalogue is re-read rather than patched. A row an
 * operator has retired but the member still paid for stays on the account and is listed apart.
 */
@Composable
fun StoreScreen(
    onBack: () -> Unit,
    onOpenWallet: () -> Unit,
    viewModel: StoreViewModel = viewModel(
        factory = voizaViewModelFactory { StoreViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    // Prices, holdings and the balance can all move while the shop is off-screen, so the catalogue
    // and the caller's account are re-read whenever this screen returns to the front.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.refresh() }
    // Only the id is held: a reload after a purchase replaces the row, and the sheet must show the
    // server's new expiry rather than the copy that was on screen when it opened.
    var openItemId by remember { mutableStateOf<String?>(null) }
    var previewUrl by remember { mutableStateOf<String?>(null) }

    val detail = openItemId?.let { id -> state.snapshot?.items?.firstOrNull { it.id == id } }

    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp),
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
                }
                Text("Store", color = OnDarkHigh, fontSize = 19.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.weight(1f))
                DiamondChip(
                    balance = state.user?.diamondBalance,
                    onClick = onOpenWallet,
                    modifier = Modifier.padding(end = 10.dp),
                )
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 4.dp),
            ) {
                StoreItemKind.entries.forEach { kind ->
                    FilterChip(
                        selected = state.tab == kind,
                        onClick = { viewModel.selectTab(kind) },
                        label = { Text(kind.tabLabel(), fontSize = 12.sp) },
                        colors = FilterChipDefaults.filterChipColors(
                            containerColor = VoizaSurfaceHigh,
                            labelColor = OnDarkMedium,
                            selectedContainerColor = VoizaSurfaceVariant,
                            selectedLabelColor = OnDarkHigh,
                        ),
                    )
                }
            }

            Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
                when {
                    state.loading && state.snapshot == null -> LoadingProgress(overlay = true)

                    // A guest has no account to own a ring, so the shop cannot even quote prices.
                    state.user == null && state.snapshot == null -> EmptyState(
                        icon = Icons.Default.ShoppingCart,
                        title = "Log in to open the store",
                        subtitle = "Rings, themes and flourishes belong to your account. " +
                            "Your session has ended \u2014 reopen the app to sign in again.",
                        action = {
                            VoizaButton(
                                text = "Back to rooms",
                                onClick = onBack,
                                height = 44,
                                modifier = Modifier.width(160.dp),
                            )
                        },
                    )

                    state.snapshot == null -> EmptyState(
                        icon = Icons.Default.ShoppingCart,
                        title = state.error ?: "The shop did not answer",
                        subtitle = "Nothing here is cached: every price and every purchase comes from the server",
                        action = {
                            VoizaButton(
                                text = "Try again",
                                onClick = viewModel::load,
                                height = 44,
                                modifier = Modifier.width(160.dp),
                            )
                        },
                    )

                    state.items.isEmpty() && state.retiredOwned.isEmpty() -> EmptyState(
                        icon = Icons.Default.ShoppingCart,
                        title = "Nothing on sale here",
                        subtitle = "The operator has taken every ${state.tab.tabLabel().lowercase()} off the shelf for now",
                    )

                    else -> LazyVerticalGrid(
                        columns = GridCells.Fixed(2),
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(state.items, key = { it.id }) { item ->
                            StoreCard(
                                item = item,
                                user = state.user,
                                busy = state.busyId != null,
                                onClick = { openItemId = item.id },
                            )
                        }
                        if (state.retiredOwned.isNotEmpty()) {
                            item(span = { GridItemSpan(maxLineSpan) }) {
                                Text(
                                    text = "No longer sold \u2014 still yours",
                                    color = OnDarkMedium,
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.padding(top = 14.dp, bottom = 2.dp),
                                )
                            }
                            state.retiredOwned.forEach { owned ->
                                item(span = { GridItemSpan(maxLineSpan) }) {
                                    RetiredRow(owned)
                                }
                            }
                        }
                    }
                }
            }

            state.message?.let { message ->
                StoreSnack(text = message, onConsumed = viewModel::consumeMessage)
            }
            if (state.snapshot != null) {
                state.error?.let { error ->
                    Text(
                        text = error,
                        color = DangerRed,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
            }
        }

        if (previewUrl != null) {
            EffectPreview(url = previewUrl, onClose = { previewUrl = null })
        }
    }

    detail?.let { item ->
        StoreDetailSheet(
            item = item,
            state = state,
            onDismiss = { openItemId = null },
            onBuy = { viewModel.buy(item) },
            onWear = { viewModel.wear(item) },
            onTakeOff = { viewModel.takeOff(item.kind) },
            onTopUp = {
                openItemId = null
                onOpenWallet()
            },
            onPreview = { previewUrl = item.art },
            onLoadRooms = viewModel::loadMyRooms,
            onApplyTheme = { room -> viewModel.applyTheme(room, item) },
            onCloseRoomPicker = viewModel::closeRoomPicker,
        )
    }
}

@Composable
private fun StoreCard(
    item: StoreItem,
    user: User?,
    busy: Boolean,
    onClick: () -> Unit,
) {
    VoizaCard(
        modifier = Modifier.fillMaxWidth().clickable(enabled = !busy, onClick = onClick),
        backgroundColor = VoizaSurfaceHigh,
        contentPadding = 0.dp,
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .height(104.dp)
                .background(Brush.verticalGradient(listOf(Color(0xFF2A2459), Color(0xFF1B1740)))),
        ) {
            ItemArt(item = item, user = user, size = 72.dp)
            if (item.equipped) {
                StatusPill(
                    text = "Wearing",
                    color = Cyan,
                    modifier = Modifier.align(Alignment.TopStart).padding(6.dp),
                )
            }
        }
        Column(modifier = Modifier.padding(10.dp)) {
            Text(
                text = item.name,
                color = OnDarkHigh,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(3.dp))
            Text(
                text = priceLine(item),
                color = DiamondGold,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
            )
            if (item.owned) {
                Spacer(Modifier.height(3.dp))
                Text(
                    text = ownedLine(item),
                    color = Mint,
                    fontSize = 10.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun StatusPill(text: String, color: Color, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(Color(0xCC0B0A1F))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(text, color = color, fontSize = 9.sp, fontWeight = FontWeight.Bold)
    }
}

/** The art as the phone will actually draw it: a ring over the member's own face. */
@Composable
private fun ItemArt(item: StoreItem, user: User?, size: Dp) {
    when (item.kind) {
        StoreItemKind.FRAME -> Avatar(
            url = user?.avatarUrl,
            name = user?.username,
            size = size,
            frame = item.asFrame(),
        )

        StoreItemKind.THEME -> {
            val art = item.art.asAssetUrl()
            if (art != null) {
                AsyncImage(
                    model = art,
                    contentDescription = item.name,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }

        StoreItemKind.EFFECT -> Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(56.dp)
                .clip(CircleShape)
                .background(Color(0x33000000)),
        ) {
            Icon(
                imageVector = Icons.Default.PlayArrow,
                contentDescription = null,
                tint = OnDarkHigh,
                modifier = Modifier.size(28.dp),
            )
        }
    }
}

@Composable
private fun RetiredRow(owned: OwnedStoreItem) {
    VoizaCard(
        modifier = Modifier.fillMaxWidth(),
        backgroundColor = VoizaSurfaceHigh,
        contentPadding = 12.dp,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = owned.name,
                    color = OnDarkHigh,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = if (owned.expiresAt != null) {
                        "Retired \u00B7 yours until ${owned.expiresAt.take(10)}"
                    } else {
                        "Retired \u00B7 yours permanently"
                    },
                    color = OnDarkMedium,
                    fontSize = 10.sp,
                )
            }
            StatusPill(text = "RETIRED", color = OnDarkMuted)
        }
    }
}

@Composable
private fun StoreDetailSheet(
    item: StoreItem,
    state: StoreViewModel.StoreUiState,
    onDismiss: () -> Unit,
    onBuy: () -> Unit,
    onWear: () -> Unit,
    onTakeOff: () -> Unit,
    onTopUp: () -> Unit,
    onPreview: () -> Unit,
    onLoadRooms: () -> Unit,
    onApplyTheme: (RoomSummary) -> Unit,
    onCloseRoomPicker: () -> Unit,
) {
    val busy = state.busyId != null
    val affordable = state.canAfford(item)
    val renews = item.periodDays != null
    // A retired row cannot be re-worn, and a permanent one has nothing to renew — only these cases
    // can spend diamonds from this sheet.
    val canSpend = !item.owned || renews

    VoizaSheet(
        visible = true,
        onDismiss = onDismiss,
        title = item.name,
        subtitle = item.kind.kindLabel(),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .height(150.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(Brush.verticalGradient(listOf(Color(0xFF2A2459), Color(0xFF1B1740))))
                .then(
                    if (item.kind == StoreItemKind.EFFECT) Modifier.clickable(onClick = onPreview) else Modifier,
                ),
        ) {
            ItemArt(item = item, user = state.user, size = 96.dp)
            if (item.kind == StoreItemKind.EFFECT) {
                StatusPill(
                    text = "Tap to play",
                    color = OnDarkHigh,
                    modifier = Modifier.align(Alignment.BottomEnd).padding(8.dp),
                )
            }
        }

        Spacer(Modifier.height(12.dp))
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "${item.priceDiamonds} \u2756",
                    color = DiamondGold,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Black,
                )
                Text(
                    text = if (renews) "Rental \u00B7 ${item.periodDays} days, renewable" else "One-time \u00B7 yours permanently",
                    color = OnDarkMedium,
                    fontSize = 11.sp,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("Your balance", color = OnDarkMuted, fontSize = 10.sp)
                Text("${state.balance} \u2756", color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            }
        }

        if (item.owned) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = ownedLine(item),
                color = Mint,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }

        if (!affordable && canSpend) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = "You need ${state.shortfall(item)} more diamonds for this.",
                color = DangerRed,
                fontSize = 11.sp,
            )
        }

        Spacer(Modifier.height(12.dp))
        when {
            !item.owned -> VoizaButton(
                text = if (busy) "Buying\u2026" else "Buy for ${item.priceDiamonds} \u2756",
                onClick = onBuy,
                enabled = !busy && affordable,
                modifier = Modifier.fillMaxWidth(),
            )

            else -> {
                if (item.wearable) {
                    if (item.equipped) {
                        VoizaSecondaryButton(
                            text = "Take off",
                            onClick = onTakeOff,
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        VoizaButton(
                            text = "Wear",
                            onClick = onWear,
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                if (renews) {
                    Spacer(Modifier.height(8.dp))
                    VoizaSecondaryButton(
                        text = if (busy) "Renewing\u2026" else "Renew ${item.periodDays} days \u00B7 ${item.priceDiamonds} \u2756",
                        onClick = onBuy,
                        enabled = !busy && affordable,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

        if (item.kind == StoreItemKind.THEME && item.owned) {
            Spacer(Modifier.height(10.dp))
            Text(
                text = "A theme decorates a room, not an account.",
                color = OnDarkMedium,
                fontSize = 11.sp,
            )
            Spacer(Modifier.height(6.dp))
            if (state.themeRooms == null) {
                VoizaSecondaryButton(
                    text = if (state.roomsLoading) "Asking\u2026" else "Set on a room I host",
                    onClick = onLoadRooms,
                    enabled = !busy && !state.roomsLoading,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else if (state.roomsLoading) {
                LoadingProgress(modifier = Modifier.height(44.dp), size = 22.dp)
            } else if (state.themeRooms.isEmpty()) {
                Text(
                    text = "You host no rooms yet \u2014 open one first, then come back.",
                    color = OnDarkMedium,
                    fontSize = 11.sp,
                )
                VoizaTextButton(text = "Not now", onClick = onCloseRoomPicker, color = OnDarkMedium)
            } else {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                ) {
                    state.themeRooms.forEach { room ->
                        FilterChip(
                            selected = false,
                            onClick = { onApplyTheme(room) },
                            enabled = !busy,
                            label = {
                                Text(
                                    text = room.title,
                                    fontSize = 11.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            },
                            colors = FilterChipDefaults.filterChipColors(
                                containerColor = VoizaSurfaceHigh,
                                labelColor = OnDarkHigh,
                            ),
                        )
                    }
                }
                VoizaTextButton(text = "Not now", onClick = onCloseRoomPicker, color = OnDarkMedium)
            }
        }

        if (!affordable && canSpend) {
            Spacer(Modifier.height(8.dp))
            VoizaSecondaryButton(
                text = "Top up diamonds",
                onClick = onTopUp,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        state.error?.let { error ->
            Spacer(Modifier.height(8.dp))
            Text(error, color = DangerRed, fontSize = 11.sp)
        }
        state.message?.let { message ->
            Spacer(Modifier.height(8.dp))
            Text(message, color = Mint, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** The paid flourish is a Lottie scene, so a preview is the scene itself, once, over the shop. */
@Composable
private fun EffectPreview(url: String?, onClose: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xF00B0A1F))
            .clickable(onClick = onClose),
    ) {
        WelcomeEffect(welcomeUrl = url, onFinished = onClose)
        Text(
            text = "Tap anywhere to close",
            color = OnDarkMedium,
            fontSize = 11.sp,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 40.dp),
        )
    }
}

/** One-shot confirmation snack; clears itself after 2.5 s. */
@Composable
private fun StoreSnack(text: String, onConsumed: () -> Unit) {
    LaunchedEffect(text) {
        kotlinx.coroutines.delay(2500)
        onConsumed()
    }
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    ) {
        Text(
            text = text,
            color = OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .clip(RoundedCornerShape(10.dp))
                .background(Color(0xE6221B4E))
                .padding(horizontal = 14.dp, vertical = 8.dp),
        )
    }
}

private fun priceLine(item: StoreItem): String =
    "${item.priceDiamonds} \u2756 \u00B7 " + (item.periodDays?.let { "$it days" } ?: "forever")

private fun ownedLine(item: StoreItem): String =
    if (item.expiresAt != null) "Yours until ${item.expiresAt.take(10)}" else "Yours permanently"

private fun StoreItem.asFrame() = ProfileFrame(key = key, name = name, art = art, accent = accent)

private fun StoreItemKind.tabLabel(): String = when (this) {
    StoreItemKind.FRAME -> "Rings"
    StoreItemKind.THEME -> "Themes"
    StoreItemKind.EFFECT -> "Flourishes"
}

private fun StoreItemKind.kindLabel(): String = when (this) {
    StoreItemKind.FRAME -> "Profile ring"
    StoreItemKind.THEME -> "Room theme"
    StoreItemKind.EFFECT -> "Entry flourish"
}
