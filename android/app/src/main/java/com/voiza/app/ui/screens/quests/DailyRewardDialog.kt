package com.voiza.app.ui.screens.quests

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CardGiftcard
import androidx.compose.material.icons.filled.Celebration
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Diamond
import androidx.compose.material.icons.filled.Eco
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.LocalFlorist
import androidx.compose.material.icons.filled.Redeem
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Whatshot
import androidx.compose.material.icons.filled.WorkspacePremium
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.voiza.app.domain.model.CheckInState
import androidx.compose.ui.tooling.preview.Preview
import com.voiza.app.ui.components.VoizaButton
import com.voiza.app.ui.components.VoizaCard
import com.voiza.app.ui.theme.Cyan
import com.voiza.app.ui.theme.Fuchsia
import com.voiza.app.ui.theme.GiftPink
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VioletLight
import com.voiza.app.ui.theme.VoizaAccentGradient
import com.voiza.app.ui.theme.VoizaCtaGradient
import com.voiza.app.ui.theme.VoizaOutline
import com.voiza.app.ui.theme.VoizaSurface
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaSurfaceVariant
import com.voiza.app.ui.theme.WarningAmber
import java.time.Duration
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlinx.coroutines.delay

/**
 * The daily reward modal: a seven-day strip, a claim that reveals what the server paid, and a
 * countdown to the next day in the platform's reset timezone. Every number on it is the server's
 * check-in status — the reveal animates the answer, it never invents one.
 */

private val DAY_NAMES = listOf(
    "First Spark", "New Sprout", "Bright Bloom", "Silver Leaf", "Golden Branch", "Royal Flame", "Legend Wing",
)
private val DAY_ICONS: List<ImageVector> = listOf(
    Icons.Default.Eco,
    Icons.Default.LocalFlorist,
    Icons.Default.AutoAwesome,
    Icons.Default.WorkspacePremium,
    Icons.Default.Diamond,
    Icons.Default.Whatshot,
    Icons.Default.Celebration,
)
private val CONFETTI = listOf(Fuchsia, Cyan, WarningAmber, Mint, GiftPink)

private fun dayName(day: Int): String = DAY_NAMES[(day - 1).coerceIn(0, DAY_NAMES.lastIndex)]
private fun dayIcon(day: Int): ImageVector = DAY_ICONS[(day - 1).coerceIn(0, DAY_ICONS.lastIndex)]

@Composable
fun DailyRewardDialog(
    checkIn: CheckInState,
    resetTimezone: String,
    claiming: Boolean,
    onClaim: () -> Unit,
    onDismiss: () -> Unit,
) {
    val wasDoneAtOpen = remember { checkIn.done }
    var revealed by remember { mutableStateOf(checkIn.done) }
    LaunchedEffect(checkIn.done) { if (checkIn.done) revealed = true }

    val dayNumber = if (checkIn.done) checkIn.streakDay else checkIn.nextStreakDay
    val days = checkIn.maxStreakDays.coerceIn(1, 7)
    val todayIndex = (dayNumber - 1).coerceIn(0, days - 1)
    val streakShown = if (checkIn.streakDay > 0) checkIn.streakDay else checkIn.nextStreakDay

    val rewardScale by animateFloatAsState(
        targetValue = if (revealed) 1f else 0.5f,
        animationSpec = spring(dampingRatio = 0.55f, stiffness = 320f),
        label = "rewardScale",
    )
    val burst = remember { Animatable(0f) }
    LaunchedEffect(revealed) {
        if (revealed && !wasDoneAtOpen) burst.animateTo(1f, tween(1100, easing = LinearEasing))
    }

    var remaining by remember { mutableStateOf(Duration.ZERO) }
    LaunchedEffect(resetTimezone) {
        val zone = runCatching { ZoneId.of(resetTimezone) }.getOrDefault(ZoneId.systemDefault())
        while (true) {
            val now = ZonedDateTime.now(zone)
            remaining = Duration.between(now, now.toLocalDate().plusDays(1).atStartOfDay(zone))
            delay(30_000)
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Column(
                modifier = Modifier
                    .width(340.dp)
                    .clip(RoundedCornerShape(28.dp))
                    .background(Brush.verticalGradient(listOf(Color(0xFF2A1A5E), VoizaSurface)))
                    .border(BorderStroke(1.dp, VoizaOutline), RoundedCornerShape(28.dp))
                    .padding(20.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(34.dp)
                            .clip(RoundedCornerShape(11.dp))
                            .background(VoizaAccentGradient),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Default.CardGiftcard, contentDescription = null, tint = Color.White, modifier = Modifier.size(19.dp))
                    }
                    Spacer(Modifier.width(10.dp))
                    Text("Daily Reward", color = OnDarkHigh, fontSize = 19.sp, fontWeight = FontWeight.Black)
                    Spacer(Modifier.weight(1f))
                    IconButton(onClick = onDismiss, modifier = Modifier.size(30.dp)) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = OnDarkMedium, modifier = Modifier.size(18.dp))
                    }
                }

                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "Day $dayNumber · ${dayName(dayNumber)}",
                        color = VioletLight,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.weight(1f))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .clip(RoundedCornerShape(50))
                            .background(Color(0x33FFC246))
                            .padding(horizontal = 9.dp, vertical = 4.dp),
                    ) {
                        Icon(Icons.Default.Whatshot, contentDescription = null, tint = WarningAmber, modifier = Modifier.size(13.dp))
                        Spacer(Modifier.width(3.dp))
                        Text("Streak ×$streakShown", color = WarningAmber, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }

                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp), modifier = Modifier.fillMaxWidth()) {
                    repeat(days) { index ->
                        val day = index + 1
                        val claimed = day <= checkIn.litDays
                        val isToday = index == todayIndex
                        val xp = checkIn.baseXp + (day.coerceAtMost(checkIn.maxStreakDays) - 1) * checkIn.streakStepXp
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(12.dp))
                                .background(if (isToday) VoizaSurfaceVariant else Color(0x66151233))
                                .then(
                                    if (isToday) Modifier.border(BorderStroke(1.5.dp, VoizaAccentGradient), RoundedCornerShape(12.dp))
                                    else Modifier,
                                )
                                .padding(vertical = 8.dp),
                        ) {
                            Text(
                                text = "D$day",
                                color = if (isToday) OnDarkHigh else OnDarkMuted,
                                fontSize = 9.sp,
                                fontWeight = FontWeight.Bold,
                            )
                            Spacer(Modifier.height(4.dp))
                            Box(contentAlignment = Alignment.Center) {
                                Icon(
                                    dayIcon(day),
                                    contentDescription = null,
                                    tint = when {
                                        claimed -> Mint
                                        isToday -> GiftPink
                                        else -> OnDarkMuted
                                    },
                                    modifier = Modifier.size(18.dp),
                                )
                                if (claimed) {
                                    Box(
                                        modifier = Modifier
                                            .align(Alignment.TopEnd)
                                            .size(11.dp)
                                            .clip(CircleShape)
                                            .background(Mint),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Icon(Icons.Default.Check, contentDescription = null, tint = Color(0xFF0B0A1F), modifier = Modifier.size(8.dp))
                                    }
                                }
                            }
                            Spacer(Modifier.height(4.dp))
                            Text(
                                text = "+$xp",
                                color = if (claimed) Mint else OnDarkMuted,
                                fontSize = 8.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }

                Spacer(Modifier.height(16.dp))
                Box(modifier = Modifier.fillMaxWidth().height(150.dp), contentAlignment = Alignment.Center) {
                    if (burst.value > 0f && burst.value < 1f) {
                        androidx.compose.foundation.Canvas(modifier = Modifier.fillMaxSize()) {
                            val progress = burst.value
                            repeat(16) { i ->
                                val angle = (i * 2 * Math.PI / 16) + (i % 3) * 0.21
                                val distance = (34 + (i % 4) * 16).dp.toPx() * progress
                                val x = center.x + (Math.cos(angle) * distance).toFloat()
                                val y = center.y + (Math.sin(angle) * distance).toFloat()
                                drawCircle(
                                    color = CONFETTI[i % CONFETTI.size].copy(alpha = 1f - progress),
                                    radius = (3.5f - 2f * progress).dp.toPx(),
                                    center = androidx.compose.ui.geometry.Offset(x, y),
                                )
                            }
                        }
                    }
                    if (!revealed) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(
                                modifier = Modifier
                                    .size(96.dp)
                                    .clip(RoundedCornerShape(24.dp))
                                    .background(VoizaSurfaceHigh)
                                    .border(BorderStroke(2.dp, VoizaAccentGradient), RoundedCornerShape(24.dp)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(Icons.Default.Redeem, contentDescription = null, tint = GiftPink, modifier = Modifier.size(52.dp))
                                Icon(
                                    Icons.Default.AutoAwesome,
                                    contentDescription = null,
                                    tint = WarningAmber,
                                    modifier = Modifier.align(Alignment.TopEnd).padding(6.dp).size(16.dp),
                                )
                            }
                            Spacer(Modifier.height(10.dp))
                            Text("Tap claim to reveal your reward", color = OnDarkMedium, fontSize = 12.sp)
                        }
                    } else {
                        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.scale(rewardScale)) {
                            Icon(
                                dayIcon(dayNumber),
                                contentDescription = null,
                                tint = WarningAmber,
                                modifier = Modifier.size(58.dp),
                            )
                            Spacer(Modifier.height(8.dp))
                            Text("Congratulations!", color = OnDarkHigh, fontSize = 18.sp, fontWeight = FontWeight.Black)
                            Spacer(Modifier.height(2.dp))
                            Text(
                                text = "Day $dayNumber streak claimed · ${dayName(dayNumber)}",
                                color = OnDarkMedium,
                                fontSize = 12.sp,
                            )
                            Spacer(Modifier.height(8.dp))
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(50))
                                    .background(Color(0x2634E5B4))
                                    .padding(horizontal = 14.dp, vertical = 6.dp),
                            ) {
                                Text(
                                    text = "+${checkIn.xpAwardedToday} XP",
                                    color = Mint,
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.Black,
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(14.dp))
                if (checkIn.available && !revealed) {
                    VoizaButton(
                        text = if (claiming) "Claiming…" else "Claim Reward",
                        onClick = onClaim,
                        enabled = !claiming,
                        height = 48,
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.Schedule, contentDescription = null, tint = Cyan, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(5.dp))
                            Text(
                                text = "Next reward in: ${remaining.toHours()}h ${remaining.toMinutes() % 60}m",
                                color = OnDarkHigh,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = "Come back tomorrow to keep your streak alive.",
                            color = OnDarkMuted,
                            fontSize = 10.sp,
                        )
                    }
                }
            }
        }
    }
}

/** Slim gradient entry card on the quests screen; the modal itself holds the claim. */
@Composable
fun DailyRewardEntry(checkIn: CheckInState, onOpen: () -> Unit) {
    val dayNumber = if (checkIn.done) checkIn.streakDay else checkIn.nextStreakDay
    VoizaCard(backgroundColor = VoizaSurfaceHigh, modifier = Modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .clickable(onClick = onOpen)
                .background(Brush.horizontalGradient(listOf(Color(0x33E040FB), Color(0x3322D3EE))))
                .padding(10.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(13.dp))
                    .background(VoizaCtaGradient),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.CardGiftcard, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text("Daily Reward", color = OnDarkHigh, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Text(
                    text = if (checkIn.done) {
                        "Day $dayNumber claimed · +${checkIn.xpAwardedToday} XP · next tomorrow"
                    } else {
                        "Day $dayNumber · ${dayName(dayNumber)} · +${checkIn.nextRewardXp} XP waiting"
                    },
                    color = if (checkIn.done) Mint else OnDarkMedium,
                    fontSize = 11.sp,
                )
            }
            if (checkIn.available) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(GiftPink),
                )
                Spacer(Modifier.width(6.dp))
            }
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = "Open daily reward",
                tint = OnDarkMedium,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
fun DailyRewardDialogPreview() {
    DailyRewardDialog(checkIn = CheckInState(available = true, done = false, streakDay = 3, xpAwardedToday = 0, nextRewardXp = 50, nextStreakDay = 4, baseXp = 10, streakStepXp = 5, maxStreakDays = 7), resetTimezone = "UTC", claiming = false, onClaim = {}, onDismiss = {})
}
