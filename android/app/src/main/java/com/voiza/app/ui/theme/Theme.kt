package com.voiza.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Deliberately dark-only + no dynamic color: a party app must keep its violet
// identity on every device, and dynamic palettes wash out the fuchsia/cyan
// accent gradients.
private val VoizaDarkColorScheme = darkColorScheme(
    primary = Violet,
    onPrimary = OnDarkHigh,
    primaryContainer = VioletDark,
    onPrimaryContainer = OnDarkHigh,
    secondary = Fuchsia,
    onSecondary = OnDarkHigh,
    secondaryContainer = VoizaSurfaceVariant,
    onSecondaryContainer = OnDarkHigh,
    tertiary = Cyan,
    onTertiary = VoizaBackground,
    background = VoizaBackground,
    onBackground = OnDarkHigh,
    surface = VoizaSurface,
    onSurface = OnDarkHigh,
    surfaceVariant = VoizaSurfaceHigh,
    onSurfaceVariant = OnDarkMedium,
    outline = VoizaOutline,
    error = DangerRed,
    onError = OnDarkHigh,
    errorContainer = Color(0xFF3A1220).let { it },
    onErrorContainer = OnDarkHigh,
)

@Composable
fun VoizaTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = VoizaDarkColorScheme,
        typography = VoizaTypography,
        shapes = VoizaShapes,
        content = content,
    )
}
