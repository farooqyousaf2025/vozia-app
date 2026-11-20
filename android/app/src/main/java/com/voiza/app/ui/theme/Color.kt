package com.voiza.app.ui.theme

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

// ---------------------------------------------------------------------------
// Vozia "Luxury Dark" palette.
//
// Deep black grounds, charcoal surfaces, royal purple for everything
// interactive, champagne gold reserved for premium: VIP, gifts, rewards,
// rankings and money. Two accents only — no neon, no third hue.
//
// Token names are the app's vocabulary; screens must never inline a hex.
// ---------------------------------------------------------------------------

// Surfaces
val VoizaBackground = Color(0xFF09090D) // main background — near black
val VoizaSurface = Color(0xFF111118) // secondary background
val VoizaSurfaceHigh = Color(0xFF181820) // card background
val VoizaSurfaceVariant = Color(0xFF22212B) // elevated surface
val VoizaOutline = Color(0xFF2E2C3A) // hairline outline

// Primary (royal purple) — actions, selection, active navigation
val Violet = Color(0xFF8050E8)
val VioletDark = Color(0xFF512B9C)
val VioletLight = Color(0xFFB9A6F2)

// Secondary accent (champagne gold) — premium moments only
val Fuchsia = Color(0xFF8050E8) // legacy name: the primary interactive accent
val Cyan = Color(0xFFD8B46A) // legacy name: the premium highlight accent
val Mint = Color(0xFF39C98A) // success / live / go

// Currency & rewards
val DiamondGold = Color(0xFFF1D69A) // light gold — coin and diamond figures
val RCoinGreen = Color(0xFF39C98A) // R-coin ledger positives

// Semantic
val DangerRed = Color(0xFFF05C69)
val WarningAmber = Color(0xFFE8B04B)
val GiftPink = Color(0xFFD8B46A) // legacy name: gifts, likes, rewards -> gold

// Text
val OnDarkHigh = Color(0xFFFFFFFF)
val OnDarkMedium = Color(0xFFA6A3B0)
val OnDarkMuted = Color(0xFF6F6C79)

// Signature gradients
/** Purple sweep — speaking rings, host seats, selected chrome. */
val VoizaAccentGradient = Brush.horizontalGradient(listOf(Violet, VioletLight))

/** Primary CTA fill. Deep purple -> royal purple -> light edge. */
val VoizaCtaGradient = Brush.horizontalGradient(listOf(VioletDark, Violet, Color(0xFF9A6BF0)))

/** Premium fill for gifts, VIP and reward surfaces. */
val VoizaGoldGradient = Brush.horizontalGradient(listOf(Color(0xFFB98D45), Color(0xFFD8B46A), Color(0xFFF1D69A)))

/** Host / speaking ring: purple sweep with a gold thread, read at nine seats per screen. */
val VoizaSeatRingGradient = Brush.sweepGradient(listOf(Violet, VioletLight, VioletDark, Violet))

/** Room and hero atmosphere: lifted charcoal-purple falling into black. */
val VoizaHeroGradient = Brush.verticalGradient(
    listOf(Color(0xFF191233), Color(0xFF100E1D), VoizaBackground),
)

/** Hairline card border, drawn over the card surface. */
val VoizaCardBorder = Color(0x14FFFFFF)
