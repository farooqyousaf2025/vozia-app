package com.voiza.app.ui.components

import com.voiza.app.BuildConfig

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
