package com.voiza.app.ui.screens.room.gifts.svga

/**
 * A decoded SVGA movie, ready to be drawn, with nothing Android in it.
 *
 * Keeping the model free of `android.graphics` is what lets the parser and these numbers be
 * tested on the JVM, where no framework class works; the bitmaps stay as bytes until
 * [SvgaPlayer] decodes them once, on a background thread, for the overlay that asked for them.
 *
 * The shape is the SVGA 2.0 entity model: one canvas, one frame rate, a list of sprites, and one
 * frame entry per sprite per tick of the timeline. A sprite's entry for frame *n* lives at index
 * *n* of its own list, which is why a file whose sprite arrays disagree with the declared frame
 * count is repaired here rather than at draw time.
 */
internal class SvgaMovie(
    /** Canvas width the art was authored against; the drawing is fitted to the view from this. */
    val width: Float,
    val height: Float,
    /** Ticks per second. Defaults to the format's usual 20 when the file omits it. */
    val fps: Int,
    /** Total ticks in the timeline, at least 1 and never more than [MAX_FRAME_COUNT]. */
    val frameCount: Int,
    val sprites: List<SvgaSprite>,
    /** Every image the art needs, keyed by sprite `imageKey`, already resolved to decodable bytes. */
    val images: Map<String, ByteArray>,
    /** The exporter's version string, e.g. `2.1.0`; null when the file did not carry one. */
    val version: String?,
) {
    val frameDurationMs: Long get() = 1000L / fps.coerceAtLeast(1)

    /** Wall-clock length of one pass of this art, for logging and for the slot watchdog. */
    val durationMs: Long get() = frameCount * frameDurationMs

    companion object {
        /**
         * A ceiling on the timeline, not a feature limit. SVGA arrays are indexed by frame, so a
         * file claiming a huge frame count would allocate and draw forever; the overlay's slot
         * would cut it off anyway, and refusing it is the honest answer.
         */
        const val MAX_FRAME_COUNT = 4000

        /** Sprites are drawn in order, so a file with more layers than this is not a gift. */
        const val MAX_SPRITES = 128
    }
}

/**
 * One layer: which image it paints and what it does on each tick.
 *
 * [matteKey] and the `.vector` / `.matte` key suffixes are read and preserved but not honoured by
 * this player — see [SvgaPlayer] for what that costs on screen.
 */
internal class SvgaSprite(
    val imageKey: String,
    val frames: List<SvgaFrame>,
    val matteKey: String = "",
)

/**
 * A sprite's state for one tick.
 *
 * Absent scalars keep the format's own defaults rather than a guess: alpha 1 and an identity
 * transform, because a frame that says nothing about where it sits is a frame that sits where it
 * was authored. A frame with no layout is invisible — there is no size to scale the bitmap into,
 * and inventing one would smear the sprite across the canvas.
 */
internal class SvgaFrame(
    val alpha: Float,
    val layout: SvgaLayout?,
    val transform: SvgaTransform,
    /**
     * True when the entry carries a `clipPath`. Not implemented by the player; recorded so a
     * diagnostic can say which art is being drawn without its mask instead of silently cropping
     * nothing.
     */
    val clipped: Boolean = false,
) {
    val visible: Boolean get() = alpha > 0f && layout != null
}

/** Where the sprite's bitmap lands, in canvas units. */
internal class SvgaLayout(
    val x: Float,
    val y: Float,
    val width: Float,
    val height: Float,
)

/**
 * The 2x3 affine the exporter writes as six scalars.
 *
 * In the format's own terms the mapping is `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty` — note
 * that `b` and `c` are *not* symmetric: `c` moves the x axis and `b` the y axis, exactly as
 * CoreGraphics orders a `CGAffineTransform`. Rotation and skew live here, which is why the order
 * matters and why it is spelled out instead of left to whoever maps this into a matrix next.
 */
internal class SvgaTransform(
    val a: Float = 1f,
    val b: Float = 0f,
    val c: Float = 0f,
    val d: Float = 1f,
    val tx: Float = 0f,
    val ty: Float = 0f,
)
