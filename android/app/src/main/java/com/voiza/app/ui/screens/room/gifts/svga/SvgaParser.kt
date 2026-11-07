package com.voiza.app.ui.screens.room.gifts.svga

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.Inflater
import java.util.zip.ZipInputStream

/**
 * An `.svga` upload that either became a drawable movie or did not, with the reason it did not.
 *
 * There is no throw at this boundary on purpose: the caller is a paid gift's animation slot, and
 * every branch of [Failure] is handled the same way — the burst renderer takes the slot instead —
 * so the only thing a reason string is good for is telling an operator which of their uploads the
 * app cannot read.
 */
internal sealed class SvgaParseResult {
    data class Success(val movie: SvgaMovie) : SvgaParseResult()
    data class Failure(val reason: String) : SvgaParseResult()
}

/**
 * Bytes of an uploaded SVGA file, in, and a movie out.
 *
 * ### What an SVGA file actually is
 *
 * Verified against the two canonical implementations and against real exported files, not from
 * memory: the entity schema is the one in SVGAPlayer-Android's `svga.proto`
 * (https://github.com/svga/SVGAPlayer-Android, the generated adapters under
 * `library/src/main/java/com/opensource/svgaplayer/proto`,
 * each one naming its own tag in a `case N:` switch) and it is byte-for-byte the
 * same schema in SVGAPlayer-iOS's generated protobuf
 * (https://github.com/svga/SVGAPlayer-iOS, `Source/pbobjc/Svga.pbobjc.h`, which spells the
 * numbers out as `SVGAProtoMovieEntity_FieldNumber_Version = 1` and friends). Both agree, and the
 * files the exporters emit agree with them.
 *
 * ```text
 * MovieEntity   1 version:string  2 params:MovieParams  3 images:map<string,bytes>
 *               4 sprites:repeated SpriteEntity  5 audios:repeated AudioEntity
 * MovieParams   1 viewBoxWidth:float 2 viewBoxHeight:float 3 fps:int32 4 frames:int32
 * SpriteEntity  1 imageKey:string  2 frames:repeated FrameEntity  3 matteKey:string
 * FrameEntity   1 alpha:float  2 layout:Layout  3 transform:Transform
 *               4 clipPath:string  5 shapes:repeated ShapeEntity
 * Layout        1 x:float  2 y:float  3 width:float  4 height:float
 * Transform     1 a  2 b  3 c  4 d  5 tx  6 ty          (all float)
 * AudioEntity   1 audioKey  2 startFrame  3 endFrame  4 startTime  5 totalTime
 * map entry     1 key:string  2 value:bytes            (proto3 map encoding)
 * ```
 *
 * One correction to the folklore that comes with this format, and it matters here: the 2.0 entity
 * has **no `header` sub-message** — `version` is field 1 of `MovieEntity` itself, and the canvas
 * size, frame rate and frame count are fields of `params`. There is also no movie-level `frames`
 * array in the protobuf schema at all, so the "1.0 shape" is not an older protobuf: it is the
 * older *JSON* spec. The layouts this reader therefore accepts are the ones that exist in the
 * wild:
 *
 * 1. **SVGA 2.x, single stream** — the whole file is one zlib-deflated `MovieEntity`, every image
 *    embedded in `images` as PNG/JPEG bytes. (`78 9C` as the first two bytes.)
 * 2. **SVGA 2.x in a ZIP** — a ZIP holding the protobuf as `data.pb` / `data.bin` /
 *    `movie.binary` next to PNG entries the `images` map names instead of containing.
 * 3. **SVGA 1.x in a ZIP** — a ZIP holding `movie.spec`, which is JSON: 1.1 writes
 *    `movie` + `images` + `sprites[].frames`, 1.0 writes `params` + a movie-level `frames` array
 *    of per-sprite arrays.
 * 4. An already-undeplated protobuf, because a file that starts with a `0A` tag is that and
 *    nothing else.
 *
 * ### What this reader does not do
 *
 * Vector `shapes`, `clipPath` masks, `matteKey`/`.matte` layers, audio tracks, and
 * `imageScaleMode` are all skipped (see [SvgaPlayer] for what the room loses). Unknown protobuf
 * fields are ignored rather than rejected, so a file from a newer exporter still plays today's
 * supported subset.
 */
internal object SvgaParser {

    /** Container sniffing only: a gift animation is a few megabytes, and a bigger file is not one. */
    private const val MAX_BYTES = 48 * 1024 * 1024
    private const val MAX_UNZIP_BYTES = 64 * 1024 * 1024

    /** The names a 2.x ZIP has been seen to carry the protobuf under, in the order players try. */
    private val PROTO_ENTRIES = arrayOf("data.pb", "data.bin", "movie.binary", "movie.pb")
    private val JSON_ENTRIES = arrayOf("movie.spec", "movie.json")

    fun parse(container: ByteArray): SvgaParseResult {
        if (container.size < 16) return SvgaParseResult.Failure("file too small to be an SVGA container")
        if (container.size > MAX_BYTES) return SvgaParseResult.Failure("file larger than $MAX_BYTES bytes")
        return try {
            if (isZip(container)) parseZip(container) else parseLoose(container)
        } catch (e: SvgaParseFailure) {
            SvgaParseResult.Failure("malformed protobuf: ${e.message}")
        } catch (e: Exception) {
            // Includes a corrupt ZIP, an OutOfMemoryError-free decode refusal, and anything the
            // JSON tree finds that Gson cannot hold. The gift still plays as a burst.
            SvgaParseResult.Failure("unreadable container: ${e.javaClass.simpleName}")
        }
    }

    // ---------------------------------------------------------------- containers

    private fun isZip(b: ByteArray): Boolean =
        b.size > 3 && b[0].toInt() == 0x50 && b[1].toInt() == 0x4B && b[2].toInt() == 0x03 && b[3].toInt() == 0x04

    private fun parseZip(container: ByteArray): SvgaParseResult {
        val entries = LinkedHashMap<String, ByteArray>()
        var total = 0
        ByteArrayInputStream(container).use { source ->
            ZipInputStream(source).use { zip ->
                var entry = zip.nextEntry
                while (entry != null) {
                    if (!entry.isDirectory) {
                        val bytes = readCapped(zip, MAX_UNZIP_BYTES - total)
                        if (bytes != null) {
                            total += bytes.size
                            // macOS resource forks ride along in the ZIP of an art file someone
                            // zipped up by hand; they are not part of the movie.
                            if (!isAppleDouble(entry.name)) entries[entry.name] = bytes
                        } else {
                            return SvgaParseResult.Failure("zip expands past $MAX_UNZIP_BYTES bytes")
                        }
                    }
                    zip.closeEntry()
                    entry = zip.nextEntry
                }
            }
        }
        if (entries.isEmpty()) return SvgaParseResult.Failure("zip has no entries")

        PROTO_ENTRIES.forEach { name ->
            entries[name]?.let { payload ->
                return protobufResult(inflateIfNeeded(payload), entries)
            }
        }
        JSON_ENTRIES.forEach { name ->
            entries[name]?.let { payload ->
                return jsonResult(String(inflateIfNeeded(payload), Charsets.UTF_8), entries)
            }
        }
        return SvgaParseResult.Failure("zip holds no movie.spec / data.pb / movie.binary")
    }

    private fun parseLoose(container: ByteArray): SvgaParseResult {
        if (container[0].toInt() == 0x78) {
            return protobufResult(inflate(container), emptyMap())
        }
        // A single-file 1.x that is JSON rather than protobuf still starts with '{'.
        if (container[0].toInt() == '{'.code) {
            return jsonResult(String(container, Charsets.UTF_8), emptyMap())
        }
        return protobufResult(container, emptyMap())
    }

    /** zlib only when the header says zlib; `movie.binary` is stored raw, the single-file form is not. */
    private fun inflateIfNeeded(payload: ByteArray): ByteArray {
        if (payload.size < 2 || payload[0].toInt() != 0x78) return payload
        val second = payload[1].toInt() and 0xFF
        val plausibleCmf = second in 0x01..0xFF && (payload[0].toInt() shl 8 or second) % 31 == 0
        return if (plausibleCmf) inflate(payload) else payload
    }

    private fun inflate(bytes: ByteArray): ByteArray {
        val inflater = Inflater()
        try {
            inflater.setInput(bytes)
            val out = ByteArrayOutputStream(minOf(bytes.size * 3, MAX_UNZIP_BYTES))
            val buffer = ByteArray(64 * 1024)
            while (!inflater.finished()) {
                val read = inflater.inflate(buffer)
                if (read == 0) {
                    if (inflater.needsInput() || inflater.needsDictionary()) break
                }
                out.write(buffer, 0, read)
                if (out.size() > MAX_UNZIP_BYTES) throw SvgaParseFailure("inflated stream too large")
            }
            return out.toByteArray()
        } finally {
            inflater.end()
        }
    }

    private fun readCapped(zip: ZipInputStream, cap: Int): ByteArray? {
        if (cap <= 0) return null
        val out = ByteArrayOutputStream(8 * 1024)
        val buffer = ByteArray(8 * 1024)
        while (out.size() < cap) {
            val read = zip.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
        }
        return if (out.size() > cap) null else out.toByteArray()
    }

    private fun isAppleDouble(name: String): Boolean =
        name.startsWith("__MACOSX/") || name.substringAfterLast('/').startsWith("._")

    // ---------------------------------------------------------------- protobuf

    private fun protobufResult(
        movieBytes: ByteArray,
        files: Map<String, ByteArray>,
    ): SvgaParseResult {
        val wire = SvgaWire(movieBytes)
        var version: String? = null
        var width = 0f
        var height = 0f
        var fps = 0
        var declaredFrames = 0
        val rawImages = LinkedHashMap<String, ByteArray>()
        val spriteParts = mutableListOf<Triple<String, String, MutableList<SvgaFrame>>>()

        while (true) {
            when (val field = wire.nextField() ?: break) {
                1 -> version = wire.readString()
                2 -> {
                    val params = wire.readMessage()
                    while (true) {
                        when (params.nextField() ?: break) {
                            1 -> width = params.readFloat()
                            2 -> height = params.readFloat()
                            3 -> fps = params.readInt32()
                            4 -> declaredFrames = params.readInt32()
                            else -> params.skipValue()
                        }
                    }
                }
                3 -> {
                    // proto3 map<string, bytes>: one length-delimited entry per key.
                    val entry = wire.readMessage()
                    var key = ""
                    var value = ByteArray(0)
                    while (true) {
                        when (entry.nextField() ?: break) {
                            1 -> key = entry.readString()
                            2 -> value = entry.readLengthDelimited()
                            else -> entry.skipValue()
                        }
                    }
                    if (key.isNotEmpty()) rawImages[key] = value
                }
                4 -> if (spriteParts.size < SvgaMovie.MAX_SPRITES) spriteParts += sprite(wire.readMessage())
                else -> wire.skipValue()
            }
        }

        if (spriteParts.isEmpty()) {
            return SvgaParseResult.Failure("movie declares no sprites")
        }
        if (width <= 0f || height <= 0f) {
            return SvgaParseResult.Failure("movie has no canvas size")
        }
        val frames = declaredFrames.coerceAtLeast(spriteParts.maxOf { it.third.size })
        if (frames <= 0) return SvgaParseResult.Failure("movie declares no frames")

        val sprites = spriteParts.map { SvgaSprite(it.first, it.third, it.second) }
        return finished(sprites, rawImages, files, width, height, fps, frames, version)
    }

    /** A `SpriteEntity`: 1 imageKey, 2 frames, 3 matteKey. */
    private fun sprite(wire: SvgaWire): Triple<String, String, MutableList<SvgaFrame>> {
        var imageKey = ""
        var matteKey = ""
        val frames = mutableListOf<SvgaFrame>()
        while (true) {
            when (val field = wire.nextField() ?: break) {
                1 -> imageKey = wire.readString()
                2 -> if (frames.size < SvgaMovie.MAX_FRAME_COUNT) frames += frame(wire.readMessage())
                3 -> matteKey = wire.readString()
                else -> wire.skipValue()
            }
        }
        return Triple(imageKey, matteKey, frames)
    }

    /** A `FrameEntity`: 1 alpha, 2 layout, 3 transform, 4 clipPath, 5 shapes. */
    private fun frame(wire: SvgaWire): SvgaFrame {
        var alpha = 1f
        var layout: SvgaLayout? = null
        var transform = SvgaTransform()
        var clipped = false
        while (true) {
            when (val field = wire.nextField() ?: break) {
                1 -> alpha = wire.readFloat()
                2 -> layout = layout(wire.readMessage())
                3 -> transform = transform(wire.readMessage())
                // The mask string is a bezier path in the exporter's own mini-language. Drawing
                // the sprite unmasked is the documented degradation, not an error.
                4 -> clipped = wire.readString().isNotEmpty()
                // Vector shapes, and anything a newer exporter adds.
                else -> wire.skipValue()
            }
        }
        return SvgaFrame(alpha, layout, transform, clipped)
    }

    private fun layout(wire: SvgaWire): SvgaLayout {
        var x = 0f
        var y = 0f
        var width = 0f
        var height = 0f
        while (true) {
            when (wire.nextField() ?: break) {
                1 -> x = wire.readFloat()
                2 -> y = wire.readFloat()
                3 -> width = wire.readFloat()
                4 -> height = wire.readFloat()
                else -> wire.skipValue()
            }
        }
        return if (width > 0f && height > 0f) SvgaLayout(x, y, width, height) else SvgaLayout(0f, 0f, 0f, 0f)
    }

    private fun transform(wire: SvgaWire): SvgaTransform {
        var a = 1f
        var b = 0f
        var c = 0f
        var d = 1f
        var tx = 0f
        var ty = 0f
        while (true) {
            when (wire.nextField() ?: break) {
                1 -> a = wire.readFloat()
                2 -> b = wire.readFloat()
                3 -> c = wire.readFloat()
                4 -> d = wire.readFloat()
                5 -> tx = wire.readFloat()
                6 -> ty = wire.readFloat()
                else -> wire.skipValue()
            }
        }
        return SvgaTransform(a, b, c, d, tx, ty)
    }

    // ---------------------------------------------------------------- json, the 1.x spec

    private fun jsonResult(text: String, files: Map<String, ByteArray>): SvgaParseResult {
        val root = runCatching { JsonParser.parseString(text).asJsonObject }.getOrNull()
            ?: return SvgaParseResult.Failure("movie.spec is not a JSON object")
        val version = root.stringAt("ver") ?: root.stringAt("version")
        // 1.1 puts the canvas in "movie"; 1.0 put it in "params". Either may be the one that has it.
        val movie = root.objectAt("movie") ?: root.objectAt("params")
        val size = movie?.objectAt("viewBox") ?: movie?.objectAt("size")
        var width = size?.numberAt("width") ?: 0f
        var height = size?.numberAt("height") ?: 0f
        if (width == 0f) width = movie?.numberAt("width") ?: root.numberAt("width") ?: 0f
        if (height == 0f) height = movie?.numberAt("height") ?: root.numberAt("height") ?: 0f
        val fps = movie?.numberAt("fps")?.toInt() ?: 0
        val declaredFrames = movie?.numberAt("frames")?.toInt() ?: 0

        // A 1.x image value names a sibling zip entry rather than holding bytes. Keeping it as UTF-8
        // bytes runs it through the same resolution rule the protobuf path uses.
        val rawImages = LinkedHashMap<String, ByteArray>()
        val imageTables = listOf(root.objectAt("images"), movie?.objectAt("images"))
        imageTables.forEach { table ->
            if (table == null) return@forEach
            table.keySet().forEach { key ->
                val value = table.stringAt(key)
                if (!value.isNullOrEmpty()) rawImages[key] = value.toByteArray(Charsets.UTF_8)
            }
        }

        val spriteNames = root.arrayAt("sprites")
        // 1.1 nests each sprite's frames under the sprite; 1.0 puts them in a movie-level array of
        // per-sprite arrays and names the sprite `name` instead of `imageKey`.
        val frameArrays = root.arrayAt("frames") ?: movie?.arrayAt("frames")
        val sprites = mutableListOf<SvgaSprite>()
        spriteNames?.forEachIndexed { index, entry ->
            val obj = entry.asObjectOrNull() ?: return@forEachIndexed
            val frames = mutableListOf<SvgaFrame>()
            obj.arrayAt("frames")?.forEach { jsonFrame ->
                if (frames.size < SvgaMovie.MAX_FRAME_COUNT) frames += jsonFrameEntity(jsonFrame)
            }
            var imageKey = obj.stringAt("imageKey") ?: obj.stringAt("name").orEmpty()
            if (frames.isEmpty()) {
                collectFrameArray(frameArrays?.getOrNull(index), frames) { imageKey = it }
            }
            sprites += SvgaSprite(imageKey, frames, obj.stringAt("matteKey").orEmpty())
        }
        // The 1.0 layout: a movie-level array of per-sprite frame arrays, indexed against
        // "sprites"[].name. The frame itself names the bitmap it paints, which is the safer key.
        if (sprites.isEmpty()) {
            frameArrays?.forEachIndexed { index, perSprite ->
                var imageKey = spriteNames?.getOrNull(index)?.asObjectOrNull()?.stringAt("name").orEmpty()
                val frames = mutableListOf<SvgaFrame>()
                collectFrameArray(perSprite, frames) { imageKey = it }
                if (frames.isNotEmpty()) sprites += SvgaSprite(imageKey, frames)
            }
        }
        if (sprites.isEmpty()) return SvgaParseResult.Failure("movie.spec describes no sprites")
        if (width <= 0f || height <= 0f) return SvgaParseResult.Failure("movie.spec has no canvas size")

        val frames = declaredFrames.coerceAtLeast(sprites.maxOf { it.frames.size })
        if (frames <= 0) return SvgaParseResult.Failure("movie.spec declares no frames")
        return finished(sprites, rawImages, files, width, height, fps, frames, version)
    }

    /**
     * One 1.0 frame array: the per-sprite list inside the movie-level `frames`. A frame that names
     * the bitmap it paints wins over the sprite table, because that is the file's own last word.
     */
    private fun collectFrameArray(
        element: JsonElement?,
        frames: MutableList<SvgaFrame>,
        onImageName: (String) -> Unit,
    ) {
        element.asArrayOrNull()?.forEach { jsonFrame ->
            if (frames.size >= SvgaMovie.MAX_FRAME_COUNT) return@forEach
            jsonFrame.asObjectOrNull()?.stringAt("image")
                ?.takeIf { it.isNotEmpty() }?.let(onImageName)
            frames += jsonFrameEntity(jsonFrame)
        }
    }

    /**
     * One JSON frame entry. `transform` and `layout` are objects of plain numbers; `alpha` may be
     * written as an int, which Gson reads as a number either way.
     */
    private fun jsonFrameEntity(element: JsonElement?): SvgaFrame {
        val obj = element.asObjectOrNull() ?: return SvgaFrame(1f, null, SvgaTransform())
        val layout = obj.objectAt("layout")?.let { l ->
            val w = l.numberAt("width") ?: 0f
            val h = l.numberAt("height") ?: 0f
            if (w > 0f && h > 0f) SvgaLayout(l.numberAt("x") ?: 0f, l.numberAt("y") ?: 0f, w, h)
            else SvgaLayout(0f, 0f, 0f, 0f)
        }
        val transform = obj.objectAt("transform").let { t ->
            SvgaTransform(
                a = t?.numberAt("a") ?: 1f,
                b = t?.numberAt("b") ?: 0f,
                c = t?.numberAt("c") ?: 0f,
                d = t?.numberAt("d") ?: 1f,
                tx = t?.numberAt("tx") ?: 0f,
                ty = t?.numberAt("ty") ?: 0f,
            )
        }
        return SvgaFrame(
            alpha = obj.numberAt("alpha") ?: 1f,
            layout = layout,
            transform = transform,
            clipped = !obj.stringAt("clipPath").isNullOrEmpty() ||
                (obj.arrayAt("clipPaths")?.isNotEmpty() == true),
        )
    }

    // ---------------------------------------------------------------- shared tail

    /**
     * Turns whatever the container offered as image references into bytes the player can decode.
     *
     * A 2.x single-file export embeds PNG/JPEG bytes under the key, so those are the value; a
     * 1.x or ZIP export stores the *name* of a sibling entry, so the value is looked up in the
     * archive. Both are the same field on the wire, which is why the sniff is on the bytes rather
     * than on the version string.
     */
    private fun finished(
        sprites: List<SvgaSprite>,
        rawImages: Map<String, ByteArray>,
        files: Map<String, ByteArray>,
        width: Float,
        height: Float,
        fps: Int,
        frames: Int,
        version: String?,
    ): SvgaParseResult {
        val resolved = LinkedHashMap<String, ByteArray>(rawImages.size)
        rawImages.forEach { (key, value) ->
            if (isImageBytes(value)) {
                resolved[key] = value
            } else {
                resolveByName(value, key, files)?.let { resolved[key] = it }
            }
        }
        if (resolved.isEmpty()) {
            return SvgaParseResult.Failure("container holds no image this movie can use")
        }
        return SvgaParseResult.Success(
            SvgaMovie(
                width = width,
                height = height,
                fps = fps.takeIf { it in 1..120 } ?: 20,
                frameCount = frames.coerceIn(1, SvgaMovie.MAX_FRAME_COUNT),
                sprites = sprites.filter { it.imageKey.isNotEmpty() },
                images = resolved,
                version = version,
            )
        )
    }

    /** `.matte` and `.vector` are layer flavours, not different bitmaps. */
    private fun bitmapKey(imageKey: String): String =
        imageKey.removeSuffix(".matte").removeSuffix(".vector")

    private fun resolveByName(
        value: ByteArray,
        key: String,
        files: Map<String, ByteArray>,
    ): ByteArray? {
        if (files.isEmpty()) return null
        val name = String(value, Charsets.UTF_8)
        if (name.isEmpty() || name.length > 512 || name.any { it == '/' || it == '\\' || it.code < 0x20 }) {
            return null
        }
        val bare = bitmapKey(key)
        val candidates = listOf(name, "$name.png", "$name.jpg", "$bare", "$bare.png", "$bare.jpg")
        for (candidate in candidates) {
            files[candidate]?.let { return it }
            files.entries.firstOrNull { (entryName, _) ->
                entryName.substringAfterLast('/') == candidate
            }?.let { return it.value }
        }
        return null
    }

    private fun isImageBytes(bytes: ByteArray): Boolean {
        if (bytes.size < 4) return false
        val b0 = bytes[0].toInt() and 0xFF
        val b1 = bytes[1].toInt() and 0xFF
        val b2 = bytes[2].toInt() and 0xFF
        val b3 = bytes[3].toInt() and 0xFF
        return b0 == 0x89 && b1 == 0x50 && b2 == 0x4E && b3 == 0x47 // PNG
            || (b0 == 0xFF && b1 == 0xD8) // JPEG
            || (b0 == 'R'.code && b1 == 'I'.code && b2 == 'F'.code && bytes.size > 11 &&
                bytes[8].toInt() == 'W'.code && bytes[9].toInt() == 'E'.code) // WEBP
    }

    // ---------------------------------------------------------------- json plumbing

    private fun JsonObject.stringAt(name: String): String? =
        member(name)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString

    private fun JsonObject.numberAt(name: String): Float? =
        member(name)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asFloat

    private fun JsonObject.objectAt(name: String): JsonObject? = member(name).asObjectOrNull()

    private fun JsonObject.arrayAt(name: String): List<JsonElement>? = member(name).asArrayOrNull()

    private fun JsonObject.member(name: String): JsonElement? = if (has(name)) get(name) else null

    private fun JsonElement?.asObjectOrNull(): JsonObject? =
        this?.takeIf { it.isJsonObject }?.asJsonObject

    private fun JsonElement?.asArrayOrNull(): List<JsonElement>? =
        this?.takeIf { it.isJsonArray }?.asJsonArray?.map { it }
}
