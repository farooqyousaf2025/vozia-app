package com.voiza.app.ui.screens.agency

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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

@Composable
fun AgencyOwnerAnnouncementsCard(
    viewModel: AgencyAnnouncementsViewModel = viewModel(factory = voizaViewModelFactory { AgencyAnnouncementsViewModel() }),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) { viewModel.loadOwner() }
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Text("Host announcements", color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(value = state.title, onValueChange = viewModel::setTitle, modifier = Modifier.fillMaxWidth(),
            singleLine = true, label = { Text("Announcement title") })
        Spacer(Modifier.height(7.dp))
        OutlinedTextField(value = state.body, onValueChange = viewModel::setBody, modifier = Modifier.fillMaxWidth(),
            minLines = 3, maxLines = 6, label = { Text("Message for active hosts") })
        Spacer(Modifier.height(8.dp))
        VoizaButton(text = if (state.sending) "Publishing…" else "Publish announcement",
            onClick = viewModel::publish, enabled = !state.sending && !state.loading,
            modifier = Modifier.fillMaxWidth(), height = 42)
        state.notice?.let { Text(it, color = RCoinGreen, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp)) }
        state.error?.let { Text(it, color = DangerRed, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp)) }
        Spacer(Modifier.height(12.dp))
        Row { Text("Announcement history", color = OnDarkHigh, fontWeight = FontWeight.SemiBold, fontSize = 12.sp) }
        if (state.items.isEmpty() && !state.loading) Text("No announcements published yet.", color = OnDarkMedium, fontSize = 11.sp)
        state.items.forEach { item ->
            Column(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                Text(item.title, color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Text(item.body, color = OnDarkMedium, fontSize = 11.sp)
                Text("${item.readCount}/${item.recipientCount} hosts read · ${item.createdAt.take(10)}",
                    color = OnDarkMedium, fontSize = 10.sp)
            }
        }
    }
}

@Composable
fun HostAgencyAnnouncementsCard(
    viewModel: AgencyAnnouncementsViewModel = viewModel(factory = voizaViewModelFactory { AgencyAnnouncementsViewModel() }),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) { viewModel.loadHostInbox() }
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Text("Agency messages", color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
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
