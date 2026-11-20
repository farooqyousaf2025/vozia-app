package com.voiza.app.ui.screens.agency

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.AgencyAccount
import com.voiza.app.domain.model.AgencyHostAttendanceReport
import com.voiza.app.data.export.toAttendanceCsv
import com.voiza.app.data.export.toRosterCsv
import com.voiza.app.domain.model.AgencyHostRow
import com.voiza.app.domain.model.AgencyHostGoals
import com.voiza.app.domain.model.AgencyHostRecognition
import com.voiza.app.domain.model.AgencyHostLeaderboard
import com.voiza.app.domain.model.AgencyPosition
import com.voiza.app.domain.model.AgencySettlementRow
import com.voiza.app.domain.model.AgencyRoomModerationAudit
import com.voiza.app.domain.model.AgencySettlementStatus
import com.voiza.app.domain.model.AgencyStatus
import com.voiza.app.domain.model.AgencySubRow
import com.voiza.app.ui.screens.agency.AgencyOwnerAnnouncementsCard
import com.voiza.app.ui.components.Avatar
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.Mint
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
    val context = LocalContext.current
    var pendingAttendanceExport by remember { mutableStateOf<AgencyHostAttendanceReport?>(null) }
    var pendingRosterExport by remember { mutableStateOf<List<AgencyHostRow>?>(null) }
    val attendanceExportLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("text/csv"),
    ) { uri ->
        val report = pendingAttendanceExport
        if (uri != null && report != null) {
            val saved = runCatching {
                context.contentResolver.openOutputStream(uri)?.bufferedWriter(Charsets.UTF_8)?.use {
                    it.write(report.toAttendanceCsv())
                } ?: error("Could not open the selected file.")
            }.isSuccess
            Toast.makeText(
                context,
                if (saved) "Attendance CSV saved." else "Could not save attendance CSV.",
                Toast.LENGTH_LONG,
            ).show()
        }
        pendingAttendanceExport = null
    }

    val rosterExportLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("text/csv"),
    ) { uri ->
        val hosts = pendingRosterExport
        if (uri != null && hosts != null) {
            val saved = runCatching {
                context.contentResolver.openOutputStream(uri)?.bufferedWriter(Charsets.UTF_8)?.use {
                    it.write(hosts.toRosterCsv())
                } ?: error("Could not open the selected file.")
            }.isSuccess
            Toast.makeText(
                context,
                if (saved) "Host roster CSV saved." else "Could not save host roster CSV.",
                Toast.LENGTH_LONG,
            ).show()
        }
        pendingRosterExport = null
    }

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
        var hostSort by remember(position.id) { mutableStateOf("Username") }
        var selectedHostUsername by remember(position.id) { mutableStateOf<String?>(null) }

        LazyColumn(
            contentPadding = PaddingValues(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            item { PositionCard(position) }
            item { AgencyOwnerAnnouncementsCard() }
            item { AgencyPerformanceCard(position, state.hosts, state.activeRooms) }
            item {
                AgencyHostPerformanceComparisonCard(
                    hosts = state.hosts,
                    attendance = state.hostAttendance,
                    goals = state.hostGoals,
                    leaderboard = state.hostLeaderboard,
                )
            }
            item {
                AgencyHostActivityCard(
                    report = state.hostActivity,
                    selectedDays = state.activityDays,
                    loading = state.activityLoading,
                    error = state.activityError,
                    onDaysChange = viewModel::setActivityDays,
                    onRefresh = { viewModel.loadHostActivity() },
                )
            }
            item {
                AgencyHostAttendanceCard(
                    report = state.hostAttendance,
                    selectedDays = state.attendanceDays,
                    loading = state.attendanceLoading,
                    error = state.attendanceError,
                    onDaysChange = viewModel::setAttendanceDays,
                    onRefresh = { viewModel.loadHostAttendance() },
                    onExport = {
                        state.hostAttendance?.let { report ->
                            pendingAttendanceExport = report
                            attendanceExportLauncher.launch("vozia-host-attendance-${report.days}d.csv")
                        }
                    },
                )
            }
            item {
                AgencyHostLeaderboardCard(
                    leaderboard = state.hostLeaderboard,
                    selectedDays = state.leaderboardDays,
                    loading = state.leaderboardLoading,
                    error = state.leaderboardError,
                    onDaysChange = viewModel::setLeaderboardDays,
                    onRefresh = { viewModel.loadHostLeaderboard() },
                )
            }
            item {
                AgencyHostRecognitionCard(
                    recognition = state.hostRecognition,
                    loading = state.recognitionLoading,
                    error = state.recognitionError,
                    onRefresh = viewModel::loadHostRecognition,
                )
            }
            item {
                AgencyHostGoalsCard(
                    goals = state.hostGoals,
                    loading = state.goalsLoading,
                    saving = state.goalsSaving,
                    error = state.goalsError,
                    onSave = viewModel::saveHostGoals,
                    onRefresh = viewModel::loadHostGoals,
                )
            }
            item { OwedCard(position.account) }
            item {
                AgencyActiveRoomsCard(
                    rooms = state.activeRooms,
                    error = state.roomsError,
                    expandedRoomId = state.expandedRoomId,
                    members = state.roomMembers,
                    membersLoading = state.roomMembersLoading,
                    membersError = state.roomMembersError,
                    history = state.moderationHistory,
                    historyLoading = state.historyLoading,
                    historyError = state.historyError,
                    onRefreshHistory = viewModel::loadModerationHistory,
                    busyUserId = state.moderationBusyUserId,
                    onToggle = viewModel::toggleRoomMembers,
                    onMute = viewModel::muteRoomMember,
                    onKick = viewModel::kickRoomMember,
                    onBan = viewModel::banRoomMember,
                )
            }
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
                    sort = hostSort,
                    onSortChange = { hostSort = it },
                    selectedHostUsername = selectedHostUsername,
                    onHostSelected = { selectedHostUsername = it },
                    attendance = state.hostAttendance,
                    goals = state.hostGoals,
                    recognition = state.hostRecognition,
                    leaderboard = state.hostLeaderboard,
                    onExport = {
                        pendingRosterExport = state.hosts.toList()
                        rosterExportLauncher.launch("vozia-host-roster.csv")
                    },
                )
            }
            item { BatchesCard(state.settlements, state.batchesError) }
        }
    }
}

@Composable
private fun AgencyActiveRoomsCard(
    rooms: List<com.voiza.app.domain.model.AgencyLiveRoom>,
    error: String?,
    expandedRoomId: String?,
    members: List<com.voiza.app.domain.model.AgencyRoomMember>,
    membersLoading: Boolean,
    membersError: String?,
    history: List<AgencyRoomModerationAudit>,
    historyLoading: Boolean,
    historyError: String?,
    onRefreshHistory: (String) -> Unit,
    busyUserId: String?,
    onToggle: (String) -> Unit,
    onMute: (String, String, Boolean) -> Unit,
    onKick: (String, String) -> Unit,
    onBan: (String, String) -> Unit,
) {
    var pendingAction by remember { mutableStateOf<Pair<com.voiza.app.domain.model.AgencyRoomMember, String>?>(null) }
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        SectionLabel("Live rooms · ${rooms.size}")
        Text("Rooms owned by your currently assigned active hosts.", color = OnDarkMedium, fontSize = 11.sp)
        if (error != null) {
            Text(error, color = DangerRed, fontSize = 11.sp)
        } else if (rooms.isEmpty()) {
            Text("No assigned-host rooms are live right now.", color = OnDarkMedium, fontSize = 12.sp)
        } else {
            rooms.forEach { room ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(room.title.ifBlank { "Room ${room.roomNumber}" }, color = OnDarkHigh, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                        Text("Host @${room.hostUsername} · #${room.roomNumber}", color = OnDarkMedium, fontSize = 11.sp)
                    }
                    Pill("LIVE", Mint)
                    Spacer(Modifier.width(8.dp))
                    Text("${room.memberCount} members", color = OnDarkHigh, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                    TextButton(onClick = { onToggle(room.id) }) {
                        Text(if (expandedRoomId == room.id) "Hide" else "Manage")
                    }
                }
                if (expandedRoomId == room.id) {
                    when {
                        membersLoading -> Text("Loading room members…", color = OnDarkMedium, fontSize = 11.sp)
                        membersError != null -> Text(membersError, color = DangerRed, fontSize = 11.sp)
                        members.isEmpty() -> Text("No other members are currently in this room.", color = OnDarkMedium, fontSize = 11.sp)
                        else -> members.forEach { member ->
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(start = 8.dp, top = 5.dp, bottom = 5.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text("@${member.username}", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                                    Text(member.role.lowercase().replaceFirstChar { it.uppercase() }, color = OnDarkMedium, fontSize = 10.sp)
                                }
                                if (member.role.equals("SPEAKER", ignoreCase = true)) {
                                    TextButton(
                                        enabled = busyUserId != member.userId,
                                        onClick = { onMute(room.id, member.userId, !member.isMuted) },
                                    ) { Text(if (member.isMuted) "Unmute" else "Mute") }
                                }
                                TextButton(
                                    enabled = busyUserId != member.userId,
                                    onClick = { pendingAction = member to "kick" },
                                ) { Text("Kick", color = DangerRed) }
                                TextButton(
                                    enabled = busyUserId != member.userId,
                                    onClick = { pendingAction = member to "ban" },
                                ) { Text("Ban", color = DangerRed) }
                            }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Moderation history", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        TextButton(onClick = { onRefreshHistory(room.id) }) { Text("Refresh") }
                    }
                    when {
                        historyLoading -> Text("Loading audit records…", color = OnDarkMedium, fontSize = 11.sp)
                        historyError != null -> Text(historyError, color = DangerRed, fontSize = 11.sp)
                        history.isEmpty() -> Text("No moderation actions recorded for this room.", color = OnDarkMedium, fontSize = 11.sp)
                        else -> history.forEach { entry ->
                            Column(Modifier.fillMaxWidth().padding(start = 8.dp, top = 4.dp, bottom = 6.dp)) {
                                val actionLabel = when (entry.action.uppercase()) {
                                    "MUTE" -> "muted"
                                    "UNMUTE" -> "unmuted"
                                    "KICK" -> "kicked"
                                    "BAN" -> "banned"
                                    "UNBAN" -> "unbanned"
                                    else -> entry.action.lowercase()
                                }
                                Text(
                                    "@${entry.actorUsername} ${actionLabel} @${entry.targetUsername}",
                                    color = OnDarkHigh,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                val timestamp = entry.createdAt?.replace("T", " ")?.take(16) ?: "Time unavailable"
                                Text(timestamp, color = OnDarkMedium, fontSize = 10.sp)
                                if (!entry.reason.isNullOrBlank()) {
                                    Text("Reason: ${entry.reason}", color = OnDarkMedium, fontSize = 10.sp)
                                }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
        }
        Text(
            "Controls apply only to non-owner members in rooms of your currently assigned active hosts. Bans last 24 hours.",
            color = OnDarkMedium.copy(alpha = 0.75f),
            fontSize = 10.sp,
        )
    }
    pendingAction?.let { (member, action) ->
        AlertDialog(
            onDismissRequest = { pendingAction = null },
            title = { Text(if (action == "kick") "Remove member?" else "Ban for 24 hours?") },
            text = {
                Text(
                    if (action == "kick") "Remove @${member.username} from this room? They may rejoin unless separately banned."
                    else "Remove @${member.username} and prevent rejoining this room for 24 hours."
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val roomId = expandedRoomId
                    if (roomId != null) {
                        if (action == "kick") onKick(roomId, member.userId) else onBan(roomId, member.userId)
                    }
                    pendingAction = null
                }) { Text(if (action == "kick") "Remove" else "Ban", color = DangerRed) }
            },
            dismissButton = {
                TextButton(onClick = { pendingAction = null }) { Text("Cancel") }
            },
        )
    }
}

// ---------------------------------------------------------------------------
// The position: who this agency is, and where its share of the money went.
// ---------------------------------------------------------------------------

/**
 * Read-only metrics from the agency owner's existing scoped endpoints.
 * The server exposes a rolling 30-day commission contribution and a live room snapshot,
 * but no daily room-engagement history; the UI therefore does not invent a trend line.
 */
@Composable
private fun AgencyPerformanceCard(
    position: AgencyPosition,
    hosts: List<AgencyHostRow>,
    rooms: List<com.voiza.app.domain.model.AgencyLiveRoom>,
) {
    val liveAudience = rooms.sumOf { it.memberCount.coerceAtLeast(0) }
    val topHosts = hosts.filter { it.last30dCoins > 0 }.sortedByDescending { it.last30dCoins }.take(5)

    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        SectionLabel("Agency performance · 30 days")
        Text("A read-only view of your currently assigned host roster.", color = OnDarkMedium, fontSize = 11.sp)
        Spacer(Modifier.height(8.dp))
        FigureRow("Active hosts", "${position.activeHostCount} / ${position.hostCount}", Mint)
        FigureRow("Live rooms now", rooms.size.toString(), OnDarkHigh)
        FigureRow("Members in live rooms", liveAudience.toString(), Cyan)
        Spacer(Modifier.height(8.dp))
        Text("Top host contributions", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        if (topHosts.isEmpty()) {
            Text("No host commission contribution recorded in the last 30 days.", color = OnDarkMedium, fontSize = 11.sp)
        } else {
            topHosts.forEachIndexed { index, host ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("${index + 1}.", color = OnDarkMedium, fontSize = 11.sp, modifier = Modifier.width(24.dp))
                    Text(
                        "@${host.username}",
                        color = OnDarkHigh,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.weight(1f),
                    )
                    Text(coins(host.last30dCoins), color = RCoinGreen, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(
            "Host contribution is the existing 30-day agency commission accrual, shown for reference only. " +
                "Live audience is a current snapshot. Daily room-engagement history is not available in the existing API.",
            color = OnDarkMedium.copy(alpha = 0.75f),
            fontSize = 10.sp,
        )
    }
}

@Composable
private fun AgencyHostActivityCard(
    report: com.voiza.app.domain.model.AgencyHostActivityReport?,
    selectedDays: Int,
    loading: Boolean,
    error: String?,
    onDaysChange: (Int) -> Unit,
    onRefresh: () -> Unit,
) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Host activity report")
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onRefresh, enabled = !loading) { Text("Refresh") }
        }
        Text("Recorded room activity for your currently assigned active hosts.", color = OnDarkMedium, fontSize = 11.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
            listOf(7, 30).forEach { days ->
                TextButton(onClick = { onDaysChange(days) }, enabled = selectedDays != days || !loading) {
                    Text(if (selectedDays == days) "✓ $days days" else "$days days", color = if (selectedDays == days) Mint else OnDarkMedium)
                }
            }
        }
        if (loading && report == null) {
            Text("Loading host activity…", color = OnDarkMedium, fontSize = 12.sp)
        } else if (error != null && report == null) {
            Text(error, color = DangerRed, fontSize = 11.sp)
        } else if (report == null) {
            Text("No activity report is available.", color = OnDarkMedium, fontSize = 12.sp)
        } else {
            val totals = report.totals
            FigureRow("Rooms created", totals.roomsCreated.toString(), OnDarkHigh)
            FigureRow("Rooms with visitors", totals.roomsWithVisitors.toString(), Cyan)
            FigureRow("Member room visits", totals.memberVisits.toString(), Mint)
            FigureRow("Unique visitors", totals.uniqueVisitors.toString(), OnDarkHigh)
            Spacer(Modifier.height(10.dp))
            Text("Weekly activity · UTC", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            report.weekly.asReversed().forEach { week ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Week of ${week.weekStart}", color = OnDarkMedium, fontSize = 10.sp, modifier = Modifier.weight(1f))
                    Text("${week.roomsCreated} rooms · ${week.memberVisits} visits", color = OnDarkHigh, fontSize = 10.sp)
                }
            }
            Spacer(Modifier.height(8.dp))
            Text("Daily activity · UTC", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            report.daily.asReversed().forEach { day ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(day.date, color = OnDarkMedium, fontSize = 10.sp, modifier = Modifier.weight(1f))
                    Text("${day.roomsCreated} rooms · ${day.memberVisits} visits", color = OnDarkHigh, fontSize = 10.sp)
                }
            }
            Spacer(Modifier.height(10.dp))
            Text("Host comparison", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            val activeHosts = report.hosts.filter { it.roomsCreated > 0 || it.memberVisits > 0 }
            if (activeHosts.isEmpty()) {
                Text("No recorded room activity in this period.", color = OnDarkMedium, fontSize = 11.sp)
            } else {
                activeHosts.take(10).forEach { host ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("@${host.username}", color = OnDarkHigh, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                            Text("${host.roomsCreated} rooms · ${host.uniqueVisitors} unique visitors", color = OnDarkMedium, fontSize = 10.sp)
                        }
                        Text("${host.memberVisits} visits", color = Mint, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
            Text(
                "A visit is one recorded non-host entry into a room. This report does not estimate host online hours or session duration. Only hosts currently assigned to this agency are included; dates use UTC.",
                color = OnDarkMedium.copy(alpha = 0.75f),
                fontSize = 10.sp,
            )
        }
    }
}

@Composable
private fun AgencyHostAttendanceCard(
    report: com.voiza.app.domain.model.AgencyHostAttendanceReport?,
    selectedDays: Int,
    loading: Boolean,
    error: String?,
    onDaysChange: (Int) -> Unit,
    onRefresh: () -> Unit,
    onExport: () -> Unit,
) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Host attendance & check-ins")
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onExport, enabled = report != null && !loading) { Text("Export CSV") }
            TextButton(onClick = onRefresh, enabled = !loading) { Text("Refresh") }
        }
        Text("Verified host joins confirmed by LiveKit, for your currently assigned active hosts.", color = OnDarkMedium, fontSize = 11.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
            listOf(7, 30).forEach { days ->
                TextButton(onClick = { onDaysChange(days) }, enabled = selectedDays != days || !loading) {
                    Text(if (selectedDays == days) "✓ $days days" else "$days days", color = if (selectedDays == days) Mint else OnDarkMedium)
                }
            }
        }
        when {
            loading && report == null -> Text("Loading verified attendance…", color = OnDarkMedium, fontSize = 12.sp)
            error != null && report == null -> Text(error, color = DangerRed, fontSize = 11.sp)
            report == null -> Text("No attendance report is available.", color = OnDarkMedium, fontSize = 12.sp)
            else -> {
                val totals = report.totals
                FigureRow("Verified check-ins", totals.checkIns.toString(), Mint)
                FigureRow("Hosts checked in", totals.hostsCheckedIn.toString(), OnDarkHigh)
                FigureRow("Host attendance days", totals.hostAttendanceDays.toString(), Cyan)
                Spacer(Modifier.height(10.dp))
                Text("Daily check-ins · UTC", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "Bars compare each day with the busiest day in this selected period.",
                    color = OnDarkMedium.copy(alpha = 0.75f),
                    fontSize = 10.sp,
                )
                val maxDailyCheckIns = report.daily.maxOfOrNull { it.checkIns }?.coerceAtLeast(1) ?: 1
                report.daily.asReversed().forEach { day ->
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(day.date, color = OnDarkMedium, fontSize = 10.sp, modifier = Modifier.weight(1f))
                            Text(
                                "${day.hostsCheckedIn} hosts · ${day.checkIns} check-ins",
                                color = OnDarkHigh,
                                fontSize = 10.sp,
                            )
                        }
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(6.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color(0xFF303044)),
                        ) {
                            if (day.checkIns > 0) {
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth((day.checkIns.toFloat() / maxDailyCheckIns).coerceIn(0f, 1f))
                                        .height(6.dp)
                                        .background(Mint, RoundedCornerShape(8.dp)),
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text("Host attendance", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                val checkedInHosts = report.hosts
                    .filter { it.checkIns > 0 }
                    .sortedWith(
                        compareByDescending<com.voiza.app.domain.model.AgencyHostAttendanceRow> { it.checkIns }
                            .thenByDescending { it.attendanceDays }
                            .thenBy { it.username.lowercase() },
                    )
                var attendanceHostQuery by remember(report.days) { mutableStateOf("") }
                if (checkedInHosts.isEmpty()) {
                    Text("No verified host check-ins in this period.", color = OnDarkMedium, fontSize = 11.sp)
                } else {
                    OutlinedTextField(
                        value = attendanceHostQuery,
                        onValueChange = { attendanceHostQuery = it },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        placeholder = { Text("Search checked-in hosts", fontSize = 12.sp) },
                        textStyle = MaterialTheme.typography.bodyMedium.copy(color = OnDarkHigh),
                    )
                    val matchingHosts = checkedInHosts.filter {
                        attendanceHostQuery.isBlank() || it.username.contains(attendanceHostQuery.trim(), ignoreCase = true)
                    }
                    Text(
                        "Showing ${matchingHosts.size} of ${checkedInHosts.size} hosts · sorted by check-ins",
                        color = OnDarkMedium,
                        fontSize = 10.sp,
                    )
                    if (matchingHosts.isEmpty()) {
                        Text("No checked-in hosts match this search.", color = OnDarkMedium, fontSize = 11.sp)
                    } else {
                        matchingHosts.forEach { host ->
                            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text("@${host.username}", color = OnDarkHigh, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                                    Text("${host.checkIns} check-ins", color = Mint, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
                                }
                                val last = host.lastCheckInAt?.replace("T", " ")?.take(16) ?: "No check-in"
                                Text("${host.attendanceDays} attendance days · Last: $last UTC", color = OnDarkMedium, fontSize = 10.sp)
                            }
                        }
                    }
                }
            }
        }
        Text(
            "A check-in is recorded only when LiveKit confirms the host joined their room. This report does not claim working hours or estimate session duration. Only currently assigned active hosts are included; dates use UTC.",
            color = OnDarkMedium.copy(alpha = 0.75f),
            fontSize = 10.sp,
        )
    }
}

@Composable
private fun AgencyHostLeaderboardCard(
    leaderboard: AgencyHostLeaderboard?,
    selectedDays: Int,
    loading: Boolean,
    error: String?,
    onDaysChange: (Int) -> Unit,
    onRefresh: () -> Unit,
) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Agency host leaderboard")
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onRefresh, enabled = !loading) { Text("Refresh") }
        }
        Text(
            "Ranked by verified attendance days, then confirmed LiveKit check-ins. Earned badges use lifetime attendance.",
            color = OnDarkMedium, fontSize = 11.sp,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
            listOf(7, 30).forEach { days ->
                TextButton(onClick = { onDaysChange(days) }, enabled = selectedDays != days || !loading) {
                    Text(if (selectedDays == days) "✓ $days days" else "$days days", color = if (selectedDays == days) Mint else OnDarkMedium)
                }
            }
        }
        when {
            loading && leaderboard == null -> Text("Loading agency leaderboard…", color = OnDarkMedium, fontSize = 12.sp)
            error != null && leaderboard == null -> Text(error, color = DangerRed, fontSize = 11.sp)
            leaderboard == null -> Text("The host leaderboard is not available.", color = OnDarkMedium, fontSize = 12.sp)
            leaderboard.hosts.isEmpty() -> Text("No active hosts are currently assigned to this agency.", color = OnDarkMedium, fontSize = 11.sp)
            else -> {
                FigureRow("Active assigned hosts", leaderboard.activeHostCount.toString(), OnDarkHigh)
                FigureRow("Hosts with attendance", leaderboard.hostsWithAttendance.toString(), Mint)
                FigureRow("Verified check-ins · ${leaderboard.days} days", leaderboard.totalCheckIns.toString(), Cyan)
                FigureRow("Attendance days · ${leaderboard.days} days", leaderboard.totalAttendanceDays.toString(), OnDarkHigh)
                FigureRow("Hosts with earned badges", leaderboard.hostsWithBadges.toString(), WarningAmber)
                Spacer(Modifier.height(10.dp))
                leaderboard.hosts.take(20).forEach { host ->
                    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                if (host.rank == 1) "🏆 #1" else "#${host.rank}",
                                color = if (host.rank == 1) WarningAmber else Mint,
                                fontSize = 12.sp, fontWeight = FontWeight.Bold,
                            )
                            Spacer(Modifier.width(9.dp))
                            Text("@${host.username}", color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Text("${host.attendanceDays} days · ${host.checkIns} joins", color = OnDarkHigh, fontSize = 10.sp)
                        }
                        val last = host.lastCheckInAt?.replace("T", " ")?.take(16) ?: "No check-in in this period"
                        Text("Last verified check-in: $last ${if (host.lastCheckInAt != null) "UTC" else ""}", color = OnDarkMedium, fontSize = 9.sp, modifier = Modifier.padding(start = 36.dp, top = 2.dp))
                        if (host.badges.isNotEmpty()) {
                            Row(
                                modifier = Modifier.padding(start = 36.dp, top = 4.dp),
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                host.badges.forEach { badge ->
                                    Text("🏅 ${badge.title}", color = Mint, fontSize = 9.sp, fontWeight = FontWeight.Medium)
                                }
                            }
                        } else {
                            Text("No lifetime attendance badges earned yet", color = OnDarkMedium, fontSize = 9.sp, modifier = Modifier.padding(start = 36.dp, top = 3.dp))
                        }
                    }
                }
            }
        }
        if (error != null && leaderboard != null) Text(error, color = DangerRed, fontSize = 10.sp)
        Text(
            "This leaderboard is visible only to your agency owner account and includes only your currently assigned active hosts. Attendance is based on confirmed LiveKit joins; dates use UTC. Ties share the same rank.",
            color = OnDarkMedium.copy(alpha = 0.75f), fontSize = 10.sp,
        )
    }
}

@Composable
private fun AgencyHostRecognitionCard(
    recognition: AgencyHostRecognition?,
    loading: Boolean,
    error: String?,
    onRefresh: () -> Unit,
) {
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Host recognition & achievements")
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onRefresh, enabled = !loading) { Text("Refresh") }
        }
        Text(
            "Milestones are earned from distinct days with verified LiveKit host check-ins. Dates are shown in UTC.",
            color = OnDarkMedium, fontSize = 11.sp,
        )
        when {
            loading && recognition == null -> Text("Loading host achievements…", color = OnDarkMedium, fontSize = 12.sp)
            error != null && recognition == null -> Text(error, color = DangerRed, fontSize = 11.sp)
            recognition == null -> Text("Host recognition is not available.", color = OnDarkMedium, fontSize = 12.sp)
            recognition.hosts.isEmpty() -> Text("No active hosts are currently assigned to this agency.", color = OnDarkMedium, fontSize = 11.sp)
            else -> {
                FigureRow("Hosts with achievements", "${recognition.hostsWithAchievements} / ${recognition.activeHostCount}", Mint)
                Spacer(Modifier.height(8.dp))
                recognition.hosts.forEach { host ->
                    Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
                        Text(host.username, color = OnDarkHigh, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                        Text("${host.attendanceDays} verified attendance days", color = OnDarkMedium, fontSize = 10.sp)
                        host.milestones.forEach { milestone ->
                            val earned = milestone.unlockedAt != null
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(start = 8.dp, top = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(if (earned) "🏅" else "○", fontSize = 13.sp)
                                Spacer(Modifier.width(7.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(milestone.title, color = if (earned) Mint else OnDarkMedium, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                                    Text(
                                        if (earned) "${milestone.description} · ${milestone.unlockedAt} UTC"
                                        else "${milestone.attendanceDaysRequired} verified attendance days required",
                                        color = OnDarkMedium, fontSize = 9.sp,
                                    )
                                }
                                if (earned) Text("EARNED", color = Mint, fontSize = 8.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                    Spacer(Modifier.height(5.dp))
                }
            }
        }
        if (error != null && recognition != null) Text(error, color = DangerRed, fontSize = 10.sp)
        Text(
            "Recognition is informational only. No coins, bonuses, payouts, host-status changes or permissions are granted.",
            color = OnDarkMedium.copy(alpha = 0.75f), fontSize = 10.sp,
        )
    }
}

@Composable
private fun AgencyHostGoalsCard(
    goals: AgencyHostGoals?,
    loading: Boolean,
    saving: Boolean,
    error: String?,
    onSave: (Int) -> Unit,
    onRefresh: () -> Unit,
) {
    var targetDraft by remember(goals?.weeklyAttendanceTargetDays) {
        mutableStateOf(goals?.weeklyAttendanceTargetDays ?: 5)
    }
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Host goals & progress")
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onRefresh, enabled = !loading && !saving) { Text("Refresh") }
        }
        Text(
            "Set a shared weekly attendance goal for your active host roster. Progress uses verified check-ins from the last 7 UTC days.",
            color = OnDarkMedium, fontSize = 11.sp,
        )
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { targetDraft = (targetDraft - 1).coerceAtLeast(1) }, enabled = !saving && targetDraft > 1) {
                Text("−", color = OnDarkHigh, fontSize = 18.sp)
            }
            Text("${targetDraft} / 7 days", color = OnDarkHigh, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            TextButton(onClick = { targetDraft = (targetDraft + 1).coerceAtMost(7) }, enabled = !saving && targetDraft < 7) {
                Text("+", color = OnDarkHigh, fontSize = 18.sp)
            }
            Spacer(Modifier.weight(1f))
            TextButton(
                onClick = { onSave(targetDraft) },
                enabled = !saving && goals != null && targetDraft != goals.weeklyAttendanceTargetDays,
            ) { Text(if (saving) "Saving…" else "Save goal", color = Mint) }
        }
        when {
            loading && goals == null -> Text("Loading host goals…", color = OnDarkMedium, fontSize = 12.sp)
            error != null && goals == null -> Text(error, color = DangerRed, fontSize = 11.sp)
            goals == null -> Text("Host goals are not available.", color = OnDarkMedium, fontSize = 12.sp)
            else -> {
                FigureRow("Hosts meeting goal", "${goals.hostsMeetingGoal} / ${goals.activeHostCount}", Mint)
                Spacer(Modifier.height(8.dp))
                if (goals.hosts.isEmpty()) {
                    Text("No active hosts are currently assigned to this agency.", color = OnDarkMedium, fontSize = 11.sp)
                } else {
                    goals.hosts.forEach { host ->
                        Column(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("@${host.username}", color = OnDarkHigh, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                                Text(
                                    if (host.metTarget) "Goal met" else "${host.remainingDays} days to go",
                                    color = if (host.metTarget) Mint else WarningAmber,
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                            Box(
                                modifier = Modifier.fillMaxWidth().height(6.dp)
                                    .clip(RoundedCornerShape(8.dp)).background(Color(0xFF303044)),
                            ) {
                                Box(
                                    modifier = Modifier.fillMaxWidth((host.progressPercent / 100f).coerceIn(0f, 1f))
                                        .fillMaxSize().background(Mint),
                                )
                            }
                            Text(
                                "${host.attendanceDays} / ${host.targetDays} attendance days · ${host.progressPercent}%",
                                color = OnDarkMedium, fontSize = 10.sp,
                            )
                        }
                    }
                }
            }
        }
        if (error != null && goals != null) {
            Text(error, color = DangerRed, fontSize = 10.sp)
        }
        Text(
            "Targets are informational only. They do not change host status, commissions, bonuses or payouts. Only currently assigned active hosts are shown.",
            color = OnDarkMedium.copy(alpha = 0.75f), fontSize = 10.sp,
        )
    }
}

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
    sort: String,
    onSortChange: (String) -> Unit,
    selectedHostUsername: String?,
    onHostSelected: (String?) -> Unit,
    attendance: AgencyHostAttendanceReport?,
    goals: AgencyHostGoals?,
    recognition: AgencyHostRecognition?,
    leaderboard: AgencyHostLeaderboard?,
    onExport: () -> Unit,
) {
    val matchingHosts = hosts.filter { host ->
        val matchesQuery = query.isBlank() || host.username.contains(query.trim(), ignoreCase = true)
        val matchesStatus = when (statusFilter) {
            "Active" -> host.status == AgencyStatus.ACTIVE
            "Pending" -> host.status == AgencyStatus.PENDING
            "Suspended" -> host.status == AgencyStatus.SUSPENDED
            else -> true
        }
        matchesQuery && matchesStatus
    }
    val filteredHosts = when (sort) {
        "30-day coins" -> matchingHosts.sortedWith(compareByDescending<AgencyHostRow> { it.last30dCoins }.thenBy { it.username.lowercase() })
        "All-time coins" -> matchingHosts.sortedWith(compareByDescending<AgencyHostRow> { it.accruedCoins }.thenBy { it.username.lowercase() })
        else -> matchingHosts.sortedBy { it.username.lowercase() }
    }
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { SectionLabel("Your hosts · ${hosts.size}") }
            TextButton(onClick = onExport, enabled = hosts.isNotEmpty()) { Text("Export CSV") }
        }
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
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Sort", color = OnDarkMedium, fontSize = 10.sp)
                listOf("Username", "30-day coins", "All-time coins").forEach { option ->
                    Text(
                        text = option,
                        color = if (sort == option) RCoinGreen else OnDarkMedium,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (sort == option) RCoinGreen.copy(alpha = 0.14f) else Color.Transparent)
                            .clickable { onSortChange(option) }
                            .padding(horizontal = 8.dp, vertical = 6.dp),
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
                filteredHosts.forEach { host ->
                    HostRow(
                        host = host,
                        selected = selectedHostUsername.equals(host.username, ignoreCase = true),
                        onClick = {
                            onHostSelected(if (selectedHostUsername.equals(host.username, ignoreCase = true)) null else host.username)
                        },
                    )
                }
            }
            val selectedHost = hosts.firstOrNull { it.username.equals(selectedHostUsername, ignoreCase = true) }
            if (selectedHost != null) {
                HostProfileDetails(
                    host = selectedHost,
                    attendance = attendance,
                    goals = goals,
                    recognition = recognition,
                    leaderboard = leaderboard,
                    onClose = { onHostSelected(null) },
                )
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
private fun AgencyHostPerformanceComparisonCard(
    hosts: List<AgencyHostRow>,
    attendance: AgencyHostAttendanceReport?,
    goals: AgencyHostGoals?,
    leaderboard: AgencyHostLeaderboard?,
) {
    var metric by remember { mutableStateOf("30-day coins") }
    val attendanceByHost = attendance?.hosts.orEmpty().associateBy { it.username.lowercase() }
    val goalsByHost = goals?.hosts.orEmpty().associateBy { it.username.lowercase() }
    val ranked = hosts.filter { it.status == AgencyStatus.ACTIVE }.map { host ->
        val attendanceRow = attendanceByHost[host.username.lowercase()]
        val goalRow = goalsByHost[host.username.lowercase()]
        val value = when (metric) {
            "Check-ins" -> attendanceRow?.checkIns
            "Attendance days" -> attendanceRow?.attendanceDays
            "Goal progress" -> goalRow?.progressPercent
            "All-time coins" -> host.accruedCoins
            else -> host.last30dCoins
        }
        Triple(host, value, goalRow)
    }.sortedWith(
        compareByDescending<Triple<AgencyHostRow, Int?, com.voiza.app.domain.model.AgencyHostGoalRow?>> { it.second ?: -1 }
            .thenBy { it.first.username.lowercase() },
    )
    VoizaCard(backgroundColor = VoizaSurface, modifier = Modifier.fillMaxWidth()) {
        SectionLabel("Host performance comparison")
        Text(
            "Compare your currently assigned active hosts using existing verified attendance, goal and roster totals.",
            color = OnDarkMedium, fontSize = 11.sp,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp), modifier = Modifier.padding(vertical = 8.dp)) {
            listOf("30-day coins", "All-time coins", "Check-ins", "Attendance days", "Goal progress").forEach { option ->
                Text(
                    text = option,
                    color = if (metric == option) Mint else OnDarkMedium,
                    fontSize = 9.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (metric == option) Mint.copy(alpha = 0.14f) else Color.Transparent)
                        .clickable { metric = option }
                        .padding(horizontal = 7.dp, vertical = 6.dp),
                )
            }
        }
        if (ranked.isEmpty()) {
            Text("No active assigned hosts are available to compare.", color = OnDarkMedium, fontSize = 11.sp)
        } else {
            val maxValue = ranked.mapNotNull { it.second }.maxOrNull()?.coerceAtLeast(1) ?: 1
            ranked.forEachIndexed { index, row ->
                val (host, value, goal) = row
                Column(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("#${index + 1}", color = if (index == 0) WarningAmber else Mint, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.width(8.dp))
                        Text("@${host.username}", color = OnDarkHigh, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        Text(
                            value?.let { if (metric.contains("coins")) coins(it) else if (metric == "Goal progress") "$it%" else it.toString() }
                                ?: "Not available",
                            color = OnDarkHigh, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                        )
                    }
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(start = 28.dp, top = 4.dp)
                            .height(5.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFF303044)),
                    ) {
                        if (value != null && value > 0) {
                            Box(
                                modifier = Modifier.fillMaxWidth((value.toFloat() / maxValue).coerceIn(0f, 1f))
                                    .height(5.dp).background(Mint, RoundedCornerShape(8.dp)),
                            )
                        }
                    }
                    if (metric != "Goal progress" && goal != null) {
                        Text(
                            "Weekly goal: ${goal.attendanceDays}/${goal.targetDays} days",
                            color = OnDarkMedium, fontSize = 9.sp, modifier = Modifier.padding(start = 28.dp, top = 2.dp),
                        )
                    }
                }
            }
        }
        Text(
            "Ranks use only the selected metric; ties are ordered by username. Missing report values are shown as unavailable, not treated as zero. Coins are existing accrued totals, not payouts.",
            color = OnDarkMedium.copy(alpha = 0.75f), fontSize = 9.sp,
        )
    }
}

@Composable
private fun HostRow(host: AgencyHostRow, selected: Boolean, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) RCoinGreen.copy(alpha = 0.08f) else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 7.dp),
    ) {
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


@Composable
private fun HostProfileDetails(
    host: AgencyHostRow,
    attendance: AgencyHostAttendanceReport?,
    goals: AgencyHostGoals?,
    recognition: AgencyHostRecognition?,
    leaderboard: AgencyHostLeaderboard?,
    onClose: () -> Unit,
) {
    val attendanceRow = attendance?.hosts?.firstOrNull { it.username.equals(host.username, ignoreCase = true) }
    val goalRow = goals?.hosts?.firstOrNull { it.username.equals(host.username, ignoreCase = true) }
    val recognitionRow = recognition?.hosts?.firstOrNull { it.username.equals(host.username, ignoreCase = true) }
    val leaderboardRow = leaderboard?.hosts?.firstOrNull { it.username.equals(host.username, ignoreCase = true) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(RCoinGreen.copy(alpha = 0.06f))
            .padding(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Host profile")
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onClose) { Text("Close") }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(url = host.avatarUrl, name = host.username, size = 42.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("@${host.username}", color = OnDarkHigh, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Text("${host.statusLabel} · joined ${shortDate(host.joinedAt)}", color = OnDarkMedium, fontSize = 10.sp)
                Text(host.commissionLabel, color = OnDarkMedium, fontSize = 10.sp)
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            ProfileMetric("All-time coins", coins(host.accruedCoins), Modifier.weight(1f))
            ProfileMetric("Last 30 days", coins(host.last30dCoins), Modifier.weight(1f))
        }
        Spacer(Modifier.height(8.dp))
        SectionLabel("Verified attendance · ${attendance?.days ?: 7} days")
        if (attendance == null) {
            Text("Attendance report is not available yet. Refresh the attendance report to load it.", color = OnDarkMedium, fontSize = 11.sp)
        } else if (attendanceRow == null) {
            Text("No host attendance row is available in this report window.", color = OnDarkMedium, fontSize = 11.sp)
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                ProfileMetric("Check-ins", attendanceRow.checkIns.toString(), Modifier.weight(1f))
                ProfileMetric("Attendance days", attendanceRow.attendanceDays.toString(), Modifier.weight(1f))
            }
            Text(
                "Last verified check-in: ${attendanceRow.lastCheckInAt?.let(::shortDate) ?: "None in this window"} (UTC)",
                color = OnDarkMedium,
                fontSize = 10.sp,
            )
        }
        goalRow?.let { goal ->
            Spacer(Modifier.height(8.dp))
            Text(
                "Weekly goal: ${goal.attendanceDays}/${goal.targetDays} days · ${goal.progressPercent}%${if (goal.metTarget) " · Met" else " · ${goal.remainingDays} to go"}",
                color = if (goal.metTarget) Mint else OnDarkHigh,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
        leaderboardRow?.let { rank ->
            Text("${leaderboard?.days ?: 7}-day leaderboard: #${rank.rank} · ${rank.checkIns} check-ins", color = OnDarkMedium, fontSize = 10.sp)
        }
        val earned = recognitionRow?.milestones?.filter { it.unlockedAt != null }.orEmpty()
        if (earned.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text("Earned milestones", color = OnDarkHigh, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            earned.forEach { milestone ->
                Text("• ${milestone.title} · ${shortDate(milestone.unlockedAt)}", color = Mint, fontSize = 10.sp)
            }
        }
        Text(
            "Details use the existing agency-scoped roster and verified attendance summaries. No private account identifiers or unverified live hours are shown.",
            color = OnDarkMedium.copy(alpha = 0.75f),
            fontSize = 9.sp,
        )
    }
}

@Composable
private fun ProfileMetric(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier) {
        Text(label, color = OnDarkMedium, fontSize = 9.sp)
        Text(value, color = OnDarkHigh, fontSize = 13.sp, fontWeight = FontWeight.Bold)
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
