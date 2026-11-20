package com.voiza.app.ui.screens.marketplace

import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.MarketplaceOrder
import com.voiza.app.domain.model.MarketplacePackage
import com.voiza.app.domain.model.MarketplaceSeller
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSheet
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.RCoinGreen
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.viewmodel.MarketplaceViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * Coin-seller market, member side. The catalogue and the order list are allowlisted server
 * projections; a tap only names a seller/package/rail, and proof of payment is just evidence for
 * finance. Nothing on this screen credits diamonds.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MarketplaceScreen(
    onBack: () -> Unit,
    viewModel: MarketplaceViewModel = viewModel(factory = voizaViewModelFactory { MarketplaceViewModel() }),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var tab by remember { mutableIntStateOf(0) }
    var draft by remember { mutableStateOf<Pair<MarketplaceSeller, MarketplacePackage>?>(null) }
    var proofOrderId by remember { mutableStateOf<String?>(null) }
    var saleSellerId by remember { mutableStateOf<String?>(null) }
    var saleAmount by remember { mutableStateOf("") }

    val proofPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val orderId = proofOrderId
        proofOrderId = null
        if (uri == null || orderId == null) return@rememberLauncherForActivityResult
        val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        if (bytes != null) {
            val name = uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "proof.jpg"
            viewModel.uploadReceipt(orderId, name, Base64.encodeToString(bytes, Base64.NO_WRAP))
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .navigationBarsPadding(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 6.dp, vertical = 6.dp)) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
            }
            Text("Coin sellers", color = OnDarkHigh, fontSize = 19.sp, fontWeight = FontWeight.Bold)
        }

        TabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Buy diamonds") })
            Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Sell R-coins") })
        }

        if (state.loading) LoadingProgress()

        when (tab) {
            0 -> BuyTab(
                sellers = state.sellers,
                orders = state.orders,
                busy = state.busy,
                onOrder = { seller, pack -> draft = seller to pack },
                onProof = { orderId ->
                    proofOrderId = orderId
                    proofPicker.launch(arrayOf("image/*", "application/pdf"))
                },
            )
            1 -> SellTab(
                sellers = state.sellers,
                selectedId = saleSellerId,
                amount = saleAmount,
                busy = state.busy,
                onSelect = { saleSellerId = it },
                onAmount = { saleAmount = it },
                onSubmit = {
                    val sellerId = saleSellerId
                    val amount = saleAmount.toIntOrNull()
                    if (sellerId != null && amount != null) viewModel.sellRCoins(sellerId, amount)
                },
            )
        }

        state.message?.let { msg ->
            LaunchedEffect(msg) { viewModel.consumeMessage() }
            Text(
                text = msg,
                color = RCoinGreen,
                fontSize = 12.sp,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }
        state.error?.let { err ->
            Text(
                text = err,
                color = DangerRed,
                fontSize = 12.sp,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }
    }

    draft?.let { (seller, pack) ->
        OrderSheet(
            seller = seller,
            pack = pack,
            busy = state.busy,
            onDismiss = { draft = null },
            onSubmit = { rail, note ->
                viewModel.createOrder(seller.id, pack.key, rail, note)
                draft = null
            },
        )
    }
}

@Composable
private fun ColumnScope.BuyTab(
    sellers: List<MarketplaceSeller>,
    orders: List<MarketplaceOrder>,
    busy: Boolean,
    onOrder: (MarketplaceSeller, MarketplacePackage) -> Unit,
    onProof: (String) -> Unit,
) {
    LazyColumn(
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth().weight(1f),
    ) {
        item {
            Text(
                "Prices and rails come from the seller's approved account. An order holds the diamonds " +
                    "until finance verifies your proof of payment.",
                color = OnDarkMedium,
                fontSize = 12.sp,
            )
        }
        if (sellers.isEmpty()) {
            item {
                EmptyState(
                    icon = Icons.Default.AccountBalanceWallet,
                    title = "No sellers approved yet",
                    subtitle = "The operator has not approved a coin seller for this market.",
                )
            }
        }
        items(sellers, key = { it.id }) { seller ->
            VoizaCard(modifier = Modifier.fillMaxWidth()) {
                Text(seller.displayName, color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                Text(
                    "${seller.code}${seller.marketCountry?.let { " · $it" } ?: ""} · ${seller.paymentRails.joinToString(", ")}",
                    color = OnDarkMedium,
                    fontSize = 11.sp,
                )
                Spacer(Modifier.height(6.dp))
                if (seller.packages.isEmpty()) {
                    Text("No packages offered yet", color = OnDarkMedium, fontSize = 12.sp)
                }
                seller.packages.forEach { pack ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(pack.label, color = OnDarkHigh, fontSize = 12.sp)
                            Text(
                                "+${pack.diamonds} ◈ · ${pack.priceLabel()}",
                                color = DiamondGold,
                                fontSize = 11.sp,
                            )
                        }
                        VoizaButton(
                            text = "Order",
                            onClick = { onOrder(seller, pack) },
                            enabled = !busy,
                            height = 36,
                            modifier = Modifier.fillMaxWidth(0.32f),
                        )
                    }
                }
            }
        }
        item {
            Text("Your orders", color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        }
        if (orders.isEmpty()) {
            item { Text("No orders yet.", color = OnDarkMedium, fontSize = 12.sp) }
        }
        items(orders, key = { it.id }) { order ->
            VoizaCard(modifier = Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(order.reference, color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.weight(1f))
                    Text(order.status.replace('_', ' '), color = statusColor(order.status), fontSize = 11.sp)
                }
                Text(
                    "${order.sellerName} · +${order.diamonds} ◈ · ${order.amountCents / 100.0} ${order.currency.uppercase()} " +
                        "via ${order.paymentMethod}",
                    color = OnDarkMedium,
                    fontSize = 11.sp,
                )
                if (order.status == "AWAITING_PAYMENT" || order.status == "AWAITING_VERIFICATION") {
                    Spacer(Modifier.height(6.dp))
                    VoizaButton(
                        text = "Attach proof of payment",
                        onClick = { onProof(order.id) },
                        enabled = !busy,
                        height = 38,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

@Composable
private fun ColumnScope.SellTab(
    sellers: List<MarketplaceSeller>,
    selectedId: String?,
    amount: String,
    busy: Boolean,
    onSelect: (String) -> Unit,
    onAmount: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Text(
            "Sell R-coins to an approved seller. The server books a withdrawal to the seller you choose; " +
                "no rate is worked out on the device.",
            color = OnDarkMedium,
            fontSize = 12.sp,
        )
        Spacer(Modifier.height(10.dp))
        Row(modifier = Modifier.horizontalScroll(rememberScrollState())) {
            sellers.forEach { seller ->
                FilterChip(
                    selected = seller.id == selectedId,
                    onClick = { onSelect(seller.id) },
                    label = { Text(seller.displayName, fontSize = 12.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        containerColor = VoizaSurfaceHigh,
                        labelColor = DiamondGold,
                    ),
                    modifier = Modifier.padding(end = 8.dp),
                )
            }
        }
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = amount,
            onValueChange = onAmount,
            label = { Text("R-coins to sell") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        VoizaButton(
            text = "Send sale request",
            onClick = onSubmit,
            enabled = !busy && selectedId != null && amount.toIntOrNull()?.let { it > 0 } == true,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OrderSheet(
    seller: MarketplaceSeller,
    pack: MarketplacePackage,
    busy: Boolean,
    onDismiss: () -> Unit,
    onSubmit: (String, String?) -> Unit,
) {
    var rail by remember { mutableStateOf(seller.paymentRails.firstOrNull().orEmpty()) }
    var note by remember { mutableStateOf("") }
    VoizaSheet(visible = true, title = "Order from ${seller.displayName}", onDismiss = onDismiss) {
        Text("+${pack.diamonds} ◈ · ${pack.priceLabel()}", color = DiamondGold, fontSize = 13.sp)
        Spacer(Modifier.height(8.dp))
        Text("Pay with", color = OnDarkMedium, fontSize = 12.sp)
        Row(modifier = Modifier.horizontalScroll(rememberScrollState())) {
            seller.paymentRails.forEach { option ->
                FilterChip(
                    selected = rail == option,
                    onClick = { rail = option },
                    label = { Text(option, fontSize = 12.sp) },
                    colors = FilterChipDefaults.filterChipColors(
                        containerColor = VoizaSurfaceHigh,
                        labelColor = DiamondGold,
                    ),
                    modifier = Modifier.padding(end = 8.dp),
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = note,
            onValueChange = { note = it },
            label = { Text("Note (optional)") },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        VoizaButton(
            text = "Open order",
            onClick = { onSubmit(rail, note.ifBlank { null }) },
            enabled = !busy && rail.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun statusColor(status: String) = when (status) {
    "CREDITED" -> RCoinGreen
    "REJECTED", "CANCELLED", "EXPIRED", "REVERSED" -> DangerRed
    else -> DiamondGold
}
