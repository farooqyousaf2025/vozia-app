package com.voiza.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.VoizaAccentGradient

/**
 * Circular avatar with Coil network image + initials fallback, and an optional
 * gradient ring (host emphasis / speaking indicator).
 */
@Composable
fun Avatar(
    url: String?,
    name: String?,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    ringBrush: Brush? = null,
    ringWidth: Dp = 2.dp,
    fallbackBackground: Color = MaterialTheme.colorScheme.surfaceVariant,
) {
    val initial = name?.trim()?.firstOrNull()?.uppercaseChar()?.toString() ?: "?"
    val innerSize = if (ringBrush != null) size - ringWidth * 2 else size

    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier.size(size),
    ) {
        if (ringBrush != null) {
            Box(
                modifier = Modifier
                    .size(size)
                    .clip(CircleShape)
                    .background(ringBrush),
            )
        }
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(innerSize)
                .clip(CircleShape)
                .background(fallbackBackground),
        ) {
            if (!url.isNullOrBlank()) {
                AsyncImage(
                    model = url.asAssetUrl(),
                    contentDescription = name?.let { "$it avatar" } ?: "avatar",
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .size(innerSize)
                        .clip(CircleShape),
                )
            } else {
                Text(
                    text = initial,
                    color = OnDarkHigh,
                    fontSize = (innerSize.value * 0.42f).sp,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
    }
}

/** Gradient ring preset reused by seats + speaking indicator. */
val SpeakingRingBrush: Brush = VoizaAccentGradient
