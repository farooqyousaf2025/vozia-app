package com.voiza.app.ui.screens.room.gifts.svga

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.util.Log

/**
 * Draws one decoded [SvgaMovie], tick by tick, onto an Android [Canvas].
 *
 * ### The clock
 *
 * The model is a timeline of integer ticks — `frameCount` of them at `fps` — so the player is
 * deliberately *not* a free-running clock: the renderer owns timing, and this class only answers
 * "what does tick *n* look like". That is what keeps an SVGA gift under the same
 * `giftSlotMs(event, fallbackMs)` ceiling as the Lottie and MP4 renderers: the animation can be
 * asked to stop mid-tick by the slot, and a file whose declared frame count is a lie simply runs
 * out of frames and finishes early rather than running long.
 *
 * ### What is on screen, and what is quietly missing
 *
 * Bitmap layers with an alpha, a layout box and a 2x3 affine are drawn, aspect-fitted into the
 * view. Not drawn, by decision:
 *
 *  * `clipPath` masks and vector `shapes` — a frame that authors itself as a path has nothing
 *    bitmap-like to paint, and the rest of the movie still plays.
 *  * matte layers (an `imageKey` ending in `.matte`, and `matteKey` itself). A matte sprite is
 *    not art, it is a stencil: painting it would smear the mask over the gift. It is skipped, and
 *    the sprite it would have clipped appears unclipped — which is the same visible outcome as
 *    "no mask", and better than the alternative of hiding the layer that carries the gift.
 *  * audio tracks: the catalogue's own `soundUrl` is what the room hears, exactly as for an MP4
 *    gift, so a second audio inside the file would be one too many.
 *
 * ### Bitmaps
 *
 * Each image is decoded exactly once, in [prepare], scaled down on decode if it is larger than
 * [MAX_BITMAP_SIDE], and recycled in [dispose]. Nothing in [draw] allocates a bitmap: a gift that
 * decodes 40 sprites must not decode them again 40 times a second.
 */
internal class SvgaPlayer(val movie: SvgaMovie) {

    private val bitmaps = HashMap<String, Bitmap>()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val frameMatrix = Matrix()
    private val fitMatrix = Matrix()

    /** Ticks this movie can draw, from the parse; 1 when the file had nothing to say. */
    val frameCount: Int = movie.frameCount

    /** One tick of wall clock, for the renderer's timeline. */
    val frameDurationMs: Long = movie.frameDurationMs

    val durationMs: Long get() = movie.durationMs

    /**
     * Decodes every image the sprites reference. Call off the main thread.
     *
     * @return false when nothing usable came back, which the renderer treats as "no art" and hands
     *   to the burst — a movie whose only sprite is a 4 MB JPEG the decoder refused is not a gift
     *   the room should see nothing of.
     */
    fun prepare(): Boolean {
        if (bitmaps.isNotEmpty()) return true
        movie.images.forEach { (key, bytes) ->
            val bitmapKey = bitmapKey(key)
            if (bitmaps.containsKey(bitmapKey)) return@forEach
            decode(bytes)?.let { bitmaps[bitmapKey] = it }
        }
        return bitmaps.isNotEmpty()
    }

    /**
     * Paints tick [frameIndex] into [canvas], scaled to the canvas's own bounds.
     *
     * Frames outside the movie's range clamp to the first and last tick: the renderer drives this
     * from a slot timer that can overshoot, and a gift that ends should hold its final pose for
     * the remainder rather than flicker back to the start or blank.
     */
    fun draw(canvas: Canvas, frameIndex: Int) {
        if (bitmaps.isEmpty()) return
        val viewW = canvas.width.toFloat()
        val viewH = canvas.height.toFloat()
        if (viewW <= 0f || viewH <= 0f) return
        val scaleX = viewW / movie.width
        val scaleY = viewH / movie.height
        val fit = minOf(scaleX, scaleY)
        fitMatrix.reset()
        fitMatrix.postScale(fit, fit)
        fitMatrix.postTranslate((viewW - movie.width * fit) / 2f, (viewH - movie.height * fit) / 2f)

        val tick = frameIndex.coerceIn(0, frameCount - 1)
        movie.sprites.forEach { sprite ->
            if (isMatteLayer(sprite.imageKey)) return@forEach
            val frame = sprite.frames.getOrNull(tick) ?: return@forEach
            if (!frame.visible) return@forEach
            val layout = frame.layout ?: return@forEach
            val bitmap = bitmaps[bitmapKey(sprite.imageKey)] ?: return@forEach
            if (bitmap.isRecycled) return@forEach

            paint.alpha = (frame.alpha.coerceIn(0f, 1f) * 255f).toInt()
            // screen = fit · transform · translate(layout.x, layout.y) · scale(box / bitmap)
            // so the bitmap is first stretched into its authored box, then placed by the affine.
            frameMatrix.reset()
            frameMatrix.postScale(
                layout.width / bitmap.width.coerceAtLeast(1),
                layout.height / bitmap.height.coerceAtLeast(1),
            )
            frameMatrix.postTranslate(layout.x, layout.y)
            frameMatrix.postConcat(androidGraphicsMatrix(frame.transform))
            frameMatrix.postConcat(fitMatrix)
            canvas.drawBitmap(bitmap, frameMatrix, paint)
        }
    }

    /** Frees every decoded bitmap. Idempotent, and must run when the overlay leaves. */
    fun dispose() {
        bitmaps.values.forEach { bitmap ->
            if (!bitmap.isRecycled) bitmap.recycle()
        }
        bitmaps.clear()
    }

    private fun decode(bytes: ByteArray): Bitmap? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val sample = if (bounds.outWidth > 0 && bounds.outHeight > 0) {
            var candidate = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / candidate > MAX_BITMAP_SIDE) candidate *= 2
            candidate
        } else 1
        BitmapFactory.decodeByteArray(
            bytes, 0, bytes.size,
            BitmapFactory.Options().apply { inSampleSize = sample },
        )
    } catch (error: OutOfMemoryError) {
        Log.w(TAG, "svga bitmap decode ran out of memory; that layer is dropped")
        null
    } catch (error: Exception) {
        null
    }

    /**
     * The format's six scalars into Android's nine, in the order Android expects: `c` skews the x
     * axis and `b` the y axis, not the other way round.
     */
    private fun androidGraphicsMatrix(transform: SvgaTransform): Matrix = Matrix().apply {
        setValues(
            floatArrayOf(
                transform.a, transform.c, transform.tx,
                transform.b, transform.d, transform.ty,
                0f, 0f, 1f,
            )
        )
    }

    private companion object {
        const val TAG = "SvgaPlayer"

        /**
         * The ceiling for one sprite. Gift art authored for a phone rarely exceeds it, and a file
         * that carries a 4096px layer is going to be drawn fitted to a screen that is far smaller
         * anyway — dropping its resolution is the difference between playing and throwing.
         */
        const val MAX_BITMAP_SIDE = 1024

        /** `.matte` and `.vector` name a layer's role, not a different bitmap. */
        fun bitmapKey(imageKey: String): String =
            imageKey.removeSuffix(".matte").removeSuffix(".vector")

        fun isMatteLayer(imageKey: String): Boolean = imageKey.endsWith(".matte")
    }
}
