package com.voiza.app.ui.theme

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

// ---------------------------------------------------------------------------
// Voiza brand palette — dark-first party aesthetic.
// Deep violet/indigo surfaces, fuchsia -> cyan accent gradient, diamond gold.
// ---------------------------------------------------------------------------

// Surfaces
val VoizaBackground = Color(0xFF0B0A1F)
val VoizaSurface = Color(0xFF151233)
val VoizaSurfaceHigh = Color(0xFF1E1A45)
val VoizaSurfaceVariant = Color(0xFF2A2459)
val VoizaOutline = Color(0xFF3D3670)

// Primary (deep violet)
val Violet = Color(0xFF7C4DFF)
val VioletDark = Color(0xFF5325C8)
val VioletLight = Color(0xFFB39DFF)

// Accents
val Fuchsia = Color(0xFFE040FB)
val Cyan = Color(0xFF22D3EE)
val Mint = Color(0xFF34E5B4)

// Semantic
val DiamondGold = Color(0xFF4DD0E1)
val RCoinGreen = Color(0xFF66E0A3)
val DangerRed = Color(0xFFFF5B6E)
val WarningAmber = Color(0xFFFFC246)
val GiftPink = Color(0xFFFF6EC7)

// Text
val OnDarkHigh = Color(0xFFF3F1FF)
val OnDarkMedium = Color(0xFFB9B4D6)
val OnDarkMuted = Color(0xFF7C76A3)

// Signature gradients (fuchsia -> cyan)
val VoizaAccentGradient = Brush.horizontalGradient(listOf(Fuchsia, Cyan))
val VoizaCtaGradient = Brush.horizontalGradient(listOf(VioletDark, Fuchsia, Cyan))
val VoizaSeatRingGradient = Brush.sweepGradient(listOf(Fuchsia, Cyan, Fuchsia))
val VoizaHeroGradient = Brush.verticalGradient(
    listOf(Color(0xFF2A1A5E), Color(0xFF151233), VoizaBackground)
)
