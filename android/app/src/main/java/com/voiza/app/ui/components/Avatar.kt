package com.voiza.app.ui.components

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.voiza.app.domain.model.ProfileFrame
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.VoizaAccentGradient
import com.voiza.app.ui.theme.WarningAmber

/**
 * Circular avatar with Coil network image + initials fallback, and an optional
 * gradient ring (host emphasis / speaking indicator).
 *
 * [frame] is the ring the member bought: a transparent-centred PNG drawn *over* the avatar, with
 * [ProfileFrame.accent] as a plain circle underneath it while the art loads, so a slow CDN never
 * leaves a hole. It comes from the server's catalogue and is only ever the ring that member is
 * actually wearing — flipping it on locally would change what this phone draws and nothing else.
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
    frame: ProfileFrame? = null,
) {
    val initial = name?.trim()?.firstOrNull()?.uppercaseChar()?.toString() ?: "?"
    val innerSize = when {
        // The ring's inner hole is smaller than the image, so the face shrinks to sit inside it.
        frame != null -> size * 0.84f
        ringBrush != null -> size - ringWidth * 2
        else -> size
    }

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
        if (frame != null) {
            // Live rings (migration 0043): a rotating sweep aura in the ring's own accent, pulsing
            // behind the still PNG. Legendary adds a counter-rotating gold thread. Nothing here is
            // drawn for a plain ring, so the cheap path stays cheap.
            if (frame.animated) {
                val transition = rememberInfiniteTransition(label = "frameAura")
                val angle by transition.animateFloat(
                    initialValue = 0f,
                    targetValue = 360f,
                    animationSpec = infiniteRepeatable(tween(6000, easing = LinearEasing), RepeatMode.Restart),
                    label = "auraAngle",
                )
                val pulse by transition.animateFloat(
                    initialValue = 0.30f,
                    targetValue = 0.75f,
                    animationSpec = infiniteRepeatable(tween(1500, easing = FastOutSlowInEasing), RepeatMode.Reverse),
                    label = "auraPulse",
                )
                val accent = accentColor(frame.accent, OnDarkHigh)
                Box(
                    modifier = Modifier
                        .size(size * 1.18f)
                        .graphicsLayer {
                            rotationZ = angle
                            alpha = pulse
                        }
                        .clip(CircleShape)
                        .background(
                            Brush.sweepGradient(
                                listOf(accent, Color.Transparent, accent.copy(alpha = 0.55f), Color.Transparent, accent),
                            ),
                        ),
                )
                if (frame.tier == "LEGENDARY") {
                    Box(
                        modifier = Modifier
                            .size(size * 1.10f)
                            .graphicsLayer { rotationZ = -angle * 0.6f }
                            .clip(CircleShape)
                            .border(
                                1.5.dp,
                                Brush.sweepGradient(listOf(WarningAmber, Color.Transparent, WarningAmber, Color.Transparent, WarningAmber)),
                                CircleShape,
                            ),
                    )
                }
            }
            // Fallback first: an accent circle that is already the right shape when the PNG is late.
            Box(
                modifier = Modifier
                    .size(size)
                    .clip(CircleShape)
                    .border(2.dp, accentColor(frame.accent, OnDarkHigh), CircleShape),
            )
            AsyncImage(
                model = frame.art.asAssetUrl(),
                contentDescription = frame.name,
                contentScale = ContentScale.Fit,
                modifier = Modifier.size(size),
            )
        }
    }
}

/** Gradient ring preset reused by seats + speaking indicator. */
val SpeakingRingBrush: Brush = VoizaAccentGradient
