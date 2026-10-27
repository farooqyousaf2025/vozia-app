package com.voiza.app.ui.screens.gift

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.usecase.RoomEffects
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.components.DiamondChip
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.viewmodel.PartyRoomViewModel

/**
 * Modal gift catalogue bound to PartyRoomViewModel's gift state:
 * category tab strip, a paged four-by-two tile panel, diamond price badges,
 * selected-gift detail line, quantity stepper + presets, seated-speaker target
 * chips (host default), insufficient-balance state.
 *
 * Tiles are two-tap: select, then tap again to send. The explicit button below is
 * the other way to do it, and the only one that shows the cost first.
 */
@Composable
fun GiftDialog(
    state: PartyRoomViewModel.PartyRoomUiState,
    onTapGift: (Gift) -> Unit,
    onSelectCategory: (String?) -> Unit,
    onSelectReceiver: (String) -> Unit,
    onQuantitySet: (Int) -> Unit,
    onSend: () -> Unit,
    onOpenRanking: () -> Unit,
    onDismiss: () -> Unit,
) {
    if (!state.giftDialogVisible) return

    val selected = state.selectedGift
    val balance = state.user?.diamondBalance ?: 0
    val cost = state.totalCost
    val affordable = state.canAfford

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Color(0xFF151233),
        shape = RoundedCornerShape(22.dp),
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Send a gift", color = Color(0xFFF3F1FF), fontWeight = FontWeight.Bold, fontSize = 17.sp)
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "Ranking",
                    color = Color(0xFF4DD0E1),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .background(Color(0xFF241F3D))
                        .clickable(onClick = onOpenRanking)
                        .padding(horizontal = 9.dp, vertical = 4.dp),
                )
                Spacer(Modifier.weight(1f))
                DiamondChip(balance = balance)
            }
        },
        text = {
            Column {
                // ---- Receiver chips (seated speakers; host default) ----
                val receivers = state.seatedUsers
                if (receivers.isNotEmpty()) {
                    Text("To", color = Color(0xFFB9B4D6), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier
                                .height(58.dp)
                                .width(64.dp)
                                .clip(RoundedCornerShape(14.dp))
                                .background(
                                    if (state.selectedReceiverId == receivers.firstOrNull()?.id) {
                                        Color(0xFF2A2459)
                                    } else {
                                        Color(0xFF1B1740)
                                    }
                                )
                                .clickable { receivers.firstOrNull()?.let { onSelectReceiver(it.id) } },
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Avatar(
                                    url = receivers.firstOrNull()?.avatarUrl,
                                    name = receivers.firstOrNull()?.username,
                                    size = 30.dp,
                                )
                                Text(
                                    text = receivers.firstOrNull()?.username?.take(6) ?: "-",
                                    color = Color(0xFFF3F1FF),
                                    fontSize = 9.sp,
                                )
                            }
                        }
                        ReceiversRow(receivers, state.selectedReceiverId, onSelectReceiver)
                    }
                }

                Spacer(Modifier.height(12.dp))

                // ---- Category tabs ----
                if (state.giftCatalog.isNotEmpty()) {
                    CategoryTabs(
                        categories = state.giftCategories,
                        selected = state.giftCategory,
                        onSelect = onSelectCategory,
                    )
                    Spacer(Modifier.height(10.dp))
                }

                // ---- Catalogue grid for the active category ----
                if (state.giftCatalog.isEmpty()) {
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(180.dp),
                    ) { LoadingProgress() }
                } else {
                    // Four across, two down, one page at a time — the panel never
                    // scrolls, so a tile cannot drift out from under a second tap.
                    val pages = state.visibleGifts.chunked(RoomEffects.PANEL_PAGE_SIZE)
                    val pagerState = rememberPagerState(pageCount = { pages.size.coerceAtLeast(1) })
                    HorizontalPager(
                        state = pagerState,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(PANEL_HEIGHT),
                    ) { pageIndex ->
                        val page = pages.getOrElse(pageIndex) { emptyList() }
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            page.chunked(RoomEffects.PANEL_COLUMNS).forEach { row ->
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    row.forEach { gift ->
                                        GiftTile(
                                            gift = gift,
                                            selected = selected?.id == gift.id,
                                            affordable = balance >= gift.diamondPrice,
                                            locked = state.vipLocked(gift),
                                            modifier = Modifier.weight(1f),
                                            onClick = { onTapGift(gift) },
                                        )
                                    }
                                    // A short last row keeps the grid four wide.
                                    repeat(RoomEffects.PANEL_COLUMNS - row.size) {
                                        Spacer(modifier = Modifier.weight(1f))
                                    }
                                }
                            }
                        }
                    }
                    if (pages.size > 1) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(5.dp, Alignment.CenterHorizontally),
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 6.dp),
                        ) {
                            repeat(pages.size) { index ->
                                Box(
                                    modifier = Modifier
                                        .size(if (index == pagerState.currentPage) 7.dp else 5.dp)
                                        .clip(CircleShape)
                                        .background(
                                            if (index == pagerState.currentPage) {
                                                Color(0xFF4DD0E1)
                                            } else {
                                                Color(0xFF3D3670)
                                            },
                                        ),
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(10.dp))

                // ---- Selected gift detail bar ----
                if (selected != null) {
                    SelectedGiftBar(
                        gift = selected,
                        quantity = state.giftQuantity,
                        receiver = state.seatedUsers.firstOrNull { it.id == state.selectedReceiverId }
                            ?: state.seatedUsers.firstOrNull(),
                    )
                    Spacer(Modifier.height(10.dp))
                }

                // ---- Quantity stepper + presets ----
                if (selected != null) {
                    val maxQuantity = if (selected.diamondPrice > 0) {
                        (balance / selected.diamondPrice).coerceIn(1, PartyRoomViewModel.MAX_GIFT_QUANTITY)
                    } else {
                        PartyRoomViewModel.MAX_GIFT_QUANTITY
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        IconButton(
                            onClick = { onQuantitySet(state.giftQuantity - 1) },
                            enabled = state.giftQuantity > 1,
                        ) {
                            Icon(Icons.Default.Remove, contentDescription = "less", tint = Color(0xFFF3F1FF))
                        }
                        Text(
                            text = "${state.giftQuantity}",
                            color = Color(0xFFF3F1FF),
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Bold,
                        )
                        IconButton(
                            onClick = { onQuantitySet(state.giftQuantity + 1) },
                            enabled = affordable,
                        ) {
                            Icon(Icons.Default.Add, contentDescription = "more", tint = Color(0xFFF3F1FF))
                        }
                        Spacer(Modifier.width(8.dp))
                        listOf(1, 5, 10, 20).forEach { preset ->
                            PresetChip(text = "$preset", active = state.giftQuantity == preset) {
                                onQuantitySet(preset)
                            }
                        }
                        PresetChip(
                            text = "Max",
                            active = state.giftQuantity == maxQuantity,
                        ) {
                            onQuantitySet(maxQuantity)
                        }
                    }

                    Spacer(Modifier.height(8.dp))

                    // ---- Cost / insufficiency state ----
                    if (state.selectedGiftLocked) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .clip(RoundedCornerShape(10.dp))
                                .background(Color(0x33FFC94D))
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        ) {
                            Text(
                                text = "Needs VIP ${selected.minVipLevel} — you are VIP ${state.user?.vipLevel ?: 0}. " +
                                    "An operator sets the tier.",
                                color = Color(0xFFFFC94D),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    } else if (!affordable) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .clip(RoundedCornerShape(10.dp))
                                .background(Color(0x33FF5B6E))
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        ) {
                            Text(
                                text = "Need \u2756 $cost, you have \u2756 $balance. Recharge to send.",
                                color = Color(0xFFFF8FA0),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    } else {
                        Text(
                            text = "Total \u2756 $cost \u2192 host earns \u25C9 ${selected.rCoinValue * state.giftQuantity}",
                            color = Color(0xFFB9B4D6),
                            fontSize = 12.sp,
                        )
                    }
                }

                state.giftError?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(it, color = Color(0xFFFF5B6E), fontSize = 12.sp)
                }
            }
        },
        confirmButton = {
            VoizaButton(
                text = if (state.giftSending) "Sending\u2026" else "Send \u2756 $cost",
                onClick = onSend,
                enabled = selected != null &&
                    state.selectedReceiverId != null &&
                    affordable &&
                    !state.selectedGiftLocked &&
                    !state.giftSending,
                gradient = Brush.horizontalGradient(listOf(Color(0xFFE040FB), Color(0xFF22D3EE))),
                modifier = Modifier.fillMaxWidth(),
                height = 46,
            )
        },
        dismissButton = null,
    )
}

@Composable
private fun ReceiversRow(
    receivers: List<MiniUser>,
    selectedReceiverId: String?,
    onSelectReceiver: (String) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(58.dp),
    ) {
        val rest = receivers.drop(1)
        androidx.compose.foundation.lazy.LazyRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(rest.size) { idx ->
                val user = rest[idx]
                val active = selectedReceiverId == user.id
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier
                        .width(64.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(if (active) Color(0xFF2A2459) else Color(0xFF1B1740))
                        .clickable { onSelectReceiver(user.id) }
                        .padding(vertical = 8.dp),
                ) {
                    Avatar(url = user.avatarUrl, name = user.username, size = 30.dp)
                    Text(
                        text = user.username.take(6),
                        color = Color(0xFFF3F1FF),
                        fontSize = 9.sp,
                    )
                }
            }
        }
    }
}

@Composable
private fun GiftTile(
    gift: Gift,
    selected: Boolean,
    affordable: Boolean,
    /** Below the gift's spend tier: selectable for info, but never sendable. */
    locked: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .clip(RoundedCornerShape(14.dp))
            .background(if (selected) Color(0xFF2A2459) else Color(0xFF1B1740))
            .then(if (selected) Modifier.background(Brush.horizontalGradient(listOf(Color(0x33E040FB), Color(0x3322D3EE)))) else Modifier)
            .clickable(onClick = onClick)
            .padding(vertical = 8.dp, horizontal = 4.dp),
    ) {
        Box(contentAlignment = Alignment.BottomEnd) {
            AsyncImage(
                model = gift.iconUrl.asAssetUrl(),
                contentDescription = gift.name,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .then(
                        when {
                            locked -> Modifier.background(Color(0x99000000))
                            !affordable -> Modifier.background(Color(0x66000000))
                            else -> Modifier
                        }
                    ),
            )
            if (locked) {
                Icon(
                    imageVector = Icons.Default.Lock,
                    contentDescription = null,
                    tint = Color(0xFFFFC94D),
                    modifier = Modifier
                        .size(14.dp)
                        .background(Color(0xCC151233), CircleShape)
                        .padding(2.dp),
                )
            }
        }
        Spacer(Modifier.height(2.dp))
        Text(
            text = gift.name,
            color = Color(0xFFF3F1FF),
            fontSize = 10.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
        )
        Text(
            text = if (locked) "VIP ${gift.minVipLevel}" else "\u2756 ${gift.diamondPrice}",
            color = when {
                locked -> Color(0xFFFFC94D)
                affordable -> Color(0xFF4DD0E1)
                else -> Color(0xFFFF8FA0)
            },
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun PresetChip(
    text: String,
    active: Boolean,
    onClick: () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(width = 40.dp, height = 28.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (active) Color(0xFF7C4DFF) else Color(0xFF241F3D))
            .clickable(onClick = onClick),
    ) {
        Text(text, color = Color(0xFFF3F1FF), fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

/** "All" + one chip per catalogue category; null = unfiltered. */
@Composable
private fun CategoryTabs(
    categories: List<String>,
    selected: String?,
    onSelect: (String?) -> Unit,
) {
    androidx.compose.foundation.lazy.LazyRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(count = categories.size + 1) { idx ->
            val category = if (idx == 0) null else categories[idx - 1]
            val active = category == selected || (idx == 0 && selected == null)
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .height(30.dp)
                    .clip(RoundedCornerShape(50))
                    .then(
                        if (active) {
                            Modifier.background(
                                Brush.horizontalGradient(listOf(Color(0xFFE040FB), Color(0xFF22D3EE))),
                            )
                        } else {
                            Modifier.background(Color(0xFF241F3D))
                        }
                    )
                    .clickable { onSelect(category) }
                    .padding(horizontal = 14.dp),
            ) {
                Text(
                    text = category?.replace('_', ' ')?.lowercase()?.replaceFirstChar { it.uppercase() } ?: "All",
                    color = if (active) Color(0xFF140F2B) else Color(0xFFB9B4D6),
                    fontSize = 11.sp,
                    fontWeight = if (active) FontWeight.Black else FontWeight.SemiBold,
                )
            }
        }
    }
}

/**
 * A page is two rows of four, so the panel height is fixed rather than wrapped:
 * the pager must not resize while a second tap lands on a tile.
 */
private val PANEL_HEIGHT = 148.dp

@Composable
private fun SelectedGiftBar(gift: Gift, quantity: Int, receiver: MiniUser?) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Color(0xFF1B1740))
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        AsyncImage(
            model = gift.iconUrl.asAssetUrl(),
            contentDescription = gift.name,
            contentScale = ContentScale.Fit,
            modifier = Modifier.size(36.dp),
        )
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = gift.name,
                color = Color(0xFFF3F1FF),
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "\u2756 ${gift.diamondPrice} each \u00B7 \u25C9 ${gift.rCoinValue} to the host",
                color = Color(0xFFB9B4D6),
                fontSize = 10.sp,
            )
        }
        if (receiver != null) {
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = "\u00D7 $quantity",
                    color = Color(0xFF4DD0E1),
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Black,
                )
                Text(
                    text = "to ${receiver.username.take(10)}",
                    color = Color(0xFFB9B4D6),
                    fontSize = 10.sp,
                )
            }
        }
    }
}
