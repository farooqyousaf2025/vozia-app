package com.voiza.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Deliberately dark-only + no dynamic colour: Vozia keeps its black/champagne
// identity on every device, and dynamic palettes wash out the purple/gold pair.
private val VoizaDarkColorScheme = darkColorScheme(
    primary = Violet,
    onPrimary = Color.White,
    primaryContainer = VioletDark,
    onPrimaryContainer = Color.White,
    secondary = Cyan,
    onSecondary = Color(0xFF1A140A),
    secondaryContainer = Color(0xFF2A2416),
    onSecondaryContainer = Color(0xFFF1D69A),
    tertiary = Mint,
    onTertiary = Color(0xFF04140D),
    background = VoizaBackground,
    onBackground = OnDarkHigh,
    surface = VoizaSurface,
    onSurface = OnDarkHigh,
    surfaceVariant = VoizaSurfaceHigh,
    onSurfaceVariant = OnDarkMedium,
    outline = VoizaOutline,
    error = DangerRed,
    onError = Color.White,
    errorContainer = Color(0xFF3A1620),
    onErrorContainer = Color(0xFFFFD9DC),
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
