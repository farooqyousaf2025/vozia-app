package com.voiza.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voiza.app.ui.theme.DiamondGold
import com.voiza.app.ui.theme.OnDarkHigh

/**
 * Small diamond-balance pill. Tappable everywhere except inline usage.
 * The "diamond" is a unicode glyph to avoid shipping icon binaries.
 */
@Composable
fun DiamondChip(
    balance: Int?,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(50)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = modifier
            .background(
                color = Color(0xFF232C4E),
                shape = shape,
            )
            .then(
                if (onClick != null && enabled) {
                    Modifier.clickable { onClick() }
                } else {
                    Modifier
                }
            )
            .padding(horizontal = 10.dp, vertical = 5.dp),
    ) {
        Text(
            text = "\u2756", // ✖-like solid diamond glyph
            color = DiamondGold,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
        )
        Text(
            text = balance?.toString() ?: "--",
            color = OnDarkHigh,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/** Flame badge for room gift value, styled in the same pill family. */
@Composable
fun FlameBadge(
    value: Long,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(50)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        modifier = modifier
            .background(color = Color(0xFF38230F), shape = shape)
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Text(
            text = "\u2665",
            color = Color(0xFFFF6EC7),
            fontSize = 11.sp,
        )
        Text(
            text = if (value >= 1_000) "${value / 1000}k" else value.toString(),
            color = OnDarkHigh,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/** Listener count pill. */
@Composable
fun ListenerBadge(
    count: Int,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(50)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        modifier = modifier
            .background(color = Color(0x99000000), shape = shape)
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Text(
            text = "\u25B6",
            color = MaterialTheme.colorScheme.tertiary,
            fontSize = 9.sp,
        )
        Text(
            text = count.toString(),
            color = OnDarkHigh,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}
