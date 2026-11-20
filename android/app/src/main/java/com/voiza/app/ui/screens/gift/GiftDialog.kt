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
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.voiza.app.domain.model.BannerPlacement
import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.GiftCategoryOption
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatStatus
import com.voiza.app.domain.model.User
import com.voiza.app.domain.usecase.RoomEffects
import com.voiza.app.viewmodel.PartyRoomViewModel.PartyRoomUiState
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.asAssetUrl
import com.voiza.app.ui.components.DiamondChip
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.banner.PromoBannerStrip
import com.voiza.app.viewmodel.PartyRoomViewModel
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.Violet
import com.voiza.app.ui.theme.VioletLight
import com.voiza.app.ui.theme.VoizaBackground
import com.voiza.app.ui.theme.VoizaCtaGradient
import com.voiza.app.ui.theme.VoizaOutline
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaSurfaceVariant
import com.voiza.app.ui.theme.WarningAmber

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
        containerColor = VoizaSurfaceHigh,
        shape = RoundedCornerShape(22.dp),
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Send a gift", color = OnDarkHigh, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                Spacer(Modifier.width(10.dp))
                Text(
                    text = "Ranking",
                    color = VioletLight,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .background(VoizaSurfaceVariant)
                        .clickable(onClick = onOpenRanking)
                        .padding(horizontal = 9.dp, vertical = 4.dp),
                )
                Spacer(Modifier.weight(1f))
                DiamondChip(balance = balance)
            }
        },
        text = {
            Column {
                // The gift panel's own campaign, above everything else the operator is running. It
                // is drawn shorter than the home strip because this dialog has a Send button at the
                // bottom of it: art is not worth pushing the button out of reach for.
                PromoBannerStrip(
                    placement = BannerPlacement.GIFT,
                    artHeight = 64.dp,
                    modifier = Modifier.padding(bottom = 10.dp),
                )

                // ---- Receiver chips (seated speakers; host default) ----
                val receivers = state.seatedUsers
                if (receivers.isNotEmpty()) {
                    Text("To", color = OnDarkMedium, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
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
                                        VoizaSurfaceVariant
                                    } else {
                                        VoizaSurfaceHigh
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
                                    color = OnDarkHigh,
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
                                                VioletLight
                                            } else {
                                                VoizaOutline
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
                            Icon(Icons.Default.Remove, contentDescription = "less", tint = OnDarkHigh)
                        }
                        Text(
                            text = "${state.giftQuantity}",
                            color = OnDarkHigh,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Bold,
                        )
                        IconButton(
                            onClick = { onQuantitySet(state.giftQuantity + 1) },
                            enabled = affordable,
                        ) {
                            Icon(Icons.Default.Add, contentDescription = "more", tint = OnDarkHigh)
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
                                .background(WarningAmber.copy(alpha = 0.20f))
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        ) {
                            Text(
                                text = "Needs VIP ${selected.minVipLevel} — you are VIP ${state.user?.vipLevel ?: 0}. " +
                                    "An operator sets the tier.",
                                color = WarningAmber,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    } else if (!affordable) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .clip(RoundedCornerShape(10.dp))
                                .background(DangerRed.copy(alpha = 0.20f))
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        ) {
                            Text(
                                text = "Need \u2756 $cost, you have \u2756 $balance. Recharge to send.",
                                color = DangerRed.copy(alpha = 0.90f),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    } else {
                        Text(
                            text = "Total \u2756 $cost \u2192 host earns \u25C9 ${selected.rCoinValue * state.giftQuantity}",
                            color = OnDarkMedium,
                            fontSize = 12.sp,
                        )
                    }
                }

                state.giftError?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(it, color = DangerRed, fontSize = 12.sp)
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
                gradient = VoizaCtaGradient,
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
                        .background(if (active) VoizaSurfaceVariant else VoizaSurfaceHigh)
                        .clickable { onSelectReceiver(user.id) }
                        .padding(vertical = 8.dp),
                ) {
                    Avatar(url = user.avatarUrl, name = user.username, size = 30.dp)
                    Text(
                        text = user.username.take(6),
                        color = OnDarkHigh,
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
            .background(if (selected) VoizaSurfaceVariant else VoizaSurfaceHigh)
            .then(if (selected) Modifier.background(Brush.horizontalGradient(listOf(Violet.copy(alpha = 0.20f), VioletLight.copy(alpha = 0.20f)))) else Modifier)
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
                    tint = WarningAmber,
                    modifier = Modifier
                        .size(14.dp)
                        .background(VoizaSurfaceHigh.copy(alpha = 0.80f), CircleShape)
                        .padding(2.dp),
                )
            }
        }
        Spacer(Modifier.height(2.dp))
        Text(
            text = gift.name,
            color = OnDarkHigh,
            fontSize = 10.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
        )
        Text(
            text = if (locked) "VIP ${gift.minVipLevel}" else "\u2756 ${gift.diamondPrice}",
            color = when {
                locked -> WarningAmber
                affordable -> VioletLight
                else -> DangerRed.copy(alpha = 0.90f)
            },
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
        )
        if (gift.isLuckyBox) {
            // What the box is actually selling: the best prize in the draw and how often it comes
            // up. Both numbers are the server's own — `chanceBps` is the prize's weight against the
            // box's total, divided where the weights were written — so the tile cannot promise odds
            // the draw does not honour.
            Text(
                text = luckyOddsLabel(gift),
                color = DiamondGold,
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

/** "LUCKY 10x 1 in 100", or the shorter form when a box has no prize table published to read. */
private fun luckyOddsLabel(gift: Gift): String {
    val best = gift.boxOutcomes.maxByOrNull { it.multiplierBps } ?: return "LUCKY BOX"
    // A prize with no disclosed chance is one this build was not told the odds of; saying so is the
    // honest label, and inventing "1 in ?" would be the app making up a number about a payout.
    val oneIn = if (best.chanceBps <= 0) null else BPS_FULL / best.chanceBps
    return if (oneIn == null) "LUCKY ${best.label}" else "LUCKY ${best.label} 1 in $oneIn"
}

private const val BPS_FULL = 10_000

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
            .background(if (active) Violet else VoizaSurfaceVariant)
            .clickable(onClick = onClick),
    ) {
        Text(text, color = OnDarkHigh, fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

/**
 * "All" + one chip per catalogue shelf; selecting a chip reports its key (null = "All"). The label
 * comes straight from the server, so an operator's chosen name is shown as written.
 */
@Composable
private fun CategoryTabs(
    categories: List<GiftCategoryOption>,
    selected: String?,
    onSelect: (String?) -> Unit,
) {
    androidx.compose.foundation.lazy.LazyRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(count = categories.size + 1) { idx ->
            val category = if (idx == 0) null else categories[idx - 1]
            val active = category?.key == selected || (idx == 0 && selected == null)
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .height(30.dp)
                    .clip(RoundedCornerShape(50))
                    .then(
                        if (active) {
                            Modifier.background(
                                VoizaCtaGradient,
                            )
                        } else {
                            Modifier.background(VoizaSurfaceVariant)
                        }
                    )
                    .clickable { onSelect(category?.key) }
                    .padding(horizontal = 14.dp),
            ) {
                Text(
                    text = category?.name ?: "All",
                    color = if (active) VoizaBackground else OnDarkMedium,
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
            .background(VoizaSurfaceHigh)
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
                color = OnDarkHigh,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "\u2756 ${gift.diamondPrice} each \u00B7 \u25C9 ${gift.rCoinValue} to the host",
                color = OnDarkMedium,
                fontSize = 10.sp,
            )
        }
        if (receiver != null) {
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = "\u00D7 $quantity",
                    color = VioletLight,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Black,
                )
                Text(
                    text = "to ${receiver.username.take(10)}",
                    color = OnDarkMedium,
                    fontSize = 10.sp,
                )
            }
        }
    }
}

private val previewGiftMe = User(
    id = "me",
    phone = "+10000000000",
    username = "Ava",
    avatarUrl = null,
    bio = null,
    gender = null,
    countryCode = "US",
    diamondBalance = 5_000,
    rCoinBalance = 0,
    totalGiftsSent = 0,
    totalGiftsReceived = 0,
    userType = "USER",
    status = "ACTIVE",
    isVerified = true,
    vipLevel = 1,
)

private val previewGiftHost = MiniUser(id = "host-1", username = "Ava", avatarUrl = null)
private val previewGiftMember = MiniUser(id = "member-2", username = "Mira", avatarUrl = null)

private val previewGiftCatalogue = listOf(
    Gift(
        id = "gift-rose",
        name = "Rose",
        iconUrl = "",
        animationUrl = null,
        diamondPrice = 10,
        rCoinValue = 90,
        category = "popular",
        sortOrder = 1,
    ),
    Gift(
        id = "gift-heart",
        name = "Heart",
        iconUrl = "",
        animationUrl = null,
        diamondPrice = 30,
        rCoinValue = 270,
        category = "popular",
        sortOrder = 2,
    ),
    Gift(
        id = "gift-crown",
        name = "Crown",
        iconUrl = "",
        animationUrl = null,
        diamondPrice = 500,
        rCoinValue = 4_500,
        category = "luxury",
        minVipLevel = 2,
        sortOrder = 3,
    ),
    Gift(
        id = "gift-rocket",
        name = "Rocket",
        iconUrl = "",
        animationUrl = null,
        diamondPrice = 200,
        rCoinValue = 1_800,
        category = "luxury",
        sortOrder = 4,
    ),
    Gift(
        id = "gift-box",
        name = "Lucky Box",
        iconUrl = "",
        animationUrl = null,
        diamondPrice = 100,
        rCoinValue = 900,
        category = "special",
        sortOrder = 5,
        isLuckyBox = true,
    ),
)

@Preview(showBackground = true, name = "Gift dialog")
@Composable
fun GiftDialogPreview() {
    GiftDialog(
        state = PartyRoomUiState(
            loading = false,
            joined = true,
            user = previewGiftMe,
            seats = listOf(
                Seat(0, SeatStatus.OCCUPIED, isMuted = false, isSpeaker = true, user = previewGiftHost),
                Seat(1, SeatStatus.OCCUPIED, isMuted = false, isSpeaker = true, user = previewGiftMember),
            ),
            giftCatalog = previewGiftCatalogue,
            giftShelves = listOf(
                GiftCategoryOption(key = "popular", name = "Popular", sortOrder = 0),
                GiftCategoryOption(key = "luxury", name = "Luxury", sortOrder = 1),
                GiftCategoryOption(key = "special", name = "Special", sortOrder = 2),
            ),
            giftDialogVisible = true,
            giftCategory = null,
            selectedGift = previewGiftCatalogue[1],
            selectedReceiverId = previewGiftHost.id,
            giftQuantity = 2,
        ),
        onTapGift = {},
        onSelectCategory = {},
        onSelectReceiver = {},
        onQuantitySet = {},
        onSend = {},
        onOpenRanking = {},
        onDismiss = {},
    )
}
