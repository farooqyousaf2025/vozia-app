package com.voiza.app.ui.screens.partner

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.CommissionEntry
import com.voiza.app.domain.model.CommissionEntryStatus
import com.voiza.app.domain.model.CommissionSettlement
import com.voiza.app.domain.model.CommissionSettlementStatus
import com.voiza.app.domain.model.PartnerAccount
import com.voiza.app.domain.model.PartnerAccountStatus
import com.voiza.app.domain.model.PartnerDashboard
import com.voiza.app.domain.model.PartnerSellerRow
import com.voiza.app.data.export.toPartnerSellerCsv
import com.voiza.app.data.export.toRechargeOrderCsv
import com.voiza.app.domain.model.PartnerStatement
import com.voiza.app.domain.model.RechargeOrder
import com.voiza.app.domain.model.RechargeOrderStatus
import com.voiza.app.domain.model.SellerCashBook
import com.voiza.app.domain.model.SellerPayout
import com.voiza.app.domain.model.SellerPayoutStatus
import com.voiza.app.domain.model.SellerReport
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.RCoinGreen
import com.voiza.app.ui.theme.Violet
import com.voiza.app.ui.theme.VioletLight
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.WarningAmber
import com.voiza.app.ui.theme.VoizaOutline
import com.voiza.app.viewmodel.PartnerDeskViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The partner desk, from the partner's side of it.
 *
 * A coin seller and a BD read the same route and get different work: the seller opens recharge
 * orders, claims payment, attaches proof and answers members' R-coin sales; the BD reads the sellers
 * in its territory. Which sections exist is decided by the kind the server's whoami returned — the
 * same answer every `/api/partner` route re-checks — so this screen never offers a move the server
 * would refuse, and never hides one it would allow.
 *
 * Nothing here credits diamonds or pays a sale. Marking an order paid claims the money arrived;
 * finance reviews the proof and decides. The copy says so, because a seller who believes a tap
 * moved money is a seller who will hand over diamonds twice.
 */
@Composable
fun PartnerDeskScreen(
    onBack: () -> Unit,
    viewModel: PartnerDeskViewModel = viewModel(
        factory = voizaViewModelFactory { PartnerDeskViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // An order can be credited, a sale paid or an account suspended while the partner is elsewhere.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.load() }

    var createOpen by remember { mutableStateOf(false) }
    var markPaidFor by remember { mutableStateOf<RechargeOrder?>(null) }
    var cancelFor by remember { mutableStateOf<RechargeOrder?>(null) }
    var receiptTarget by remember { mutableStateOf<PartnerDeskViewModel.ReceiptTarget?>(null) }
    var banner by remember { mutableStateOf<String?>(null) }
    var fileError by remember { mutableStateOf<String?>(null) }
    var pendingSellerExport by remember { mutableStateOf<List<PartnerSellerRow>?>(null) }
    var pendingOrderExport by remember { mutableStateOf<List<RechargeOrder>?>(null) }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val receiptPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val target = receiptTarget
        receiptTarget = null
        if (uri == null || target == null) return@rememberLauncherForActivityResult
        scope.launch {
            when (val read = withContext(Dispatchers.IO) { readReceipt(context, uri) }) {
                is ReceiptRead.Failed -> fileError = read.message
                is ReceiptRead.Ok -> viewModel.attachReceipt(target, read.fileName, read.base64)
            }
        }
    }

    val sellerExportLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("text/csv"),
    ) { uri ->
        val sellers = pendingSellerExport
        if (uri != null && sellers != null) {
            val saved = runCatching {
                context.contentResolver.openOutputStream(uri)?.bufferedWriter(Charsets.UTF_8)?.use {
                    it.write(sellers.toPartnerSellerCsv())
                } ?: error("Could not open the selected file.")
            }.isSuccess
            banner = if (saved) "Seller network CSV saved." else "Could not save seller network CSV."
        }
        pendingSellerExport = null
    }

    val orderExportLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("text/csv"),
    ) { uri ->
        val orders = pendingOrderExport
        if (uri != null && orders != null) {
            val saved = runCatching {
                context.contentResolver.openOutputStream(uri)?.bufferedWriter(Charsets.UTF_8)?.use {
                    it.write(orders.toRechargeOrderCsv())
                } ?: error("Could not open the selected file.")
            }.isSuccess
            banner = if (saved) "Recharge orders CSV saved." else "Could not save recharge orders CSV."
        }
        pendingOrderExport = null
    }

    // A write's outcome lands once: success closes the dialog and leaves a banner; a failure stays
    // in the dialog that caused it, or in the banner when the proof picker was the cause.
    LaunchedEffect(state.actionEvent) {
        val event = state.actionEvent ?: return@LaunchedEffect
        val dialogOpen = createOpen || markPaidFor != null || cancelFor != null
        if (event.success) {
            createOpen = false
            markPaidFor = null
            cancelFor = null
            banner = event.message
            viewModel.acknowledgeAction()
        } else if (!dialogOpen) {
            banner = event.message
            viewModel.acknowledgeAction()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .statusBarsPadding()
            .padding(horizontal = 20.dp, vertical = 16.dp),
    ) {
        val account = state.account
        DeskHeader(
            title = account?.displayName?.takeIf { it.isNotBlank() } ?: "Partner desk",
            subtitle = account?.let { "${it.kindLabel} · ${it.code}" }
                ?: "Your orders, your commission, and the cash you hold for the platform.",
            onBack = onBack,
        )
        Spacer(Modifier.height(10.dp))

        if (account == null) {
            if (state.loading) {
                LoadingProgress(overlay = false)
                return@Column
            }
            // The server's own refusal, shown as written: a member without an active partner account
            // is told the same thing whichever route they reached first.
            Text(
                text = state.error ?: "This account does not run a seller or BD desk.",
                color = DangerRed,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(14.dp))
            VoizaButton(text = "Try again", onClick = viewModel::load, height = 44, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            VoizaSecondaryButton(text = "Back", onClick = onBack, modifier = Modifier.fillMaxWidth())
            return@Column
        }

        (banner ?: fileError)?.let { message ->
            Text(
                text = message,
                color = if (fileError != null) DangerRed else RCoinGreen,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(VoizaSurface)
                    .clickable { banner = null; fileError = null }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            )
            Spacer(Modifier.height(8.dp))
        }

        // A BD's seller report takes over the content area; the header and back stay put.
        if (state.reportLoading || state.reportError != null || state.sellerReport != null) {
            SellerReportView(
                loading = state.reportLoading,
                error = state.reportError,
                report = state.sellerReport,
                onClose = viewModel::closeSellerReport,
            )
            return@Column
        }

        var tab by remember(account.id) { mutableStateOf(DeskTab.OVERVIEW) }
        var sellerQuery by remember(account.id) { mutableStateOf("") }
        var sellerStatusFilter by remember(account.id) { mutableStateOf("All") }
        var orderQuery by remember(account.id) { mutableStateOf("") }
        var orderStatusFilter by remember(account.id) { mutableStateOf("All") }
        val tabs = if (account.isSeller) {
            listOf(DeskTab.OVERVIEW, DeskTab.ORDERS, DeskTab.SALES, DeskTab.STATEMENT)
        } else {
            listOf(DeskTab.OVERVIEW, DeskTab.ORDERS, DeskTab.SELLERS, DeskTab.STATEMENT)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            tabs.forEach { candidate ->
                TabPill(candidate.label, selected = tab == candidate, onClick = { tab = candidate })
            }
        }
        Spacer(Modifier.height(10.dp))

        val attach: (PartnerDeskViewModel.ReceiptTarget) -> Unit = { target ->
            fileError = null
            receiptTarget = target
            receiptPicker.launch(arrayOf("image/png", "image/jpeg", "image/webp", "application/pdf"))
        }

        LazyColumn(
            contentPadding = PaddingValues(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            when (tab) {
                DeskTab.OVERVIEW -> {
                    item { AccountCard(account) }
                    item { NumbersCard(state.dashboard, state.dashboardError) }
                    if (account.isBd) {
                        item { BdTerritorySnapshotCard(state.sellers, state.sellersError, account.kind == com.voiza.app.domain.model.PartnerKind.BD_MANAGER) }
                    }
                    if (account.isSeller) {
                        item {
                            VoizaButton(
                                text = "New recharge order",
                                onClick = { createOpen = true },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }
                DeskTab.ORDERS -> {
                    if (account.isSeller) {
                        item {
                            VoizaButton(
                                text = "New recharge order",
                                onClick = { createOpen = true },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                    item {
                        OrdersCard(
                            orders = state.orders,
                            total = state.ordersTotal,
                            error = state.ordersError,
                            isSeller = account.isSeller,
                            query = orderQuery,
                            onQueryChange = { orderQuery = it },
                            statusFilter = orderStatusFilter,
                            onStatusFilterChange = { orderStatusFilter = it },
                            onMarkPaid = { markPaidFor = it },
                            onCancel = { cancelFor = it },
                            onAttachProof = { order ->
                                attach(PartnerDeskViewModel.ReceiptTarget(order.id, null, order.reference))
                            },
                            onExport = { filtered ->
                                pendingOrderExport = filtered
                                orderExportLauncher.launch("vozia-recharge-orders.csv")
                            },
                        )
                    }
                }
                DeskTab.SALES -> item {
                    SalesCard(state.payouts, state.payoutsError) { payout ->
                        attach(PartnerDeskViewModel.ReceiptTarget(null, payout.id, payout.reference))
                    }
                }
                DeskTab.SELLERS -> item {
                    SellersCard(
                        sellers = state.sellers,
                        error = state.sellersError,
                        query = sellerQuery,
                        onQueryChange = { sellerQuery = it },
                        statusFilter = sellerStatusFilter,
                        onStatusFilterChange = { sellerStatusFilter = it },
                        onExport = { filtered ->
                            pendingSellerExport = filtered
                            sellerExportLauncher.launch("vozia-bd-seller-network.csv")
                        },
                        onOpen = viewModel::openSellerReport,
                    )
                }
                DeskTab.STATEMENT -> item { StatementSection(state.statement, state.statementError) }
            }
        }
    }

    if (createOpen) {
        CreateOrderDialog(
            state = state,
            onDismiss = { createOpen = false; viewModel.acknowledgeAction(); viewModel.clearLookup() },
            onCheck = viewModel::lookupCustomer,
            onCreate = viewModel::createOrder,
        )
    }
    markPaidFor?.let { order ->
        MarkPaidDialog(
            order = order,
            busy = state.actionBusy,
            error = state.actionEvent?.takeIf { !it.success }?.message,
            onDismiss = { markPaidFor = null; viewModel.acknowledgeAction() },
            onConfirm = { ref -> viewModel.markPaid(order.id, ref) },
        )
    }
    cancelFor?.let { order ->
        CancelDialog(
            order = order,
            busy = state.actionBusy,
            error = state.actionEvent?.takeIf { !it.success }?.message,
            onDismiss = { cancelFor = null; viewModel.acknowledgeAction() },
            onConfirm = { reason -> viewModel.cancelOrder(order.id, reason) },
        )
    }
}

private enum class DeskTab(val label: String) {
    OVERVIEW("Overview"),
    ORDERS("Orders"),
    SALES("R-coin sales"),
    SELLERS("Sellers"),
    STATEMENT("Statement"),
}

// ---------------------------------------------------------------------------
// Overview: who this account is, and the numbers the platform has booked for it.
// ---------------------------------------------------------------------------

@Composable
private fun BdTerritorySnapshotCard(
    sellers: List<PartnerSellerRow>,
    error: String?,
    isManager: Boolean,
) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        DeskSectionLabel(if (isManager) "Your seller territory" else "Your assigned sellers")
        if (error != null) {
            Text(error, color = DangerRed, fontSize = 11.sp)
            return@VoizaCard
        }
        if (sellers.isEmpty()) {
            Text("No seller rows are currently available in your authorized territory.", color = OnDarkMedium, fontSize = 12.sp)
            return@VoizaCard
        }
        val active = sellers.count { it.status == PartnerAccountStatus.ACTIVE }
        val pending = sellers.count { it.status == PartnerAccountStatus.PENDING }
        val suspended = sellers.count { it.status == PartnerAccountStatus.SUSPENDED }
        val orders = sellers.sumOf { it.recharge.orders }
        val credited = sellers.sumOf { it.recharge.credited }
        val diamonds = sellers.sumOf { it.recharge.processedDiamonds }
        FigureRow("Sellers returned by your BD scope", count(sellers.size), OnDarkHigh)
        FigureRow("Active · Pending · Suspended", "$active · $pending · $suspended", OnDarkHigh)
        Spacer(Modifier.height(6.dp))
        FigureRow("Combined orders", count(orders), OnDarkHigh)
        FigureRow("Credited orders", count(credited), RCoinGreen)
        FigureRow("Diamonds processed", count(diamonds), OnDarkHigh)
        Text(
            "Summary uses only the seller rows returned for your signed-in BD account. It does not include another BD's territory or change seller access.",
            color = OnDarkMedium.copy(alpha = 0.75f),
            fontSize = 10.sp,
        )
    }
}

@Composable
private fun AccountCard(account: PartnerAccount) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = account.kindLabel,
                color = OnDarkHigh,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            Pill(account.statusLabel, accountColor(account.status))
        }
        Text(
            text = account.parentName?.let { "Under $it (${account.parentCode.orEmpty()})" }
                ?: "No BD above this account",
            color = OnDarkMedium,
            fontSize = 11.sp,
        )
        account.suspendedReason?.takeIf { it.isNotBlank() }?.let {
            Text("Suspended: $it", color = DangerRed, fontSize = 11.sp)
        }
        Spacer(Modifier.height(10.dp))
        if (account.marketCountry.isNotBlank()) {
            FigureRow("Market", account.marketCountry, OnDarkHigh)
        }
        if (account.isSeller) {
            FigureRow("Largest single order", "${count(account.maxOrderDiamonds)} diamonds", OnDarkHigh)
            FigureRow("Daily ceiling", "${count(account.dailyDiamondLimit)} diamonds · ${account.dailyOrderLimit} orders", OnDarkHigh)
        }
        FigureRow("On the platform since", shortDate(account.createdAt), OnDarkHigh)
    }
}

@Composable
private fun NumbersCard(dashboard: PartnerDashboard?, error: String?) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        DeskSectionLabel("The book so far")
        if (error != null) {
            Text(error, color = DangerRed, fontSize = 11.sp)
            return@VoizaCard
        }
        if (dashboard == null) {
            LoadingProgress(overlay = false, size = 28.dp)
            return@VoizaCard
        }
        val currency = dashboard.commission.currency
        val recharge = dashboard.recharge
        FigureRow("Orders opened", count(recharge.orders), OnDarkHigh)
        FigureRow("Credited", count(recharge.credited), RCoinGreen)
        FigureRow("In review", count(recharge.awaitingVerification), WarningAmber)
        if (recharge.failed > 0) FigureRow("Rejected or expired", count(recharge.failed), DangerRed)
        if (recharge.reversed > 0) FigureRow("Reversed", count(recharge.reversed), DangerRed)
        FigureRow("Diamonds processed", count(recharge.processedDiamonds), OnDarkHigh)
        FigureRow("Cash collected (net)", money(recharge.netCollectedMinor, currency), RCoinGreen)
        Spacer(Modifier.height(8.dp))
        DeskSectionLabel("Commission")
        FigureRow("Accrued, not yet batched", money(dashboard.commission.accruedMinor, currency), RCoinGreen)
        FigureRow("Claimed by batches", money(dashboard.commission.settledMinor, currency), Cyan)
        if (dashboard.commission.reversedMinor > 0) {
            FigureRow("Reversed", money(dashboard.commission.reversedMinor, currency), DangerRed)
        }
        Spacer(Modifier.height(6.dp))
        Text(
            text = "Commission is counted by the platform on credited orders and paid in batches " +
                "finance raises. This desk reads what has been counted; it cannot pay itself.",
            color = OnDarkMedium.copy(alpha = 0.75f),
            fontSize = 10.sp,
        )
    }
}

// ---------------------------------------------------------------------------
// Orders: the seller's working list. A BD reads the same list across its territory, without moves.
// ---------------------------------------------------------------------------

@Composable
private fun OrdersCard(
    orders: List<RechargeOrder>,
    total: Int,
    error: String?,
    isSeller: Boolean,
    query: String,
    onQueryChange: (String) -> Unit,
    statusFilter: String,
    onStatusFilterChange: (String) -> Unit,
    onMarkPaid: (RechargeOrder) -> Unit,
    onCancel: (RechargeOrder) -> Unit,
    onAttachProof: (RechargeOrder) -> Unit,
    onExport: (List<RechargeOrder>) -> Unit,
) {
    val filteredOrders = orders.filter { order ->
        val needle = query.trim()
        val matchesQuery = needle.isBlank() || order.reference.contains(needle, ignoreCase = true) ||
            order.username.contains(needle, ignoreCase = true) || order.paymentRef.orEmpty().contains(needle, ignoreCase = true)
        val matchesStatus = when (statusFilter) {
            "Awaiting payment" -> order.status == RechargeOrderStatus.AWAITING_PAYMENT
            "In review" -> order.status == RechargeOrderStatus.AWAITING_VERIFICATION
            "Credited" -> order.status == RechargeOrderStatus.CREDITED
            "Issues" -> order.status in setOf(RechargeOrderStatus.REJECTED, RechargeOrderStatus.REVERSED, RechargeOrderStatus.CANCELLED, RechargeOrderStatus.EXPIRED)
            else -> true
        }
        matchesQuery && matchesStatus
    }
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        DeskSectionLabel(if (total > 0) "Recharge orders · $total" else "Recharge orders")
        if (error != null) {
            Text(error, color = DangerRed, fontSize = 11.sp)
            return@VoizaCard
        }
        if (orders.isEmpty()) {
            Text(
                text = if (isSeller) "No order yet. Open one when a member is ready to pay."
                else "No order has been opened in your territory yet.",
                color = OnDarkMedium,
                fontSize = 12.sp,
            )
            return@VoizaCard
        }
        OutlinedTextField(
            value = query,
            onValueChange = onQueryChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            placeholder = { Text("Search reference, customer or payment ref", fontSize = 12.sp) },
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = OnDarkHigh),
            colors = deskFieldColors(),
        )
        Spacer(Modifier.height(8.dp))
        Row(
            modifier = Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            listOf("All", "Awaiting payment", "In review", "Credited", "Issues").forEach { filter ->
                Text(
                    text = filter,
                    color = if (statusFilter == filter) RCoinGreen else OnDarkMedium,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (statusFilter == filter) RCoinGreen.copy(alpha = 0.14f) else Color.Transparent)
                        .clickable { onStatusFilterChange(filter) }
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                )
            }
        }
        Spacer(Modifier.height(7.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Showing ${filteredOrders.size} loaded orders · ${total} total", color = OnDarkMedium, fontSize = 10.sp, modifier = Modifier.weight(1f))
            if (isSeller) {
                TextButton(onClick = { onExport(filteredOrders) }, enabled = filteredOrders.isNotEmpty()) {
                    Text("Export CSV")
                }
            }
        }
        if (filteredOrders.isEmpty()) {
            Text("No loaded orders match this search or status filter.", color = OnDarkMedium, fontSize = 12.sp)
        } else {
            filteredOrders.forEach { order -> OrderRow(order, isSeller, onMarkPaid, onCancel, onAttachProof) }
        }
        if (isSeller) {
            Text(
                "Payment claims and proof remain subject to finance verification. This filter never changes order status.",
                color = OnDarkMedium.copy(alpha = 0.75f),
                fontSize = 10.sp,
            )
        }
    }
}

@Composable
private fun OrderRow(
    order: RechargeOrder,
    isSeller: Boolean,
    onMarkPaid: (RechargeOrder) -> Unit,
    onCancel: (RechargeOrder) -> Unit,
    onAttachProof: (RechargeOrder) -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = order.reference,
            color = OnDarkHigh,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.weight(1f),
        )
        Pill(order.statusLabel, orderColor(order.status))
    }
    Text(
        text = "${order.username} · ${count(order.diamonds)} diamonds · ${money(order.amountMinor, order.currency)}",
        color = OnDarkMedium,
        fontSize = 11.sp,
    )
    Text(
        text = "${railLabel(order.paymentMethod)} · opened ${shortDate(order.createdAt)}" +
            (order.paymentRef?.let { " · ref $it" } ?: ""),
        color = OnDarkMedium.copy(alpha = 0.85f),
        fontSize = 10.sp,
    )
    order.decisionNote?.takeIf { it.isNotBlank() }?.let {
        Text("Finance: $it", color = WarningAmber, fontSize = 10.sp)
    }
    order.reversalReason?.takeIf { it.isNotBlank() }?.let {
        Text("Reversed: $it", color = DangerRed, fontSize = 10.sp)
    }
    if (isSeller && order.isOpen) {
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (order.status == RechargeOrderStatus.AWAITING_PAYMENT) {
                SmallAction("Mark paid", Cyan) { onMarkPaid(order) }
            }
            SmallAction("Attach proof", OnDarkMedium) { onAttachProof(order) }
            SmallAction("Cancel", DangerRed) { onCancel(order) }
        }
    }
    Spacer(Modifier.height(10.dp))
}

// ---------------------------------------------------------------------------
// R-coin sales: members selling their balance back. The seller pays cash outside, proves it here.
// ---------------------------------------------------------------------------

@Composable
private fun SalesCard(
    payouts: List<SellerPayout>,
    error: String?,
    onAttachProof: (SellerPayout) -> Unit,
) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        DeskSectionLabel("R-coin sales")
        if (error != null) {
            Text(error, color = DangerRed, fontSize = 11.sp)
            return@VoizaCard
        }
        if (payouts.isEmpty()) {
            Text("No member has asked to sell R-coins to you yet.", color = OnDarkMedium, fontSize = 12.sp)
        } else {
            payouts.forEach { payout ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = payout.reference,
                        color = OnDarkHigh,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                    )
                    Pill(payout.statusLabel, payoutColor(payout.status))
                }
                Text(
                    text = "${payout.username} · ${coins(payout.netRCoins)} net" +
                        (if (payout.feeRCoins > 0) " · ${coins(payout.feeRCoins)} fee" else ""),
                    color = OnDarkMedium,
                    fontSize = 11.sp,
                )
                Text(
                    text = "Asked ${shortDate(payout.createdAt)} · ${payout.receiptCount} proof file(s) on record",
                    color = OnDarkMedium.copy(alpha = 0.85f),
                    fontSize = 10.sp,
                )
                if (payout.acceptsReceipt) {
                    Spacer(Modifier.height(4.dp))
                    SmallAction("Attach proof of payment", Cyan) { onAttachProof(payout) }
                }
                Spacer(Modifier.height(10.dp))
            }
        }
        Text(
            text = "Pay the member the cash you agreed, then attach the proof. Finance confirms the " +
                "sale against it — this desk never moves the R-coins itself.",
            color = OnDarkMedium.copy(alpha = 0.75f),
            fontSize = 10.sp,
        )
    }
}

// ---------------------------------------------------------------------------
// A BD's territory.
// ---------------------------------------------------------------------------

@Composable
private fun SellersCard(
    sellers: List<PartnerSellerRow>,
    error: String?,
    query: String,
    onQueryChange: (String) -> Unit,
    statusFilter: String,
    onStatusFilterChange: (String) -> Unit,
    onExport: (List<PartnerSellerRow>) -> Unit,
    onOpen: (String) -> Unit,
) {
    val filteredSellers = sellers.filter { seller ->
        val matchesQuery = query.isBlank() || seller.displayName.contains(query.trim(), ignoreCase = true) ||
            seller.code.contains(query.trim(), ignoreCase = true)
        val matchesStatus = when (statusFilter) {
            "Active" -> seller.status == PartnerAccountStatus.ACTIVE
            "Pending" -> seller.status == PartnerAccountStatus.PENDING
            "Suspended" -> seller.status == PartnerAccountStatus.SUSPENDED
            else -> true
        }
        matchesQuery && matchesStatus
    }
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        DeskSectionLabel("Your seller network · ${sellers.size}")
        if (error != null) {
            Text(error, color = DangerRed, fontSize = 11.sp)
            return@VoizaCard
        }
        if (sellers.isEmpty()) {
            Text("No seller reports to you yet.", color = OnDarkMedium, fontSize = 12.sp)
            return@VoizaCard
        }
        OutlinedTextField(
            value = query,
            onValueChange = onQueryChange,
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            placeholder = { Text("Search by seller name or code", fontSize = 12.sp) },
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = OnDarkHigh),
            colors = deskFieldColors(),
        )
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            listOf("All", "Active", "Pending", "Suspended").forEach { filter ->
                Text(
                    text = filter,
                    color = if (statusFilter == filter) RCoinGreen else OnDarkMedium,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (statusFilter == filter) RCoinGreen.copy(alpha = 0.14f) else Color.Transparent)
                        .clickable { onStatusFilterChange(filter) }
                        .padding(horizontal = 9.dp, vertical = 6.dp),
                )
            }
        }
        Spacer(Modifier.height(7.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Showing ${filteredSellers.size} of ${sellers.size} sellers", color = OnDarkMedium, fontSize = 10.sp, modifier = Modifier.weight(1f))
            TextButton(onClick = { onExport(filteredSellers) }, enabled = filteredSellers.isNotEmpty()) {
                Text("Export CSV")
            }
        }
        if (filteredSellers.isEmpty()) {
            Text("No sellers match this search or status filter.", color = OnDarkMedium, fontSize = 12.sp)
        } else {
            filteredSellers.forEach { seller ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .clickable { onOpen(seller.id) }
                        .padding(vertical = 4.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = seller.displayName.ifBlank { seller.code },
                            color = OnDarkHigh,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f),
                        )
                        Pill(seller.statusLabel, accountColor(seller.status))
                    }
                    Text(
                        text = "${seller.code} · ${count(seller.recharge.orders)} orders · " +
                            "${count(seller.recharge.credited)} credited · ${count(seller.recharge.processedDiamonds)} diamonds",
                        color = OnDarkMedium,
                        fontSize = 11.sp,
                    )
                    Text("Tap to read this seller's book", color = VioletLight, fontSize = 10.sp)
                }
                Spacer(Modifier.height(6.dp))
            }
        }
        Text(
            "Only sellers assigned to your BD account are shown. Search and filters do not expand your access.",
            color = OnDarkMedium.copy(alpha = 0.75f),
            fontSize = 10.sp,
        )
    }
}

/** One seller's whole book, as the BD that owns it reads it. */
@Composable
private fun SellerReportView(
    loading: Boolean,
    error: String?,
    report: SellerReport?,
    onClose: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        VoizaSecondaryButton(text = "Back to your sellers", onClick = onClose, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(10.dp))
        when {
            loading -> LoadingProgress(overlay = false)
            error != null -> Text(error, color = DangerRed, fontSize = 12.sp)
            report != null -> LazyColumn(
                contentPadding = PaddingValues(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                item { AccountCard(report.seller) }
                item {
                    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
                        DeskSectionLabel("This seller's numbers")
                        FigureRow("Orders", count(report.recharge.orders), OnDarkHigh)
                        FigureRow("Credited", count(report.recharge.credited), RCoinGreen)
                        FigureRow("In review", count(report.recharge.awaitingVerification), WarningAmber)
                        FigureRow("Diamonds processed", count(report.recharge.processedDiamonds), OnDarkHigh)
                        FigureRow("Cash collected (net)", money(report.recharge.netCollectedMinor, report.commission.currency), RCoinGreen)
                        Spacer(Modifier.height(8.dp))
                        FigureRow("Commission accrued", money(report.commission.accruedMinor, report.commission.currency), RCoinGreen)
                        FigureRow("Commission settled", money(report.commission.settledMinor, report.commission.currency), Cyan)
                    }
                }
                item { EntriesCard(report.entries, null) }
                item { SettlementsCard(report.settlements, null) }
                item {
                    OrdersCard(
                        orders = report.orders,
                        total = report.orders.size,
                        error = null,
                        isSeller = false,
                        query = "",
                        onQueryChange = {},
                        statusFilter = "All",
                        onStatusFilterChange = {},
                        onMarkPaid = {},
                        onCancel = {},
                        onAttachProof = {},
                        onExport = {},
                    )
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Statement: commission lines, the batches that claimed them, and the seller's cash book.
// ---------------------------------------------------------------------------

@Composable
private fun StatementSection(statement: PartnerStatement?, error: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (error != null) {
            VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
                Text(error, color = DangerRed, fontSize = 11.sp)
            }
            return@Column
        }
        if (statement == null) {
            LoadingProgress(overlay = false)
            return@Column
        }
        statement.cash?.let { CashBookCard(it) }
        EntriesCard(statement.entries, statement.totalEntries)
        SettlementsCard(statement.settlements, null)
    }
}

/**
 * The cash a seller holds for the platform, and the R-coins bought back from members. The two halves
 * are shown apart and never summed: the cash handed to a member was agreed outside the platform, and
 * the book does not price it.
 */
@Composable
private fun CashBookCard(cash: SellerCashBook) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        DeskSectionLabel("Cash you hold for the platform")
        FigureRow("Collected on credited orders (net)", money(cash.collectedNetMinor, cash.currency), RCoinGreen)
        if (cash.refundedMinor > 0) FigureRow("Handed back on reversals", money(cash.refundedMinor, cash.currency), DangerRed)
        FigureRow("Commission kept out of collections", money(cash.commissionSettledMinor, cash.currency), Cyan)
        FigureRow("Still to hand over", money(cash.remittanceMinor, cash.currency), WarningAmber)
        FigureRow("Hand-over less accrued commission", money(cash.afterAccruedMinor, cash.currency), OnDarkHigh)
        Spacer(Modifier.height(8.dp))
        DeskSectionLabel("R-coins bought back from members")
        FigureRow("Paid out, net", coins(cash.cashOutNetRCoins), RCoinGreen)
        if (cash.cashOutFeeRCoins > 0) FigureRow("Fees", coins(cash.cashOutFeeRCoins), OnDarkMedium)
        FigureRow("Sales completed", count(cash.cashOutCount), OnDarkHigh)
        if (cash.awaitingCashOutRCoins > 0) {
            FigureRow("Awaiting your payment", coins(cash.awaitingCashOutRCoins), WarningAmber)
        }
        cash.cashOut.forEach { row ->
            Text(
                text = "${row.reference} · ${row.username} · ${coins(row.netRCoins)} · paid ${shortDate(row.paidAt)}",
                color = OnDarkMedium.copy(alpha = 0.85f),
                fontSize = 10.sp,
            )
        }
    }
}

@Composable
private fun EntriesCard(entries: List<CommissionEntry>, total: Int?) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        DeskSectionLabel(
            when {
                total != null && total > 0 -> "Commission lines · $total"
                entries.isNotEmpty() -> "Commission lines · ${entries.size}"
                else -> "Commission lines"
            },
        )
        if (entries.isEmpty()) {
            Text("Nothing has been counted yet. Commission follows credited orders.", color = OnDarkMedium, fontSize = 12.sp)
            return@VoizaCard
        }
        entries.forEach { entry ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = entry.orderReference.ifBlank { "Commission" },
                    color = OnDarkHigh,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Pill(entry.statusLabel, entryColor(entry.status))
            }
            Text(
                text = "${entryKindLabel(entry.kind)} · ${money(entry.amountMinor, entry.currency)} · ${shortDate(entry.createdAt)}",
                color = OnDarkMedium,
                fontSize = 11.sp,
            )
            entry.settlementReference?.let {
                Text("In batch $it", color = VioletLight, fontSize = 10.sp)
            }
            entry.reversalReason?.takeIf { it.isNotBlank() }?.let {
                Text("Reversed: $it", color = DangerRed, fontSize = 10.sp)
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun SettlementsCard(settlements: List<CommissionSettlement>, error: String?) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        DeskSectionLabel("Payout batches")
        if (error != null) {
            Text(error, color = DangerRed, fontSize = 11.sp)
            return@VoizaCard
        }
        if (settlements.isEmpty()) {
            Text("No batch has claimed this commission yet.", color = OnDarkMedium, fontSize = 12.sp)
            return@VoizaCard
        }
        settlements.forEach { batch ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = batch.reference,
                    color = OnDarkHigh,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Pill(batch.statusLabel, settlementColor(batch.status))
            }
            Text(
                text = "${money(batch.amountMinor, batch.currency)} · ${batch.entryCount} lines · " +
                    "${shortDate(batch.periodFrom)} to ${shortDate(batch.periodTo)}",
                color = OnDarkMedium,
                fontSize = 11.sp,
            )
            batch.paidAt?.let { Text("Paid ${shortDate(it)}", color = RCoinGreen, fontSize = 10.sp) }
            Spacer(Modifier.height(8.dp))
        }
    }
}

// ---------------------------------------------------------------------------
// The seller's three dialogs. Each sends only what the server asked for; the price, the member and
// the decision all stay on the backend.
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CreateOrderDialog(
    state: PartnerDeskViewModel.PartnerDeskUiState,
    onDismiss: () -> Unit,
    onCheck: (String) -> Unit,
    onCreate: (phone: String, packageKey: String, paymentMethod: String, note: String?) -> Unit,
) {
    var phone by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var packageKey by remember { mutableStateOf<String?>(null) }
    var rail by remember { mutableStateOf<String?>(null) }

    val packages = state.packages
    val chosenPackage = packageKey ?: packages.firstOrNull()?.key
    val chosenRail = rail ?: state.paymentRails.firstOrNull()
    val error = state.actionEvent?.takeIf { !it.success }?.message

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = VoizaSurfaceHigh,
        shape = RoundedCornerShape(22.dp),
        title = { Text("New recharge order", color = OnDarkHigh, fontWeight = FontWeight.Bold) },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier
                    .heightIn(max = 480.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                OutlinedTextField(
                    value = phone,
                    onValueChange = { phone = it.take(24) },
                    label = { Text("Member's phone number", fontSize = 13.sp) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    colors = deskFieldColors(),
                )
                VoizaSecondaryButton(
                    text = if (state.lookupBusy) "Checking…" else "Check member",
                    onClick = { onCheck(phone) },
                    enabled = phone.isNotBlank() && !state.lookupBusy,
                    modifier = Modifier.fillMaxWidth(),
                )
                state.lookup?.let { customer ->
                    Text(
                        text = "${customer.username} · ${customer.status} · ${customer.recentOrders.size} recent order(s)",
                        color = RCoinGreen,
                        fontSize = 11.sp,
                    )
                }
                state.lookupError?.let { Text(it, color = DangerRed, fontSize = 11.sp) }

                Text("Package", color = OnDarkHigh, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                if (packages.isEmpty()) {
                    Text("The price list has not loaded yet.", color = OnDarkMedium, fontSize = 11.sp)
                }
                packages.forEach { pkg ->
                    SelectableRow(
                        title = pkg.label.ifBlank { "${count(pkg.diamonds)} diamonds" },
                        subtitle = "${count(pkg.diamonds)} diamonds · ${money(pkg.amountMinor, pkg.currency)}",
                        selected = chosenPackage == pkg.key,
                        onClick = { packageKey = pkg.key },
                    )
                }

                Text("How the member pays you", color = OnDarkHigh, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                state.paymentRails.forEach { option ->
                    SelectableRow(
                        title = railLabel(option),
                        subtitle = null,
                        selected = chosenRail == option,
                        onClick = { rail = option },
                    )
                }

                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it.take(200) },
                    label = { Text("Note (optional)", fontSize = 13.sp) },
                    minLines = 2,
                    colors = deskFieldColors(),
                )
                error?.let { Text(it, color = DangerRed, fontSize = 11.sp) }
                Text(
                    text = "The price is the platform's own. Collect the money first, then mark the " +
                        "order paid and attach the proof — finance credits the diamonds after review.",
                    color = OnDarkMedium.copy(alpha = 0.75f),
                    fontSize = 10.sp,
                )
            }
        },
        confirmButton = {
            VoizaButton(
                text = if (state.actionBusy) "Opening…" else "Open order",
                onClick = {
                    val pkg = chosenPackage
                    val method = chosenRail
                    if (pkg != null && method != null) onCreate(phone, pkg, method, note)
                },
                enabled = !state.actionBusy && phone.isNotBlank() && chosenPackage != null && chosenRail != null,
                height = 44,
                modifier = Modifier.width(150.dp),
            )
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = OnDarkMedium) } },
    )
}

@Composable
private fun MarkPaidDialog(
    order: RechargeOrder,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var paymentRef by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = VoizaSurfaceHigh,
        shape = RoundedCornerShape(22.dp),
        title = { Text("Claim payment", color = OnDarkHigh, fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = "${order.reference} · ${order.username} · ${money(order.amountMinor, order.currency)}",
                    color = OnDarkMedium,
                    fontSize = 12.sp,
                )
                OutlinedTextField(
                    value = paymentRef,
                    onValueChange = { paymentRef = it.take(120) },
                    label = { Text("Payment reference / transaction ID", fontSize = 13.sp) },
                    singleLine = true,
                    colors = deskFieldColors(),
                )
                error?.let { Text(it, color = DangerRed, fontSize = 11.sp) }
                Text(
                    text = "This claims the money arrived; it does not credit anything. Finance reviews " +
                        "the claim and the proof before diamonds are issued.",
                    color = OnDarkMedium.copy(alpha = 0.75f),
                    fontSize = 10.sp,
                )
            }
        },
        confirmButton = {
            VoizaButton(
                text = if (busy) "Sending…" else "Claim paid",
                onClick = { onConfirm(paymentRef) },
                enabled = !busy && paymentRef.trim().length >= 4,
                height = 44,
                modifier = Modifier.width(150.dp),
            )
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = OnDarkMedium) } },
    )
}

@Composable
private fun CancelDialog(
    order: RechargeOrder,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var reason by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = VoizaSurfaceHigh,
        shape = RoundedCornerShape(22.dp),
        title = { Text("Cancel ${order.reference}?", color = OnDarkHigh, fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it.take(200) },
                    label = { Text("Why it is being cancelled", fontSize = 13.sp) },
                    minLines = 2,
                    colors = deskFieldColors(),
                )
                error?.let { Text(it, color = DangerRed, fontSize = 11.sp) }
            }
        },
        confirmButton = {
            VoizaButton(
                text = if (busy) "Cancelling…" else "Cancel order",
                onClick = { onConfirm(reason) },
                enabled = !busy && reason.trim().length >= 3,
                height = 44,
                modifier = Modifier.width(160.dp),
            )
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Keep it", color = OnDarkMedium) } },
    )
}

// ---------------------------------------------------------------------------
// Proof bytes. The picker hands over a content URI; the file is read once, capped at the server's
// own limits, and sent as base64 — the server sniffs the real format and refuses anything else.
// ---------------------------------------------------------------------------

private sealed class ReceiptRead {
    data class Ok(val fileName: String, val base64: String) : ReceiptRead()
    data class Failed(val message: String) : ReceiptRead()
}

private fun readReceipt(context: Context, uri: Uri): ReceiptRead {
    val resolver = context.contentResolver
    val mime = resolver.getType(uri).orEmpty().lowercase()
    val maxBytes = if (mime == "application/pdf") 8 * 1024 * 1024 else 5 * 1024 * 1024
    var displayName = "receipt"
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (index >= 0) cursor.getString(index)?.takeIf { it.isNotBlank() }?.let { displayName = it }
        }
    }
    val bytes = try {
        resolver.openInputStream(uri)?.use { it.readBytes() }
            ?: return ReceiptRead.Failed("That file could not be opened.")
    } catch (_: Exception) {
        return ReceiptRead.Failed("That file could not be read.")
    }
    if (bytes.isEmpty()) return ReceiptRead.Failed("That file is empty.")
    if (bytes.size > maxBytes) {
        return ReceiptRead.Failed(
            "That file is ${bytes.size / 1024 / 1024} MB; a receipt is up to ${maxBytes / 1024 / 1024} MB.",
        )
    }
    return ReceiptRead.Ok(
        fileName = displayName.take(120),
        base64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
    )
}

// ---------------------------------------------------------------------------
// Small pieces, local to this screen the way the agency desk keeps its own.
// ---------------------------------------------------------------------------

@Composable
private fun DeskHeader(title: String, subtitle: String, onBack: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = OnDarkHigh, fontSize = 19.sp, fontWeight = FontWeight.Bold)
            Text(subtitle, color = OnDarkMedium, fontSize = 11.sp)
        }
    }
}

@Composable
private fun TabPill(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        text = label,
        color = if (selected) OnDarkHigh else OnDarkMedium,
        fontSize = 12.sp,
        fontWeight = if (selected) FontWeight.Bold else FontWeight.SemiBold,
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) Fuchsia.copy(alpha = 0.22f) else VoizaSurface)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 7.dp),
    )
}

@Composable
private fun SelectableRow(title: String, subtitle: String?, selected: Boolean, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) Violet.copy(alpha = 0.22f) else VoizaSurface)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Text(
            text = title,
            color = if (selected) VioletLight else OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
        subtitle?.let { Text(it, color = OnDarkMedium, fontSize = 10.sp) }
    }
}

@Composable
private fun SmallAction(label: String, color: Color, onClick: () -> Unit) {
    Text(
        text = label,
        color = color,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(color.copy(alpha = 0.12f))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp),
    )
}

@Composable
private fun DeskSectionLabel(text: String) {
    Text(
        text = text,
        color = OnDarkHigh,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(bottom = 6.dp),
    )
}

@Composable
private fun FigureRow(label: String, value: String, valueColor: Color) {
    Row(modifier = Modifier.padding(vertical = 2.dp)) {
        Text(label, color = OnDarkMedium, fontSize = 12.sp, modifier = Modifier.weight(1f))
        Text(value, color = valueColor, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.End)
    }
}

@Composable
private fun Pill(label: String, color: Color) {
    Text(
        text = label,
        color = color,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun deskFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Fuchsia,
    unfocusedBorderColor = VoizaOutline,
    focusedLabelColor = Fuchsia,
    unfocusedLabelColor = OnDarkMedium,
    cursorColor = Violet,
    focusedTextColor = OnDarkHigh,
    unfocusedTextColor = OnDarkHigh,
)

/** R-coins, the unit a sale negotiates in — the same glyph the wallet uses. */
private fun coins(value: Int): String = "${count(value)} ◉"

private fun count(value: Int): String = String.format("%,d", value)

/** Minor units of the book's currency, printed the way a payout reads: `PKR 1,234.56`. */
private fun money(minor: Int, currency: String): String {
    val whole = String.format("%,d", minor / 100)
    val fraction = (minor % 100).toString().padStart(2, '0')
    val code = currency.uppercase()
    return if (code.isBlank()) "$whole.$fraction" else "$code $whole.$fraction"
}

private fun shortDate(iso: String?): String = iso?.take(10) ?: "—"

/** The server's rail constant, said the way a member says it. */
private fun railLabel(wire: String): String = when (wire.uppercase()) {
    "CASH" -> "Cash"
    "BANK" -> "Bank transfer"
    "EASYPAISA" -> "Easypaisa"
    "JAZZCASH" -> "JazzCash"
    else -> wire
}

/** The commission rule's kind, said as what it pays rather than as its column value. */
private fun entryKindLabel(wire: String): String = when (wire.uppercase()) {
    "SELLER_PERCENT" -> "Seller share"
    "SELLER_FIXED" -> "Seller fee"
    "SELLER_TIER" -> "Seller tier"
    "BD_PERCENT" -> "BD share"
    "BD_FIXED" -> "BD fee"
    else -> wire
}

private fun accountColor(status: PartnerAccountStatus?): Color = when (status) {
    PartnerAccountStatus.ACTIVE -> RCoinGreen
    PartnerAccountStatus.PENDING -> WarningAmber
    PartnerAccountStatus.SUSPENDED, PartnerAccountStatus.CLOSED -> DangerRed
    null -> OnDarkMedium
}

private fun orderColor(status: RechargeOrderStatus?): Color = when (status) {
    RechargeOrderStatus.CREDITED -> RCoinGreen
    RechargeOrderStatus.AWAITING_PAYMENT -> WarningAmber
    RechargeOrderStatus.AWAITING_VERIFICATION -> Cyan
    RechargeOrderStatus.REJECTED, RechargeOrderStatus.REVERSED -> DangerRed
    RechargeOrderStatus.CANCELLED, RechargeOrderStatus.EXPIRED -> OnDarkMedium
    null -> OnDarkMedium
}

private fun payoutColor(status: SellerPayoutStatus?): Color = when (status) {
    SellerPayoutStatus.PAID -> RCoinGreen
    SellerPayoutStatus.APPROVED -> Cyan
    SellerPayoutStatus.PENDING -> WarningAmber
    SellerPayoutStatus.REJECTED -> DangerRed
    null -> OnDarkMedium
}

private fun entryColor(status: CommissionEntryStatus?): Color = when (status) {
    CommissionEntryStatus.SETTLED -> RCoinGreen
    CommissionEntryStatus.ACCRUED -> Cyan
    CommissionEntryStatus.REJECTED, CommissionEntryStatus.REVERSED -> DangerRed
    null -> OnDarkMedium
}

private fun settlementColor(status: CommissionSettlementStatus?): Color = when (status) {
    CommissionSettlementStatus.PAID -> RCoinGreen
    CommissionSettlementStatus.APPROVED -> Cyan
    CommissionSettlementStatus.DRAFT -> WarningAmber
    CommissionSettlementStatus.VOID -> DangerRed
    null -> OnDarkMedium
}

@Preview(showBackground = true)
@Composable
fun PartnerDeskScreenPreview() {
    PartnerDeskScreen(onBack = {})
}
