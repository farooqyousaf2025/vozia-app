package com.voiza.app.ui.components

import androidx.compose.ui.graphics.toArgb
import com.voiza.app.domain.model.BubbleStyle
import org.junit.Assert.assertNull
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
    fun `bubble snapshots accept only opaque hash-prefixed six-digit hex`() {
        // Midnight, aurora, blossom and royal retain their exact server palette.
        val colours = listOf(
            "#202746", "#94B6FF", "#F5F7FF", "#123B3C", "#65E2CD", "#F5FFFD",
            "#41213B", "#F4A6D0", "#FFF5FA", "#362C1C", "#F2CB75", "#FFF9E9",
        )
        colours.forEach { hex ->
            assertEquals((0xFF000000L or hex.substring(1).toLong(16)).toInt(), BubbleStyle.parseColor(hex))
            assertEquals(BubbleStyle.parseColor(hex), BubbleStyle.parseColor(hex.lowercase()))
        }
        listOf(null, "", "red", "transparent", "202746", " #202746", "#202746 ", "#123", "#00123456", "#+12345", "#-12345", "#zzzzzz")
            .forEach { assertNull(BubbleStyle.parseColor(it)) }
    }

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
