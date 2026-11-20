package com.voiza.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.ui.theme.DangerRed
import com.voiza.app.ui.theme.Mint
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaCardBorder
import com.voiza.app.ui.theme.VoizaGoldGradient
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import com.voiza.app.ui.theme.VoizaSurfaceVariant
import com.voiza.app.ui.theme.WarningAmber

// ---------------------------------------------------------------------------
// Small status surfaces shared across screens: VIP, level, live, connection
// and section headers. One place so a badge never drifts between screens.
// ---------------------------------------------------------------------------

/** Champagne-gold VIP pill. Only for a member the server says is VIP. */
@Composable
fun VipBadge(level: Int, modifier: Modifier = Modifier) {
    if (level <= 0) return
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(VoizaGoldGradient)
            .padding(horizontal = 7.dp, vertical = 2.dp),
    ) {
        Text(
            text = "VIP",
            color = Color(0xFF1A140A),
            fontSize = 9.sp,
            fontWeight = FontWeight.Black,
            letterSpacing = 0.5.sp,
        )
        if (level > 1) {
            Text(
                text = "$level",
                color = Color(0xFF1A140A),
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

/** Level chip: purple outline with the server's rung number. */
@Composable
fun LevelBadge(level: Int, modifier: Modifier = Modifier) {
    if (level <= 0) return
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(VoizaSurfaceVariant)
            .border(1.dp, VoizaCardBorder, RoundedCornerShape(50))
            .padding(horizontal = 7.dp, vertical = 2.dp),
    ) {
        Text(
            text = "Lv.$level",
            color = OnDarkHigh,
            fontSize = 9.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

/** Live dot + label. Green when live/connected, amber when degraded, red when down. */
@Composable
fun StatusPill(
    label: String,
    tone: StatusTone,
    modifier: Modifier = Modifier,
    dot: Boolean = true,
) {
    val color = when (tone) {
        StatusTone.LIVE -> Mint
        StatusTone.WARN -> WarningAmber
        StatusTone.ERROR -> DangerRed
        StatusTone.NEUTRAL -> OnDarkMuted
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        if (dot) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .clip(RoundedCornerShape(50))
                    .background(color),
            )
        }
        Text(text = label, color = color, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
}

enum class StatusTone { LIVE, WARN, ERROR, NEUTRAL }

/** Section heading with an optional trailing action, used by every list screen. */
@Composable
fun SectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    icon: ImageVector? = null,
    iconTint: Color = Color.Unspecified,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        if (icon != null) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (iconTint == Color.Unspecified) OnDarkHigh else iconTint,
                modifier = Modifier.size(16.dp),
            )
            androidx.compose.foundation.layout.Spacer(Modifier.size(7.dp))
        }
        Text(
            text = title,
            color = OnDarkHigh,
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
        )
        androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
        if (actionLabel != null && onAction != null) {
            Text(
                text = actionLabel,
                color = OnDarkMuted,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(VoizaSurfaceHigh)
                    .padding(horizontal = 10.dp, vertical = 4.dp)
                    .clickable(onClick = onAction),
            )
        }
    }
}
