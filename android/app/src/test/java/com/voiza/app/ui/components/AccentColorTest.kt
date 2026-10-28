package com.voiza.app.ui.components

import androidx.compose.ui.graphics.toArgb
import com.voiza.app.ui.theme.OnDarkMedium
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The ladder's accent is operator-typed text in the admin panel, validated by a
 * `#rrggbb` CHECK in migration 0017. Parsing it by hand keeps the rule testable
 * off-device and guarantees a bad value degrades to the app's own colour instead
 * of stopping a room from drawing.
 */
class AccentColorTest {

    private val fallback = OnDarkMedium

    @Test
    fun `a well-formed accent paints exactly the colour the operator chose`() {
        assertEquals(0xFFECBC58.toInt(), accentColor("#ecbc58", fallback).toArgb())
        assertEquals(0xFF1234AB.toInt(), accentColor("#1234AB", fallback).toArgb())
        // The leading '#' is the panel's convention, not a requirement of the format.
        assertEquals(0xFF00FF00.toInt(), accentColor("00ff00", fallback).toArgb())
    }

    @Test
    fun `anything that is not six hex digits falls back rather than throwing`() {
        assertEquals(fallback.toArgb(), accentColor(null, fallback).toArgb())
        assertEquals(fallback.toArgb(), accentColor("", fallback).toArgb())
        assertEquals(fallback.toArgb(), accentColor("#ecbc5", fallback).toArgb())
        assertEquals(fallback.toArgb(), accentColor("#zzzzzz", fallback).toArgb())
        assertEquals(fallback.toArgb(), accentColor("rgb(1,2,3)", fallback).toArgb())
    }
}
