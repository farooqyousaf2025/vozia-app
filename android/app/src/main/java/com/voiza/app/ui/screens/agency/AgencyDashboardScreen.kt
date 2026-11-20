package com.voiza.app.ui.screens.agency

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.AgencyAccount
import com.voiza.app.domain.model.AgencyHostRow
import com.voiza.app.domain.model.AgencyPosition
import com.voiza.app.domain.model.AgencySettlementRow
import com.voiza.app.domain.model.AgencySettlementStatus
import com.voiza.app.domain.model.AgencyStatus
import com.voiza.app.domain.model.AgencySubRow
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.RCoinGreen
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.ui.theme.WarningAmber
import com.voiza.app.viewmodel.AgencyBookViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * The agency desk, from the agency's side of it.
 *
 * Everything on this screen is the platform's own arithmetic, read back: what the roster's gifts
 * accrued, how much of it belongs to a master, what is owed and what a batch has already claimed.
 * There is nothing to edit here on purpose. A rate is agreed by an operator who holds
 * `commission:manage`, and a payout batch is raised by finance against accruals the gift path wrote —
 * so the honest copy for a member who wants one is that this is where they read what they are owed,
 * not where they take it.
 *
 * A master and a sub read the same book from opposite ends: the sub sees the share leave, the master
 * sees the same coins arrive, and neither figure is a second commission.
 */
@Composable
fun AgencyDashboardScreen(
    onBack: () -> Unit,
    viewModel: AgencyBookViewModel = viewModel(
        factory = voizaViewModelFactory { AgencyBookViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // A rate or an accrual can change while the member is elsewhere in the app.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.load() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 20.dp, vertical = 16.dp),
    ) {
        AgencyHeader(
            title = state.position?.name ?: "Agency",
            subtitle = state.position?.let { "${it.kindLabel} · ${it.commissionLabel}" }
                ?: "What your roster earned, and what the platform owes it.",
            onBack = onBack,
        )
        Spacer(Modifier.height(10.dp))

        val position = state.position
        if (position == null) {
            if (state.loading) {
                LoadingProgress(overlay = false)
                return@Column
            }
            // The server's own refusal, shown as written: nobody who does not run an agency is told a
            // different story depending on which of the four routes they happened to reach first.
            Text(
                text = state.error ?: "This account does not run an agency.",
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

        var hostQuery by remember(position.id) { mutableStateOf("") }
        var hostStatusFilter by remember(position.id) { mutableStateOf("All") }

        LazyColumn(
            contentPadding = PaddingValues(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            item { PositionCard(position) }
            item { OwedCard(position.account) }
            item { AgencyActiveRoomsCard(state.activeRooms, state.roomsError) }
            if (position.isMaster) {
                item { AllocationCard(state.subAgencies, state.allocationError, position.subAgencyCount) }
            }
            item {
                RosterCard(
                    hosts = state.hosts,
                    error = state.rosterError,
                    query = hostQuery,
                    onQueryChange = { hostQuery = it },
                    statusFilter = hostStatusFilter,
                    onStatusFilterChange = { hostStatusFilter = it },
                )
            }
            item { BatchesCard(state.settlements, state.batchesError) }
        }
    }
}

// ---------------------------------------------------------------------------
// The position: who this agency is, and where its share of the money went.
// ---------------------------------------------------------------------------

@Composable
private fun PositionCard(position: AgencyPosition) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = position.kindLabel,
                color = OnDarkHigh,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            Pill(position.statusLabel, statusColor(position.status))
        }
        Text(
            text = position.master?.let { "Under ${it.name} · ${it.overrideLabel}" }
                ?: if (position.subAgencyCount > 0) {
                    "No master above you · ${countWords(position.subAgencyCount, "agency", "agencies")} report to you"
                } else {
                    "No master above you, and no agency reports to you"
                },
            color = OnDarkMedium,
            fontSize = 11.sp,
        )
        Spacer(Modifier.height(10.dp))
        FigureRow("Hosts", "${position.activeHostCount} of ${position.hostCount} active", OnDarkHigh)
        FigureRow("Commission counted", coins(position.earnings.accruedCoins), RCoinGreen)
        if (position.master != null) {
            FigureRow("Passed to your master", coins(position.earnings.overrideCoins), WarningAmber)
            FigureRow("You keep", coins(position.earnings.retainedCoins), RCoinGreen)
        }
        if (position.earnings.receivedOverrideCoins > 0) {
            FigureRow("Taken in from your agencies", coins(position.earnings.receivedOverrideCoins), RCoinGreen)
        }
        FigureRow(
            "Last 30 days",
            if (position.master == null) {
                coins(position.earnings.last30dCoins)
            } else {
                "${coins(position.earnings.last30dCoins)} · " +
                    "${coins(position.earnings.last30dOverrideCoins)} up"
            },
            OnDarkHigh,
        )
    }
}

/** What the platform owes, in the money a batch pays rather than the coins it was counted from. */
@Composable
private fun OwedCard(account: AgencyAccount?) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        SectionLabel("Owed to this agency")
        if (account == null) {
            Text(
                text = "No payout account is open yet. The first gift to one of your hosts opens it.",
                color = OnDarkMedium,
                fontSize = 12.sp,
            )
            return@VoizaCard
        }
        FigureRow("Available", money(account.availableMinor, account.currency), RCoinGreen)
        FigureRow("Claimed by open batches", money(account.pendingMinor, account.currency), WarningAmber)
        if (account.frozenMinor > 0) {
            FigureRow("Held while a dispute is open", money(account.frozenMinor, account.currency), DangerRed)
        }
        Spacer(Modifier.height(6.dp))
        Text(
            text = "A batch is raised by the platform's finance desk against what has accrued here. " +
                "This screen shows what has been claimed and paid; it cannot raise one.",
            color = OnDarkMedium.copy(alpha = 0.75f),
            fontSize = 10.sp,
        )
    }
}

/** A master's allocation table — the same coins the subs show as passed up. */
@Composable
private fun AllocationCard(subs: List<AgencySubRow>, error: String?, subAgencyCount: Int) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        SectionLabel(if (subAgencyCount > 0) "Agencies under you · $subAgencyCount" else "Agencies under you")
        if (error != null) {
            Text(error, color = DangerRed, fontSize = 11.sp)
            return@VoizaCard
        }
        if (subs.isEmpty()) {
            Text(
                text = "No agency reports to yours yet.",
                color = OnDarkMedium,
                fontSize = 12.sp,
            )
            return@VoizaCard
        }
        subs.forEach { sub ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = sub.name,
                    color = OnDarkHigh,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Pill(sub.statusLabel, statusColor(sub.status))
            }
            Text(sub.overrideLabel, color = OnDarkMedium, fontSize = 11.sp)
            Text(
                text = "${coins(sub.accruedCoins)} earned · ${coins(sub.overrideCoins)} to you · " +
                    "${coins(sub.retainedCoins)} kept",
                color = OnDarkMedium.copy(alpha = 0.85f),
                fontSize = 11.sp,
            )
            Spacer(Modifier.height(8.dp))
        }
    }
}

/**
 * The roster.
 *
 * Gifts are the performance the platform pays on, so that is what each row counts — over the whole
 * time the host has been here, and over the last thirty days. Hours watched per host are not in this
 * book yet: the room data behind a live-hours figure is still being built, and a column invented here
 * would be a number the agency could not settle against anything.
 */
@Composable
private fun RosterCard(
    hosts: List<AgencyHostRow>,
    error: String?,
    query: String,
    onQueryChange: (String) -> Unit,
    statusFilter: String,
    onStatusFilterChange: (String) -> Unit,
) {
    val filteredHosts = hosts.filter { host ->
        val matchesQuery = query.isBlank() || host.username.contains(query.trim(), ignoreCase = true)
        val matchesStatus = when (statusFilter) {
            "Active" -> host.status == AgencyStatus.ACTIVE
            "Pending" -> host.status == AgencyStatus.PENDING
            "Suspended" -> host.status == AgencyStatus.SUSPENDED
            else -> true
        }
        matchesQuery && matchesStatus
    }
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        SectionLabel("Your hosts · ${hosts.size}")
        if (hosts.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                HostCount("Active", hosts.count { it.status == AgencyStatus.ACTIVE }, RCoinGreen)
                HostCount("Pending", hosts.count { it.status == AgencyStatus.PENDING }, WarningAmber)
                HostCount("Suspended", hosts.count { it.status == AgencyStatus.SUSPENDED }, DangerRed)
            }
        }
        if (error != null) {
            Text(error, color = DangerRed, fontSize = 11.sp)
            return@VoizaCard
        }
        if (hosts.isEmpty()) {
            Text(
                text = "No host is on this roster yet.",
                color = OnDarkMedium,
                fontSize = 12.sp,
            )
        } else {
            OutlinedTextField(
                value = query,
                onValueChange = onQueryChange,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                placeholder = { Text("Search hosts by username", fontSize = 12.sp) },
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = OnDarkHigh),
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
            Text(
                text = "Showing ${filteredHosts.size} of ${hosts.size} hosts",
                color = OnDarkMedium,
                fontSize = 10.sp,
            )
            if (filteredHosts.isEmpty()) {
                Text("No hosts match this search or status filter.", color = OnDarkMedium, fontSize = 12.sp)
            } else {
                filteredHosts.forEach { host -> HostRow(host) }
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(
            text = "Commission follows the gifts each host received. Hours a host spent live are not " +
                "reported to agencies yet. Host assignment and financial controls remain with authorized operators.",
            color = OnDarkMedium.copy(alpha = 0.75f),
            fontSize = 10.sp,
        )
    }
}

@Composable
private fun HostRow(host: AgencyHostRow) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 5.dp)) {
        Avatar(url = host.avatarUrl, name = host.username, size = 32.dp)
        Spacer(Modifier.width(10.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = host.username,
                color = OnDarkHigh,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
            Text(
                text = "${host.commissionLabel} · since ${shortDate(host.joinedAt)}",
                color = OnDarkMedium.copy(alpha = 0.85f),
                fontSize = 10.sp,
            )
        }
        Spacer(Modifier.width(8.dp))
        Pill(host.status?.name ?: "Unknown", statusColor(host.status))
        Spacer(Modifier.width(8.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(coins(host.accruedCoins), color = RCoinGreen, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Text(
                text = "${coins(host.last30dCoins)} in 30 days",
                color = OnDarkMedium,
                fontSize = 10.sp,
                textAlign = TextAlign.End,
            )
        }
    }
}

/** The batches raised for this agency, in the money they pay. */
@Composable
private fun BatchesCard(rows: List<AgencySettlementRow>, error: String?) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        SectionLabel("Payout batches")
        if (error != null) {
            Text(error, color = DangerRed, fontSize = 11.sp)
            return@VoizaCard
        }
        if (rows.isEmpty()) {
            Text(
                text = "Nothing has been claimed against this agency yet.",
                color = OnDarkMedium,
                fontSize = 12.sp,
            )
            return@VoizaCard
        }
        rows.forEach { row ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = row.reference,
                    color = OnDarkHigh,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Pill(row.statusLabel, batchColor(row.status))
            }
            Text(
                text = "${money(row.amountMinor, row.currency)} · ${row.entryCount} accruals · " +
                    "${shortDate(row.periodFrom)} to ${shortDate(row.periodTo)}",
                color = OnDarkMedium,
                fontSize = 11.sp,
            )
            row.paidAt?.let {
                Text("Paid ${shortDate(it)}", color = RCoinGreen, fontSize = 10.sp)
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

// ---------------------------------------------------------------------------
// Small pieces, local to this screen the way the partner desk keeps its own.
// ---------------------------------------------------------------------------

@Composable
private fun AgencyHeader(title: String, subtitle: String, onBack: () -> Unit) {
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
private fun SectionLabel(text: String) {
    Text(
        text = text,
        color = OnDarkHigh,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(bottom = 6.dp),
    )
}

@Composable
private fun HostCount(label: String, count: Int, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(count.toString(), color = color, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        Text(label, color = OnDarkMedium, fontSize = 10.sp)
    }
}

@Composable
private fun FigureRow(label: String, value: String, valueColor: Color) {
    Row(modifier = Modifier.padding(vertical = 2.dp)) {
        Text(label, color = OnDarkMedium, fontSize = 12.sp, modifier = Modifier.weight(1f))
        Text(value, color = valueColor, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
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

/** R-coins, the unit an agency negotiates in — the same glyph the wallet uses. */
private fun coins(value: Int): String = "${String.format("%,d", value)} \u25C9"

/**
 * Minor units of the account's currency, as the money a batch actually moves.
 *
 * The journal's code arrives in lower case, so this prints it the way a payout reads — `PKR 1,234.56` —
 * and leaves the number unlabelled rather than naming a currency the server never gave it.
 */
private fun money(minor: Int, currency: String): String {
    val whole = String.format("%,d", minor / 100)
    val fraction = (minor % 100).toString().padStart(2, '0')
    val code = currency.uppercase()
    return if (code.isBlank()) "$whole.$fraction" else "$code $whole.$fraction"
}

/** `2026-11-09T18:59:12.4Z` reads as `2026-11-09`, the way the partner desk shows its dates. */
private fun shortDate(iso: String?): String = iso?.take(10) ?: "\u2014"

/** "1 agency" and "3 agencies" — a count followed by the word it actually agrees with. */
private fun countWords(count: Int, singular: String, plural: String): String =
    "$count ${if (count == 1) singular else plural}"

private fun statusColor(status: AgencyStatus?): Color = when (status) {
    AgencyStatus.ACTIVE -> RCoinGreen
    AgencyStatus.SUSPENDED -> DangerRed
    AgencyStatus.PENDING -> WarningAmber
    // A state this build does not know is drawn neutral and labelled with the server's own word.
    null -> OnDarkMedium
}

private fun batchColor(status: AgencySettlementStatus?): Color = when (status) {
    AgencySettlementStatus.PAID -> RCoinGreen
    AgencySettlementStatus.APPROVED -> Cyan
    AgencySettlementStatus.DRAFT -> WarningAmber
    AgencySettlementStatus.VOID -> DangerRed
    null -> OnDarkMedium
}


@Preview(showBackground = true)
@Composable
fun AgencyDashboardScreenPreview() {
    AgencyDashboardScreen(onBack = {})
}
