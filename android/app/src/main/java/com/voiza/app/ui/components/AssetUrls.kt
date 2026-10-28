package com.voiza.app.ui.components

import androidx.compose.ui.graphics.Color
import com.voiza.app.BuildConfig

/**
 * A rank's accent from the ladder (`#ecbc58`) as a Compose colour.
 *
 * Hand-parsed rather than `android.graphics.Color.parseColor` so it is a pure
 * function a JVM test can run, and so an operator typing a malformed value in
 * the admin panel degrades to [fallback] instead of crashing the room.
 */
fun accentColor(hex: String?, fallback: Color): Color {
    val digits = hex?.trim()?.removePrefix("#") ?: return fallback
    if (digits.length != 6) return fallback
    val rgb = digits.toIntOrNull(16) ?: return fallback
    // The Int constructor packs sRGB ARGB itself; Color(ULong) would need a colour-space tag
    // in its high bits and throws when it reads one that is not there.
    return Color(rgb or (0xFF shl 24))
}

/**
 * Gift icons, avatars and room covers are stored as root-relative paths
 * (`/gifts/rose.png`) that live on the backend origin, so Coil needs them
 * prefixed before it can load them. Absolute URLs pass through untouched.
 */
fun String?.asAssetUrl(): String? {
    val raw = this?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("data:") || raw.startsWith("file://")) {
        return raw
    }
    return apiOrigin + if (raw.startsWith("/")) raw else "/$raw"
}

/** Scheme + authority of the configured API base, without any path prefix. */
private val apiOrigin: String by lazy {
    val base = BuildConfig.VOIZA_API_BASE_URL
    val scheme = base.indexOf("://")
    if (scheme < 0) base
    else {
        val cut = base.indexOf('/', scheme + 3)
        if (cut < 0) base else base.substring(0, cut)
    }
}
