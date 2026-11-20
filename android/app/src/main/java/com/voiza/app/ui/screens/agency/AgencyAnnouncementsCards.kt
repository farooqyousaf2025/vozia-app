package com.voiza.app.ui.screens.agency

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.RCoinGreen
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.viewmodel.AgencyAnnouncementsViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory
import kotlinx.coroutines.delay

@Composable
fun AgencyOwnerAnnouncementsCard(
    viewModel: AgencyAnnouncementsViewModel = viewModel(factory = voizaViewModelFactory { AgencyAnnouncementsViewModel() }),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) { viewModel.loadOwner() }
    androidx.compose.runtime.LaunchedEffect(viewModel) {
        while (true) {
            delay(30_000)
            viewModel.loadOwner(silent = true)
        }
    }
    var search by remember { mutableStateOf("") }
    var dateFilter by remember { mutableStateOf("All") }
    val pendingReads = state.items.sumOf { (it.recipientCount - it.readCount).coerceAtLeast(0) }
    val totalRecipients = state.items.sumOf { it.recipientCount.coerceAtLeast(0) }
    val totalReads = state.items.sumOf { it.readCount.coerceAtLeast(0) }
    val filteredItems = state.items.filter { item ->
        val matchesSearch = search.isBlank() ||
            item.title.contains(search.trim(), ignoreCase = true) ||
            item.body.contains(search.trim(), ignoreCase = true)
        val matchesDate = when (dateFilter) {
            "7 days" -> runCatching {
                !java.time.LocalDate.parse(item.createdAt.take(10)).isBefore(java.time.LocalDate.now().minusDays(7))
            }.getOrDefault(false)
            "30 days" -> runCatching {
                !java.time.LocalDate.parse(item.createdAt.take(10)).isBefore(java.time.LocalDate.now().minusDays(30))
            }.getOrDefault(false)
            else -> true
        }
        matchesSearch && matchesDate
    }
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Agency Communication Center", color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Text("Announcements for your currently assigned active hosts", color = OnDarkMedium, fontSize = 10.sp)
            }
            if (pendingReads > 0) Text("$pendingReads pending reads", color = RCoinGreen, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            SummaryMetric("Announcements", state.items.size.toString(), Modifier.weight(1f))
            SummaryMetric("Read receipts", "$totalReads / $totalRecipients", Modifier.weight(1f))
            SummaryMetric("Pending reads", pendingReads.toString(), Modifier.weight(1f))
        }
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = state.title, onValueChange = viewModel::setTitle, modifier = Modifier.fillMaxWidth(),
            singleLine = true, label = { Text("Announcement title") },
        )
        Spacer(Modifier.height(7.dp))
        OutlinedTextField(
            value = state.body, onValueChange = viewModel::setBody, modifier = Modifier.fillMaxWidth(),
            minLines = 3, maxLines = 6, label = { Text("Message for active hosts") },
        )
        Spacer(Modifier.height(8.dp))
        VoizaButton(
            text = if (state.sending) "Publishing…" else "Publish announcement",
            onClick = viewModel::publish, enabled = !state.sending && !state.loading,
            modifier = Modifier.fillMaxWidth(), height = 42,
        )
        state.notice?.let { Text(it, color = RCoinGreen, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp)) }
        state.error?.let { Text(it, color = DangerRed, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp)) }
        Spacer(Modifier.height(14.dp))
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text("Announcement history", color = OnDarkHigh, fontWeight = FontWeight.SemiBold, fontSize = 12.sp,
                modifier = Modifier.weight(1f))
            TextButton(onClick = { viewModel.loadOwner(silent = true) }, enabled = !state.loading) { Text("Refresh") }
        }
        OutlinedTextField(
            value = search, onValueChange = { search = it }, modifier = Modifier.fillMaxWidth(),
            singleLine = true, label = { Text("Search title or message") },
        )
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("All", "7 days", "30 days").forEach { filter ->
                Text(
                    text = filter,
                    color = if (dateFilter == filter) RCoinGreen else OnDarkMedium,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp))
                        .background(if (dateFilter == filter) RCoinGreen.copy(alpha = 0.14f) else Color.Transparent)
                        .clickable { dateFilter = filter }
                        .padding(horizontal = 10.dp, vertical = 7.dp),
                )
            }
        }
        Spacer(Modifier.height(5.dp))
        Text("Showing ${filteredItems.size} of ${state.items.size} returned announcements",
            color = OnDarkMedium, fontSize = 10.sp)
        if (state.items.isEmpty() && !state.loading) {
            Text("No announcements published yet.", color = OnDarkMedium, fontSize = 11.sp)
        } else if (filteredItems.isEmpty()) {
            Text("No announcements match this search or date filter.", color = OnDarkMedium, fontSize = 11.sp)
        }
        filteredItems.forEach { item ->
            Column(modifier = Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
                Text(item.title, color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Text(item.body, color = OnDarkMedium, fontSize = 11.sp)
                Text(
                    "${item.readCount.coerceAtLeast(0)}/${item.recipientCount.coerceAtLeast(0)} hosts read · ${item.createdAt.take(10)}",
                    color = OnDarkMedium, fontSize = 10.sp,
                )
            }
        }
        Text(
            "Read counts and totals reflect the announcements returned by the existing agency API. No financial or role controls are available here.",
            color = OnDarkMedium.copy(alpha = 0.75f), fontSize = 10.sp,
        )
    }
}

@Composable
private fun SummaryMetric(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier.clip(RoundedCornerShape(9.dp)).background(Color(0xFF242438)).padding(8.dp)) {
        Text(value, color = OnDarkHigh, fontSize = 13.sp, fontWeight = FontWeight.Bold)
        Text(label, color = OnDarkMedium, fontSize = 9.sp)
    }
}

@Composable
fun HostAgencyAnnouncementsCard(
    viewModel: AgencyAnnouncementsViewModel = viewModel(factory = voizaViewModelFactory { AgencyAnnouncementsViewModel() }),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) { viewModel.loadHostInbox() }
    androidx.compose.runtime.LaunchedEffect(viewModel) {
        while (true) {
            delay(30_000)
            viewModel.loadHostInbox(silent = true)
        }
    }
    val unreadCount = state.items.count { !it.isRead }
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Agency messages", color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            if (unreadCount > 0) Text("$unreadCount new", color = RCoinGreen, fontSize = 10.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(6.dp))
        if (state.items.isEmpty() && !state.loading) Text("No agency announcements.", color = OnDarkMedium, fontSize = 11.sp)
        state.items.forEach { item ->
            Column(modifier = Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text(item.title, color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f))
                    Text(if (item.isRead) "Read" else "New", color = if (item.isRead) OnDarkMedium else RCoinGreen, fontSize = 10.sp)
                }
                Text(item.agencyName, color = OnDarkMedium, fontSize = 10.sp)
                Text(item.body, color = OnDarkHigh, fontSize = 11.sp)
                Text(item.createdAt.take(10), color = OnDarkMedium, fontSize = 10.sp)
                if (!item.isRead) Text("Mark as read", color = RCoinGreen, fontSize = 11.sp,
                    modifier = Modifier.clickable { viewModel.markRead(item.id) }.padding(top = 4.dp))
            }
        }
        state.error?.let { Text(it, color = DangerRed, fontSize = 11.sp) }
    }
}
