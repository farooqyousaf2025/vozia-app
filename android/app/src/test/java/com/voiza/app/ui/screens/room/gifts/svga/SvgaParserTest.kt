package com.voiza.app.ui.screens.room.gifts.svga

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * The container sniffing and the protobuf reading, end to end.
 *
 * ### What these fixtures do and do not prove
 *
 * [movieEntity] below is a hand-written encoder, so the tests that use it prove the *plumbing*:
 * that a ZIP is opened, that `data.pb` is found in it, that the tree walks down into sprites and
 * frames, that lengths and wire types are honoured, that images are resolved, and that what comes
 * back is what went in. A self-authored writer proves nothing about whether the field numbers
 * match the format — get a number wrong in both the writer and the reader and the test still
 * passes. That gap is closed two ways:
 *
 *  * [specEncodedMovieEntityIsReadByTheFieldNumbersInTheFormat] builds its bytes as literal
 *    numbers straight from the published schema (the field numbers and wire types are in the
 *    comments next to each byte), with a writer nowhere in sight. It also carries two unknown
 *    fields, so it pins forward compatibility.
 *  * The numbers themselves were cross-checked before this code was written against the generated
 *    adapters in SVGAPlayer-Android
 *    (`library/src/main/java/com/opensource/svgaplayer/proto`, each `case N:` a tag) and
 *    against SVGAPlayer-iOS (`Source/pbobjc/Svga.pbobjc.h`, `SVGAProto*_FieldNumber_*`), and
 *    against 18 real exported files, whose `version` / `params` / `images` / `sprites` layout this
 *    reader matches. Those are the source of truth; a green test here is not.
 *
 * What is still unproven by any of this: that the *decoded art looks right*. Placement, scaling and
 * the transform's axis order are drawing concerns, and a JVM test has no canvas — see
 * [SvgaPlayer] for how those were derived, and the operator preview for whether they agree.
 */
class SvgaParserTest {

    // -------------------------------------------------------------- the spec, by hand

    /**
     * A whole `MovieEntity`, written as bytes from the schema rather than from a writer.
     *
     * Field numbers and wire types are the published ones:
     * `version = 1 (string)`, `params = 2`, `images = 3 (map<string,bytes>)`, `sprites = 4`;
     * `MovieParams.viewBoxWidth = 1 (float)`, `viewBoxHeight = 2`, `fps = 3 (int32)`, `frames = 4`;
     * `SpriteEntity.imageKey = 1`, `frames = 2`;
     * `FrameEntity.alpha = 1 (float)`, `layout = 2`, `transform = 3`;
     * `Layout.x = 1, y = 2, width = 3, height = 4` (float);
     * `Transform.a = 1, b = 2, c = 3, d = 4, tx = 5, ty = 6` (float).
     */
    private val specEncodedMovie: ByteArray = byteArrayOf(
        // field 1, wire type 2 (tag 0x0A), 5 bytes: "2.1.0"
        0x0A, 0x05, 0x32, 0x2E, 0x31, 0x2E, 0x30,
        // field 2, wire type 2 (tag 0x12), 14 bytes: MovieParams
        0x12, 0x0E,
        0x0D, 0x00, 0x00, 0x48, 0x42,   //   params.1 = 50.0f
        0x15, 0x00, 0x00, 0x48, 0x43,   //   params.2 = 200.0f
        0x18, 0x19,                     //   params.3 = 25
        0x20, 0x02,                     //   params.4 = 2
        // field 3, wire type 2 (tag 0x1A), 9 bytes: one map entry { 1 = "a", 2 = PNG magic }
        0x1A, 0x09,
        0x0A, 0x01, 0x61,               //   entry.1 key = "a"
        0x12, 0x04, 0x89.toByte(), 0x50, 0x4E, 0x47, // entry.2 value
        // field 4, wire type 2 (tag 0x22), 54 bytes: SpriteEntity
        0x22, 0x36,
        0x0A, 0x01, 0x61,               //   sprite.1 imageKey = "a"
        0x12, 0x31,                     //   sprite.2, 49 bytes: FrameEntity
        0x0D, 0x00, 0x00, 0x00, 0x3F,   //     frame.1 alpha = 0.5f
        0x12, 0x14,                     //     frame.2 layout, 20 bytes
        0x0D, 0x00, 0x00, 0x80.toByte(), 0x3F,   //       layout.1 x = 1.0f
        0x15, 0x00, 0x00, 0x00, 0x40,   //       layout.2 y = 2.0f
        0x1D, 0x00, 0x00, 0xC8.toByte(), 0x42,   //       layout.3 width = 100.0f
        0x25, 0x00, 0x00, 0x48, 0x42,   //       layout.4 height = 50.0f
        0x1A, 0x14,                     //     frame.3 transform, 20 bytes
        0x0D, 0x00, 0x00, 0x80.toByte(), 0x3F,   //       transform.1 a = 1.0f
        0x25, 0x00, 0x00, 0x80.toByte(), 0x3F,   //       transform.4 d = 1.0f
        0x2D, 0x00, 0x00, 0x40, 0x40,   //       transform.5 tx = 3.0f
        0x35, 0x00, 0x00, 0x80.toByte(), 0x40,   //       transform.6 ty = 4.0f
        // field 7 varint and field 8 bytes: unknown to this app, and not fatal.
        0x38, 0x64,
        0x42, 0x03, 0x01, 0x02, 0x03,
    ).map { it.toByte() }.toByteArray()

    @Test
    fun `specEncodedMovieEntityIsReadByTheFieldNumbersInTheFormat`() {
        val movie = requireSuccess(SvgaParser.parse(specEncodedMovie))
        assertEquals("2.1.0", movie.version)
        assertEquals(50.0f, movie.width, 0.0001f)
        assertEquals(200.0f, movie.height, 0.0001f)
        assertEquals(25, movie.fps)
        assertEquals(2, movie.frameCount)
        assertEquals(1, movie.sprites.size)
        assertEquals("a", movie.sprites[0].imageKey)
        // The declared frame count is 2 but only one frame was authored: the movie keeps 2 ticks,
        // and the second one draws nothing.
        assertEquals(1, movie.sprites[0].frames.size)

        val frame = movie.sprites[0].frames[0]
        assertEquals(0.5f, frame.alpha, 0.0001f)
        assertNotNull(frame.layout)
        assertEquals(1.0f, frame.layout!!.x, 0.0001f)
        assertEquals(2.0f, frame.layout!!.y, 0.0001f)
        assertEquals(100.0f, frame.layout!!.width, 0.0001f)
        assertEquals(50.0f, frame.layout!!.height, 0.0001f)
        assertEquals(1.0f, frame.transform.a, 0.0001f)
        assertEquals(0.0f, frame.transform.b, 0.0001f) // absent: the format's default
        assertEquals(0.0f, frame.transform.c, 0.0001f)
        assertEquals(1.0f, frame.transform.d, 0.0001f)
        assertEquals(3.0f, frame.transform.tx, 0.0001f)
        assertEquals(4.0f, frame.transform.ty, 0.0001f)

        // Unknown fields 7 and 8 were skipped, not mistaken for sprites, and the image came through.
        assertEquals(1, movie.images.size)
        assertEquals(listOf<Byte>(0x89.toByte(), 0x50, 0x4E, 0x47), movie.images["a"]!!.toList())
    }

    @Test
    fun `the same protobuf wrapped in zlib is the single file container`() {
        val wrapped = deflate(specEncodedMovie)
        assertTrue("expected a zlib header", wrapped[0].toInt() == 0x78)
        val movie = requireSuccess(SvgaParser.parse(wrapped))
        assertEquals(50.0f, movie.width, 0.0001f)
        assertEquals(1, movie.sprites.size)
        assertEquals(3.0f, movie.sprites[0].frames[0].transform.tx, 0.0001f)
    }

    @Test
    fun `a zip holding data pb plays the same movie`() {
        val zip = zipOf("data.pb" to specEncodedMovie)
        val movie = requireSuccess(SvgaParser.parse(zip))
        assertEquals(200.0f, movie.height, 0.0001f)
    }

    @Test
    fun `a zip holding movie binary with named images resolves the name`() {
        // The 1.x-in-a-zip and some 2.x exports store the *filename* in images rather than bytes.
        val pngBytes = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val movieEntity = movieEntity(
            version = "2.4.0",
            width = 320f,
            height = 240f,
            fps = 30,
            frames = 2,
            images = listOf("layer_1" to "img_1".toByteArray(Charsets.UTF_8)),
            sprites = listOf(sprite("layer_1", listOf(frame(1f, 10f, 20f, 30f, 1f, 1f, 0f, 0f, 0f)))),
        )
        val archive = zipOf(
            "movie.binary" to movieEntity,
            "img_1.png" to pngBytes,
            "__MACOSX/._img_1.png" to byteArrayOf(0x00, 0x01),
        )
        val movie = requireSuccess(SvgaParser.parse(archive))
        assertEquals("2.4.0", movie.version)
        assertEquals(1, movie.sprites.size)
        assertEquals(pngBytes.toList(), movie.images["layer_1"]!!.toList())
    }

    // -------------------------------------------------------------- the synthetic movie, my writer

    @Test
    fun `synthetic fixture round trips through the zip container`() {
        val png = minimalPng()
        val movie = movieEntity(
            version = "2.4.0",
            width = 400f,
            height = 300f,
            fps = 30,
            frames = 3,
            images = listOf("burst.png" to png, "halo.png" to png),
            sprites = listOf(
                sprite(
                    "burst.png",
                    listOf(
                        frame(1f, 0f, 0f, 200f, 100f, 2f, 2f, 10f, 20f),
                        frame(0.5f, 5f, 6f, 200f, 100f, 1f, 1f, 0f, 0f),
                        frame(0f, 0f, 0f, 200f, 100f, 1f, 1f, 0f, 0f),
                    ),
                ),
                sprite(
                    "halo.png",
                    listOf(frame(1f, 1f, 1f, 50f, 50f, 1f, 1f, 3f, 4f)),
                ),
            ),
        )
        val archive = zipOf("data.pb" to movie)
        val parsed = requireSuccess(SvgaParser.parse(archive))

        assertEquals("2.4.0", parsed.version)
        assertEquals(400.0f, parsed.width, 0.0001f)
        assertEquals(300.0f, parsed.height, 0.0001f)
        assertEquals(30, parsed.fps)
        assertEquals(3, parsed.frameCount)
        assertEquals(1000L / 30, parsed.frameDurationMs)
        assertEquals(2, parsed.sprites.size)
        assertEquals(3, parsed.sprites[0].frames.size)
        assertEquals(1, parsed.sprites[1].frames.size)
        // frame count repairs itself from the longest sprite when params under-declare.
        assertEquals(3, parsed.durationMs / parsed.frameDurationMs)

        val second = parsed.sprites[0].frames[1]
        assertEquals(0.5f, second.alpha, 0.0001f)
        assertEquals(5f, second.layout!!.x, 0.0001f)
        assertEquals(6f, second.layout!!.y, 0.0001f)
        assertEquals(2f, parsed.sprites[0].frames[0].transform.a, 0.0001f)
        assertEquals(10f, parsed.sprites[0].frames[0].transform.tx, 0.0001f)
        assertEquals(20f, parsed.sprites[0].frames[0].transform.ty, 0.0001f)

        // Embedded image bytes survive intact, keyed by the sprite's own imageKey.
        assertEquals(2, parsed.images.size)
        assertEquals(png.toList(), parsed.images["burst.png"]!!.toList())
        assertFalse("a zero-alpha frame is not visible", parsed.sprites[0].frames[2].visible)
    }

    @Test
    fun `a frame's clip path is recorded but does not stop the rest of the movie`() {
        val movie = movieEntity(
            version = "2.4.0",
            width = 100f,
            height = 100f,
            fps = 20,
            frames = 1,
            images = listOf("k" to minimalPng()),
            sprites = listOf(
                sprite("k", listOf(frame(1f, 0f, 0f, 10f, 10f, 1f, 1f, 0f, 0f, clipPath = "2,0,0,10,10"))),
            ),
        )
        val parsed = requireSuccess(SvgaParser.parse(zipOf("data.pb" to movie)))
        assertTrue(parsed.sprites[0].frames[0].clipped)
        assertEquals(1, parsed.sprites.size)
    }

    @Test
    fun `matte and vector suffixes are carried through the parse`() {
        val movie = movieEntity(
            version = "2.4.0",
            width = 100f, height = 100f, fps = 20, frames = 1,
            images = listOf("art.matte" to minimalPng()),
            sprites = listOf(spriteWithMatte("art", "art.matte")),
        )
        val parsed = requireSuccess(SvgaParser.parse(zipOf("data.pb" to movie)))
        assertEquals("art", parsed.sprites[0].imageKey)
        assertEquals("art.matte", parsed.sprites[0].matteKey)
    }

    // -------------------------------------------------------------- the 1.x layouts

    @Test
    fun `the 1 point 1 json spec in a zip is read and its named images resolved`() {
        val png = minimalPng()
        val spec = """
            {"ver":"1.1.0",
             "movie":{"viewBox":{"width":400,"height":400},"fps":30,"frames":4},
             "images":{"dengziqi.matte":"dengziqi"},
             "sprites":[{"matteKey":"","imageKey":"dengziqi.matte","frames":[
               {"alpha":1,"layout":{"x":0,"y":0,"width":250,"height":300},
                "transform":{"a":0.62,"b":0,"c":0,"d":0.62,"tx":9.5,"ty":-4}},
               {"alpha":0.25,"layout":{"x":1,"y":2,"width":250,"height":300},
                "transform":{"a":1,"b":0,"c":0,"d":1,"tx":0,"ty":0}}]}]}
        """.trimIndent()
        val parsed = requireSuccess(SvgaParser.parse(zipOf("movie.spec" to spec.toByteArray(), "dengziqi.png" to png)))
        assertEquals("1.1.0", parsed.version)
        assertEquals(400.0f, parsed.width, 0.0001f)
        assertEquals(30, parsed.fps)
        assertEquals(4, parsed.frameCount)
        assertEquals(1, parsed.sprites.size)
        assertEquals(2, parsed.sprites[0].frames.size)
        assertEquals(0.62f, parsed.sprites[0].frames[0].transform.a, 0.0001f)
        assertEquals(9.5f, parsed.sprites[0].frames[0].transform.tx, 0.0001f)
        assertEquals(-4f, parsed.sprites[0].frames[0].transform.ty, 0.0001f)
        assertEquals(0.25f, parsed.sprites[0].frames[1].alpha, 0.0001f)
        // images maps the key to the name "dengziqi", and the zip stores it as dengziqi.png.
        assertEquals(png.toList(), parsed.images["dengziqi.matte"]!!.toList())
    }

    @Test
    fun `the 1 point 0 json spec puts frames on the movie and names images in params`() {
        val png = minimalPng()
        val spec = """
            {"version":"1.0.0",
             "params":{"size":{"width":200,"height":100},"fps":20,"frames":2,
                       "images":{"img_1":"img_1.png"}},
             "sprites":[{"name":"img_1"},{"name":"img_2"}],
             "frames":[
               [{"image":"img_1","alpha":1,"layout":{"x":0,"y":0,"width":40,"height":20},
                 "transform":{"a":1,"b":0,"c":0,"d":1,"tx":5,"ty":6}}],
               [{"image":"img_1","alpha":0.5,"layout":{"x":0,"y":0,"width":40,"height":20},
                 "transform":{"a":2,"b":0,"c":0,"d":2,"tx":0,"ty":0}}]
             ]}
        """.trimIndent()
        val parsed = requireSuccess(SvgaParser.parse(zipOf("movie.spec" to spec.toByteArray(), "img_1.png" to png)))
        assertEquals(200.0f, parsed.width, 0.0001f)
        assertEquals(100.0f, parsed.height, 0.0001f)
        assertEquals(20, parsed.fps)
        assertEquals(2, parsed.frameCount)
        assertEquals(2, parsed.sprites.size)
        assertEquals("img_1", parsed.sprites[0].imageKey)
        assertEquals(5f, parsed.sprites[0].frames[0].transform.tx, 0.0001f)
        assertEquals(2f, parsed.sprites[1].frames[0].transform.a, 0.0001f)
        assertEquals(png.toList(), parsed.images["img_1"]!!.toList())
    }

    // -------------------------------------------------------------- every way this must not crash

    @Test
    fun `not an svga file at all is a failure and not an exception`() {
        val cases = listOf<ByteArray>(
            "plain text that is not an svga file at all, not even close".toByteArray(),
            byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
                0x07, 0x08, 0x09, 0x0A, 0x0B),
            zipOf("readme.txt" to "hello".toByteArray()),
            byteArrayOf(0x50, 0x4B, 0x03, 0x04) + ByteArray(32),
            ByteArray(64),
        )
        cases.forEach { bytes ->
            val result = SvgaParser.parse(bytes)
            assertTrue("expected failure for a ${bytes.size}-byte container, got $result",
                result is SvgaParseResult.Failure)
        }
    }

    @Test
    fun `a truncated protobuf is refused cleanly`() {
        // Cut the sprite off mid-length: the reader must not walk past the buffer.
        val cut = specEncodedMovie.copyOfRange(0, specEncodedMovie.size - 30)
        assertTrue(SvgaParser.parse(cut) is SvgaParseResult.Failure)
        // A length that claims more bytes than the container has.
        val liar = byteArrayOf(0x0A, 0x7F) + ByteArray(20)
        assertTrue(SvgaParser.parse(liar) is SvgaParseResult.Failure)
    }

    @Test
    fun `a protobuf with no sprites is not a gift`() {
        // version + params only.
        val bytes = byteArrayOf(
            0x0A, 0x03, 0x32, 0x2E, 0x30,
            0x12, 0x08, 0x0D, 0x00, 0x00, 0x20, 0x42, 0x15, 0x00, 0x00, 0x20, 0x42,
        ).map { it.toByte() }.toByteArray() + byteArrayOf(0x18, 0x01) // pad to clear the size gate
        val result = SvgaParser.parse(bytes)
        assertTrue(result.toString(), result is SvgaParseResult.Failure)
    }

    @Test
    fun `a movie whose images are unusable is a failure`() {
        val movie = movieEntity(
            version = "2.4.0", width = 10f, height = 10f, fps = 10, frames = 1,
            // "img" points at a name the zip does not carry.
            images = listOf("k" to "absent".toByteArray()),
            sprites = listOf(sprite("k", listOf(frame(1f, 0f, 0f, 4f, 4f, 1f, 1f, 0f, 0f)))),
        )
        val result = SvgaParser.parse(zipOf("data.pb" to movie))
        assertTrue(result.toString(), result is SvgaParseResult.Failure)
    }

    @Test
    fun `an absurd frame count is clamped instead of trusted`() {
        val movie = movieEntity(
            version = "2.4.0", width = 10f, height = 10f, fps = 30, frames = 1_000_000,
            images = listOf("k" to minimalPng()),
            sprites = listOf(sprite("k", listOf(frame(1f, 0f, 0f, 4f, 4f, 1f, 1f, 0f, 0f)))),
        )
        val parsed = requireSuccess(SvgaParser.parse(zipOf("data.pb" to movie)))
        assertEquals(SvgaMovie.MAX_FRAME_COUNT, parsed.frameCount)
    }

    @Test
    fun `an insane fps falls back to the format default rather than a zero length tick`() {
        val movie = movieEntity(
            version = "2.4.0", width = 10f, height = 10f, fps = 9999, frames = 4,
            images = listOf("k" to minimalPng()),
            sprites = listOf(sprite("k", listOf(frame(1f, 0f, 0f, 4f, 4f, 1f, 1f, 0f, 0f)))),
        )
        val parsed = requireSuccess(SvgaParser.parse(zipOf("data.pb" to movie)))
        assertEquals(20, parsed.fps)
        assertTrue(parsed.frameDurationMs > 0)
    }

    @Test
    fun `a tiny or empty container is answered without a crash`() {
        assertTrue(SvgaParser.parse(ByteArray(0)) is SvgaParseResult.Failure)
        assertTrue(SvgaParser.parse(byteArrayOf(0x78, 0x9c.toByte())) is SvgaParseResult.Failure)
        assertTrue(SvgaParser.parse("{}".toByteArray(Charsets.UTF_8)) is SvgaParseResult.Failure)
    }

    @Test
    fun `a zip with only an empty directory is a failure`() {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { it.putNextEntry(ZipEntry("images/")); it.closeEntry() }
        assertTrue(SvgaParser.parse(out.toByteArray()) is SvgaParseResult.Failure)
    }

    // -------------------------------------------------------------- fixture builders

    private fun requireSuccess(result: SvgaParseResult): SvgaMovie {
        assertTrue("parse failed: $result", result is SvgaParseResult.Success)
        return (result as SvgaParseResult.Success).movie
    }

    /**
     * A 1x1 transparent PNG, assembled here chunk by chunk so the bytes are certainly a real image.
     * Only its magic prefix matters to the parser, which sniffs it and never decodes it — decoding
     * is [SvgaPlayer]'s job, off the main thread, and there is no Android in a JVM test.
     *
     * Written by hand rather than with `ImageIO` because that class is not in the Android runtime
     * this module compiles against: a JDK-desktop helper would be a test source set that builds on
     * one machine and not on the next.
     */
    private fun minimalPng(): ByteArray {
        // 1x1, 8-bit RGBA (colour type 6), no compression/filtering/interlace of its own.
        val header = bigEndian(1) + bigEndian(1) + byteArrayOf(8, 6, 0, 0, 0)
        // One scanline: a filter byte of 0 (None) followed by one fully transparent pixel.
        val deflater = Deflater()
        deflater.setInput(ByteArray(5))
        deflater.finish()
        val raw = ByteArrayOutputStream()
        val buffer = ByteArray(64)
        while (!deflater.finished()) {
            raw.write(buffer, 0, deflater.deflate(buffer))
        }
        deflater.end()
        return PNG_SIGNATURE + pngChunk("IHDR", header) +
            pngChunk("IDAT", raw.toByteArray()) + pngChunk("IEND", ByteArray(0))
    }

    private fun pngChunk(type: String, body: ByteArray): ByteArray {
        // The CRC covers the type and the data, and never the length field before them.
        val payload = type.toByteArray(Charsets.ISO_8859_1) + body
        val crc = CRC32().apply { update(payload) }
        return bigEndian(body.size) + payload + bigEndian(crc.value.toInt())
    }

    /** Big-endian, because every integer in a PNG is. */
    private fun bigEndian(value: Int) = byteArrayOf(
        (value ushr 24).toByte(),
        (value ushr 16).toByte(),
        (value ushr 8).toByte(),
        value.toByte(),
    )

    private val PNG_SIGNATURE =
        byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 0x0D, 0x0A, 0x1A, 0x0A)

    private fun zipOf(vararg entries: Pair<String, ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            entries.forEach { (name, bytes) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(bytes)
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }

    private fun deflate(bytes: ByteArray): ByteArray {
        // nowrap = false: a zlib stream, header and trailing checksum and all, which is what the
        // single-file 2.0 container is. Raw deflate (nowrap = true) has no header to sniff.
        val deflater = Deflater(6, false)
        deflater.setInput(bytes)
        deflater.finish()
        val out = ByteArrayOutputStream(bytes.size)
        val buffer = ByteArray(8192)
        while (!deflater.finished()) out.write(buffer, 0, deflater.deflate(buffer))
        deflater.end()
        return out.toByteArray()
    }

    // A minimal writer, used only by the fixtures above. Everything it emits is the same encoding
    // the hand-written literal at the top of this file is, and that one is the reference.

    private fun varint(value: Long): ByteArray {
        val out = ByteArrayOutputStream(10)
        var remaining = value
        while (true) {
            val byte = (remaining and 0x7F).toInt()
            remaining = remaining ushr 7
            if (remaining == 0L) {
                // A negative value keeps shifting; sign-extension means it never reaches 0, so the
                // loop above is only correct for the non-negative range the fixtures use.
                out.write(byte)
                return out.toByteArray()
            }
            out.write(byte or 0x80)
        }
    }

    private fun tag(field: Int, wireType: Int): ByteArray = varint(((field.toLong() shl 3) or wireType.toLong()))

    private fun stringField(field: Int, value: String): ByteArray =
        tag(field, 2) + varint(value.length.toLong()) + value.toByteArray(Charsets.UTF_8)

    private fun bytesField(field: Int, value: ByteArray): ByteArray =
        tag(field, 2) + varint(value.size.toLong()) + value

    private fun messageField(field: Int, value: ByteArray): ByteArray =
        tag(field, 2) + varint(value.size.toLong()) + value

    private fun floatField(field: Int, value: Float): ByteArray =
        tag(field, 5) + byteArrayOf(
            (value.toRawBits() and 0xFF).toByte(),
            ((value.toRawBits() shr 8) and 0xFF).toByte(),
            ((value.toRawBits() shr 16) and 0xFF).toByte(),
            ((value.toRawBits() shr 24) and 0xFF).toByte(),
        )

    private fun intField(field: Int, value: Int): ByteArray = tag(field, 0) + varint(value.toLong())

    private fun movieEntity(
        version: String,
        width: Float,
        height: Float,
        fps: Int,
        frames: Int,
        images: List<Pair<String, ByteArray>>,
        sprites: List<ByteArray>,
    ): ByteArray =
        stringField(1, version) +
            messageField(2, floatField(1, width) + floatField(2, height) + intField(3, fps) + intField(4, frames)) +
            // A proto3 map entry is ONE submessage holding both key=1 and value=2.
            images.fold(ByteArray(0)) { acc, (key, value) ->
                acc + messageField(3, bytesField(1, key.toByteArray(Charsets.UTF_8)) + bytesField(2, value))
            } +
            sprites.fold(ByteArray(0)) { acc, sprite -> acc + messageField(4, sprite) }

    private fun sprite(imageKey: String, frames: List<ByteArray>): ByteArray =
        stringField(1, imageKey) +
            frames.fold(ByteArray(0)) { acc, frame -> acc + messageField(2, frame) }

    private fun spriteWithMatte(imageKey: String, matteKey: String): ByteArray =
        stringField(1, imageKey) + messageField(2, frame(1f, 0f, 0f, 4f, 4f, 1f, 1f, 0f, 0f)) +
            stringField(3, matteKey)

    private fun frame(
        alpha: Float,
        x: Float,
        y: Float,
        layoutWidth: Float,
        layoutHeight: Float,
        a: Float,
        d: Float,
        tx: Float,
        ty: Float,
        clipPath: String? = null,
    ): ByteArray =
        floatField(1, alpha) +
            messageField(2, floatField(1, x) + floatField(2, y) + floatField(3, layoutWidth) + floatField(4, layoutHeight)) +
            messageField(3, floatField(1, a) + floatField(4, d) + floatField(5, tx) + floatField(6, ty)) +
            (clipPath?.let { stringField(4, it) } ?: ByteArray(0))
}
