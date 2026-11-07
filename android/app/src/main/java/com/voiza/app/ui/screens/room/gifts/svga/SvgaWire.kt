package com.voiza.app.ui.screens.room.gifts.svga

/**
 * Raised when a byte stream stops being a well-formed protobuf message: a length that runs past
 * the buffer, a tag of zero, a group marker, a varint that never terminates.
 *
 * It is the parser's only control flow for bad input, and it never leaves the package:
 * [SvgaParser.parse] catches it at the door and turns it into a plain failure, so a truncated
 * upload reaches the gift engine as "no art available" rather than as an exception in a render
 * path. It is deliberately not an [IndexOutOfBoundsException] or a [RuntimeException] — those are
 * the things a malformed file can otherwise turn into, and both would look like an app bug.
 */
internal class SvgaParseFailure(message: String) : Exception(message)

/**
 * The whole protobuf wire format this app needs, over a fixed [ByteArray].
 *
 * An `.svga` file's `data.pb` is an ordinary proto3 message, and proto3 is four primitives: a
 * varint, a tag that packs the field number with a wire type, a length-delimited run of bytes,
 * and fixed 32/64-bit little-endian scalars. There is no schema here and no reflection — the
 * caller ([SvgaParser]) knows the field numbers from the SVGA 2.0 entity definition and asks for
 * exactly what it needs.
 *
 * Every cursor move is bounds-checked against [limit], which is what makes nested reading safe: a
 * sub-message is its own `SvgaWire` over a copied slice, so a length that lies can only ever walk
 * off its own slice and throw [SvgaParseFailure], never wander into the parent's buffer. Unknown
 * fields are skipped whole, which is the forward-compatibility rule of the format — an SVGA file
 * written by a newer exporter still opens here, and whatever this reader has never heard of is
 * ignored rather than fatal.
 */
internal class SvgaWire(
    private val bytes: ByteArray,
    start: Int = 0,
    private val limit: Int = bytes.size,
) {

    private var pos = start

    /** Wire type of the field last returned by [nextField]. */
    var wireType = -1
        private set

    /** True once the whole region has been consumed. */
    fun atEnd(): Boolean = pos >= limit

    /** Bytes still unread in this region — used to reject an over-long `length`. */
    fun remaining(): Int = limit - pos

    /**
     * Reads the next tag and returns its field number, or null when this message is finished.
     *
     * A field number of 0 is not representable in the format, so it is a corrupted stream.
     */
    fun nextField(): Int? {
        if (pos >= limit) return null
        val tag = readRawVarint()
        val field = (tag ushr 3).toInt()
        if (field == 0) throw SvgaParseFailure("field number 0 at $pos")
        wireType = (tag and 0x07).toInt()
        return field
    }

    /** A base-128 varint, at most ten bytes. */
    fun readRawVarint(): Long {
        var result = 0L
        var shift = 0
        while (true) {
            val b = readByte()
            result = result or ((b.toLong() and 0x7FL) shl shift)
            if (b and 0x80 == 0) return result
            shift += 7
            if (shift >= 64) throw SvgaParseFailure("varint longer than 64 bits")
        }
    }

    /**
     * An `int32`, whichever way the encoder chose to write it.
     *
     * The format permits both the varint encoding and a 32-bit fixed one, and negative `int32`
     * values arrive as a 64-bit all-ones-prefixed varint, so narrowing the long is the specified
     * behaviour rather than a truncation bug.
     */
    fun readInt32(): Int = when (wireType) {
        WIRE_VARINT -> readRawVarint().toInt()
        WIRE_FIXED32 -> readFixed32()
        WIRE_FIXED64 -> readFixed64().toInt()
        else -> throw SvgaParseFailure("int32 requested with wire type $wireType")
    }

    /** A `float`, also written tolerantly: some exporters put integers where the schema says float. */
    fun readFloat(): Float = when (wireType) {
        WIRE_FIXED32 -> Float.fromBits(readFixed32())
        WIRE_VARINT -> readRawVarint().toFloat()
        WIRE_FIXED64 -> readFixed64().toFloat()
        else -> throw SvgaParseFailure("float requested with wire type $wireType")
    }

    fun readFixed32(): Int {
        if (remaining() < 4) throw SvgaParseFailure("fixed32 past end")
        val v = bytes[pos].toInt() and 0xFF or
            ((bytes[pos + 1].toInt() and 0xFF) shl 8) or
            ((bytes[pos + 2].toInt() and 0xFF) shl 16) or
            ((bytes[pos + 3].toInt() and 0xFF) shl 24)
        pos += 4
        return v
    }

    fun readFixed64(): Long {
        if (remaining() < 8) throw SvgaParseFailure("fixed64 past end")
        var v = 0L
        for (i in 0 until 8) v = v or ((bytes[pos + i].toLong() and 0xFF) shl (8 * i))
        pos += 8
        return v
    }

    /** A length-delimited run: `bytes`, `string`, a sub-message, or a map entry. */
    fun readLengthDelimited(): ByteArray {
        val length = readRawVarint()
        if (length < 0 || length > remaining()) {
            throw SvgaParseFailure("length $length exceeds ${remaining()} unread bytes")
        }
        val out = ByteArray(length.toInt())
        bytes.copyInto(out, 0, pos, pos + length.toInt())
        pos += length.toInt()
        return out
    }

    fun readString(): String = String(readLengthDelimited(), Charsets.UTF_8)

    /** A nested message, as a cursor restricted to exactly its own bytes. */
    fun readMessage(): SvgaWire = SvgaWire(readLengthDelimited())

    /**
     * Walks past the current field without interpreting it, which is how an unknown field — or a
     * known one this app does not draw — is set aside.
     */
    fun skipValue() {
        when (wireType) {
            WIRE_VARINT -> readRawVarint()
            WIRE_FIXED64 -> {
                if (remaining() < 8) throw SvgaParseFailure("fixed64 past end")
                pos += 8
            }
            WIRE_LENGTH_DELIMITED -> readLengthDelimited()
            WIRE_FIXED32 -> {
                if (remaining() < 4) throw SvgaParseFailure("fixed32 past end")
                pos += 4
            }
            // Start-group / end-group belong to proto2 groups, which proto3 never emits; there is
            // no way to tell where the field ends without reading it, so this file is not ours.
            else -> throw SvgaParseFailure("unsupported wire type $wireType at $pos")
        }
    }

    private fun readByte(): Int {
        if (pos >= limit) throw SvgaParseFailure("varint runs past the end of the message")
        return bytes[pos++].toInt() and 0xFF
    }

    private companion object {
        const val WIRE_VARINT = 0
        const val WIRE_FIXED64 = 1
        const val WIRE_LENGTH_DELIMITED = 2
        const val WIRE_FIXED32 = 5
    }
}
