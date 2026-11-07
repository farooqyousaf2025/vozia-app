package com.voiza.app.ui.screens.room.gifts

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The one clock rule both a gift and an entrance ride keep.
 *
 * The lifetime is the operator's answer, typed into the same row as the art, so what a JVM test can
 * pin down is the client's side of it: a declared number is obeyed, and everything else — the honest
 * zero, a number nobody should hold a room to, a negative — falls back to the ceiling the caller
 * carries for that container rather than being taken at face value.
 */
class AnimationSlotTest {

    @Test
    fun `a declared lifetime is the clock the room keeps`() {
        assertEquals(4_000L, animationSlotMs(4_000, 6_000L))
        assertEquals(250L, animationSlotMs(250, 6_000L))
        assertEquals(30_000L, animationSlotMs(30_000, 6_000L))
    }

    @Test
    fun `zero is the operator saying play it for its own length`() {
        // Not a gap to fill with a guessed lifetime: the caller's ceiling is the answer.
        assertEquals(6_000L, animationSlotMs(0, 6_000L))
        assertEquals(8_000L, animationSlotMs(0, 8_000L))
    }

    @Test
    fun `a number outside the bounds is not a lifetime at all`() {
        assertEquals(6_000L, animationSlotMs(249, 6_000L))
        assertEquals(6_000L, animationSlotMs(30_001, 6_000L))
        assertEquals(6_000L, animationSlotMs(-1, 6_000L))
    }
}
