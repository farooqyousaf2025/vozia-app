package com.voiza.app.ui.screens.quests

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.voiza.app.domain.model.CheckInState
import com.voiza.app.domain.model.DailyQuest
import com.voiza.app.domain.model.QuestsToday
import com.voiza.app.ui.components.EmptyState
import com.voiza.app.ui.components.LoadingProgress
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.components.VoizaSecondaryButton
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaAccentGradient
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaSurfaceVariant
import com.voiza.app.ui.theme.WarningAmber
import com.voiza.app.viewmodel.QuestsViewModel
import com.voiza.app.viewmodel.voizaViewModelFactory

/**
 * Daily quests and the check-in.
 *
 * Everything shown here is the server's answer: the day is a date in the platform's reset
 * timezone, progress counters were incremented when a gift posted or a chat row was stored, and
 * the streak comes from yesterday's check-in row. The screen can ask for today's status and claim
 * today's check-in; it cannot move a counter or an experience total.
 */
@Composable
fun QuestsScreen(
    onBack: () -> Unit,
    viewModel: QuestsViewModel = viewModel(
        factory = voizaViewModelFactory { QuestsViewModel() },
    ),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    // A gift sent in a room or midnight passing in the reset zone both change today's status while
    // this screen is off-screen, so it is re-read whenever it returns to the front.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.refresh() }

    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp),
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = OnDarkHigh)
            }
            Text("Daily quests", color = OnDarkHigh, fontSize = 19.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            IconButton(onClick = viewModel::load) {
                Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = OnDarkMedium)
            }
        }

        Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
            when {
                state.loading && state.snapshot == null -> LoadingProgress(overlay = true)

                // There is no account to check in for, so the screen asks for one instead of
                // showing an empty ladder.
                state.isGuest -> EmptyState(
                    icon = Icons.Default.DateRange,
                    title = "Log in to see today's quests",
                    subtitle = "Quests and the daily check-in belong to your account. " +
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
                    icon = Icons.Default.DateRange,
                    title = state.error ?: "Today's quests did not load",
                    subtitle = "Nothing here is cached \u2014 the day and every counter come from the server",
                    action = {
                        VoizaButton(
                            text = "Try again",
                            onClick = viewModel::load,
                            height = 44,
                            modifier = Modifier.width(160.dp),
                        )
                    },
                )

                else -> {
                    val snapshot = state.snapshot!!
                    LazyColumn(
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        item { SummaryCard(snapshot) }
                        snapshot.checkIn?.let { checkIn ->
                            item {
                                CheckInCard(
                                    checkIn = checkIn,
                                    claiming = state.claiming,
                                    onCheckIn = viewModel::checkIn,
                                )
                            }
                        }
                        item {
                            Text(
                                text = "Today's quests",
                                color = OnDarkMedium,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.padding(top = 6.dp, bottom = 2.dp),
                            )
                        }
                        if (snapshot.quests.isEmpty()) {
                            item {
                                EmptyState(
                                    icon = Icons.Default.Star,
                                    title = "No quests today",
                                    subtitle = "The operator has switched every quest off; check back later.",
                                )
                            }
                        } else {
                            items(snapshot.quests, key = { it.key }) { quest ->
                                QuestRow(quest)
                            }
                        }
                        item {
                            Text(
                                text = "The day rolls over at midnight in ${snapshot.resetTimezone}. " +
                                    "Progress comes from gifts and chats the server already recorded.",
                                color = OnDarkMuted,
                                fontSize = 10.sp,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                        }
                    }
                }
            }
        }

        state.message?.let { message ->
            QuestSnack(text = message, onConsumed = viewModel::consumeMessage)
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
}

/** "2 of 3 done · +50 XP today", plus the account's lifetime experience. */
@Composable
private fun SummaryCard(snapshot: QuestsToday) {
    VoizaCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column {
                Text(
                    text = "${snapshot.completedCount} of ${snapshot.quests.size} done",
                    color = OnDarkHigh,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    text = if (snapshot.allDone) {
                        "Every quest is finished \u2014 back tomorrow."
                    } else {
                        "${snapshot.quests.size - snapshot.completedCount} still open today"
                    },
                    color = OnDarkMedium,
                    fontSize = 11.sp,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = "+${snapshot.xpEarnedToday} XP",
                    color = WarningAmber,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Black,
                )
                Text("earned today", color = OnDarkMuted, fontSize = 10.sp)
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(
            text = "Day of ${snapshot.date}",
            color = OnDarkMuted,
            fontSize = 10.sp,
        )
    }
}

/**
 * The check-in. The lit dots are the streak the server computed, not a count this screen keeps;
 * after a claim the whole status is replaced with the server's copy.
 */
@Composable
private fun CheckInCard(
    checkIn: CheckInState,
    claiming: Boolean,
    onCheckIn: () -> Unit,
) {
    VoizaCard(backgroundColor = VoizaSurfaceHigh, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Daily check-in", color = OnDarkHigh, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Text(
                    text = if (checkIn.done) {
                        "Checked in today \u00B7 +${checkIn.xpAwardedToday} XP"
                    } else if (checkIn.streakDay > 0) {
                        "Day ${checkIn.nextStreakDay} of your streak \u00B7 +${checkIn.nextRewardXp} XP"
                    } else {
                        "Start a streak \u00B7 +${checkIn.nextRewardXp} XP"
                    },
                    color = if (checkIn.done) Mint else OnDarkMedium,
                    fontSize = 11.sp,
                )
            }
            StreakPill(streakDay = checkIn.litDays, cap = checkIn.maxStreakDays)
        }

        if (checkIn.maxStreakDays > 0) {
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                repeat(checkIn.maxStreakDays) { index ->
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(5.dp)
                            .clip(RoundedCornerShape(50))
                            .background(
                                if (index < checkIn.litDays) VoizaAccentGradient
                                else Brush.horizontalGradient(listOf(VoizaSurfaceVariant, VoizaSurfaceVariant)),
                            ),
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(
                text = "Each day in a row adds +${checkIn.streakStepXp} XP, up to day ${checkIn.maxStreakDays}. " +
                    "A missed day starts again at day 1.",
                color = OnDarkMuted,
                fontSize = 10.sp,
            )
        }

        Spacer(Modifier.height(10.dp))
        if (checkIn.available) {
            VoizaButton(
                text = if (claiming) "Checking in\u2026" else "Check in \u00B7 +${checkIn.nextRewardXp} XP",
                onClick = onCheckIn,
                enabled = !claiming,
                height = 46,
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            VoizaSecondaryButton(
                text = "Already checked in today",
                onClick = {},
                enabled = false,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun StreakPill(streakDay: Int, cap: Int) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(Color(0x33FFC246))
            .padding(horizontal = 10.dp, vertical = 5.dp),
    ) {
        Text(
            text = if (cap > 0) "Day $streakDay / $cap" else "Day $streakDay",
            color = WarningAmber,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

/** One quest: what to do, how far along, and what finishing it paid or will pay. */
@Composable
private fun QuestRow(quest: DailyQuest) {
    VoizaCard(backgroundColor = VoizaSurfaceHigh, modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (quest.completed) {
                        Icon(
                            Icons.Default.CheckCircle,
                            contentDescription = null,
                            tint = Mint,
                            modifier = Modifier.size(15.dp),
                        )
                        Spacer(Modifier.width(5.dp))
                    }
                    Text(
                        text = quest.title,
                        color = OnDarkHigh,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (quest.description.isNotBlank()) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = quest.description,
                        color = OnDarkMedium,
                        fontSize = 11.sp,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Spacer(Modifier.width(10.dp))
            XpPill(quest)
        }

        Spacer(Modifier.height(9.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(6.dp)
                .clip(RoundedCornerShape(50))
                .background(VoizaSurfaceVariant),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(quest.fraction)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(50))
                    .background(if (quest.completed) Brush.horizontalGradient(listOf(Mint, Cyan)) else VoizaAccentGradient),
            )
        }
        Spacer(Modifier.height(5.dp))
        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
            Text(
                text = quest.metricLabel() + " \u00B7 " + quest.progressLabel,
                color = OnDarkMuted,
                fontSize = 10.sp,
            )
            if (!quest.completed) {
                Text(
                    text = "${quest.remaining} to go",
                    color = OnDarkMuted,
                    fontSize = 10.sp,
                )
            }
        }
    }
}

/**
 * A completed quest shows what it actually paid ([DailyQuest.xpAwarded]), not its current reward:
 * an operator can re-price a quest after somebody finished it.
 */
@Composable
private fun XpPill(quest: DailyQuest) {
    val xp = if (quest.completed) quest.xpAwarded else quest.xpReward
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(if (quest.completed) Color(0x2634E5B4) else Color(0x26FFC246))
            .padding(horizontal = 9.dp, vertical = 4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Default.Star,
                contentDescription = null,
                tint = if (quest.completed) Mint else WarningAmber,
                modifier = Modifier.size(11.dp),
            )
            Spacer(Modifier.width(3.dp))
            Text(
                text = "+$xp",
                color = if (quest.completed) Mint else WarningAmber,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

private fun DailyQuest.metricLabel(): String = when (metric) {
    "GIFT_SENT" -> "Gifts sent"
    "DIAMONDS_SPENT" -> "Diamonds spent"
    "CHAT_MESSAGE" -> "Chat messages"
    else -> "Progress"
}

/** One-shot confirmation snack; clears itself after 2.5 s. */
@Composable
private fun QuestSnack(text: String, onConsumed: () -> Unit) {
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
