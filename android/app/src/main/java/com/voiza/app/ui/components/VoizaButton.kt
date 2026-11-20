package com.voiza.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaCardBorder
import com.voiza.app.ui.theme.VoizaCtaGradient
import com.voiza.app.ui.theme.VoizaGoldGradient
import com.voiza.app.ui.theme.VoizaSurfaceVariant

/**
 * Vozia primary CTA: royal-purple gradient fill, rounded 16dp, medium-weight
 * label. Plain Box+clickable rather than Material Button so the gradient fills
 * the whole surface without ripple-shape fights.
 *
 * States: default (gradient), disabled (flat surface + muted label), and the
 * pressed feedback the caller gets from the ripple.
 */
@Composable
fun VoizaButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    gradient: Brush = VoizaCtaGradient,
    height: Int = 52,
) {
    val shape = RoundedCornerShape(16.dp)
    val disabledBrush = Brush.linearGradient(listOf(VoizaSurfaceVariant, VoizaSurfaceVariant))
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .height(height.dp)
            .clip(shape)
            .background(if (enabled) gradient else disabledBrush)
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = 18.dp),
    ) {
        Text(
            text = text,
            color = if (enabled) OnDarkHigh else OnDarkMuted,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/** Champagne-gold CTA for premium moments: gifts, VIP, reward claims. */
@Composable
fun VoizaGoldButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    height: Int = 52,
) {
    VoizaButton(
        text = text,
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        gradient = VoizaGoldGradient,
        height = height,
    )
}

/** Outlined secondary button on a charcoal surface. */
@Composable
fun VoizaSecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = OnDarkHigh),
        border = androidx.compose.foundation.BorderStroke(1.dp, VoizaCardBorder),
        modifier = modifier.height(46.dp),
    ) {
        Text(text, fontWeight = FontWeight.Medium)
    }
}

/** Plain ghost/text button. */
@Composable
fun VoizaTextButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
) {
    TextButton(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
    ) {
        Text(text, fontWeight = FontWeight.Medium, color = color)
    }
}
