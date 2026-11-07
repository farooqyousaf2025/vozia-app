package com.voiza.app.ui.screens.room.gifts.svga

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The protobuf reader, tested against the wire format's own rules.
 *
 * Every expectation here is written as literal bytes with the field number and wire type spelled
 * out in a comment, because the reader's contract is the encoding and nothing else.
 */
class SvgaWireTest {

    // -------------------------------------------------------------- varints

    @Test
    fun `single byte varints cover zero to one twenty seven`() {
        // 0x00 = 0, 0x01 = 1, 0x7F = 127: the whole one-byte range, continuation bit clear.
        assertEquals(0L, SvgaWire(byteArrayOf(0x00)).readRawVarint())
        assertEquals(1L, SvgaWire(byteArrayOf(0x01)).readRawVarint())
        assertEquals(127L, SvgaWire(byteArrayOf(0x7F)).readRawVarint())
    }

    @Test
    fun `two byte varint starts at one twenty eight`() {
        // 128 = low 7 bits 0x00 with continuation, then 0x01.
        assertEquals(128L, SvgaWire(byteArrayOf(0x80.toByte(), 0x01)).readRawVarint())
        // 300 = 0xAC 0x02
        assertEquals(300L, SvgaWire(byteArrayOf(0xAC.toByte(), 0x02)).readRawVarint())
    }

    @Test
    fun `three byte varint boundary`() {
        // 16383 is the last three-bit-group value that fits two bytes; 16384 needs three.
        assertEquals(16383L, SvgaWire(byteArrayOf(0xFF.toByte(), 0x7F)).readRawVarint())
        assertEquals(16384L, SvgaWire(byteArrayOf(0x80.toByte(), 0x80.toByte(), 0x01)).readRawVarint())
    }

    @Test
    fun `ten byte varint reaches the full sixty four bit range`() {
        // -1 is all sixty-four bits set: nine full groups of seven, and a tenth carrying only the
        // sign bit. A tenth byte of 0x7F would shift into nothing and set every bit instead.
        val minusOne = ByteArray(9) { 0xFF.toByte() } + byteArrayOf(0x01)
        assertEquals(-1L, SvgaWire(minusOne).readRawVarint())
        // Long.MAX_VALUE is the same nine full groups with the sign bit clear, so the tenth byte is 0.
        val max = ByteArray(9) { 0xFF.toByte() } + byteArrayOf(0x00)
        assertEquals(Long.MAX_VALUE, SvgaWire(max).readRawVarint())
    }

    @Test
    fun `a negative int thirty two is read by narrowing the ten byte varint`() {
        // int32 -1 is written as the 64-bit sign-extended value; narrowing is the spec's answer.
        val bytes = ByteArray(9) { 0xFF.toByte() } + byteArrayOf(0x01)
        assertEquals(-1, SvgaWire(bytes).readRawVarint().toInt())
    }

    @Test(expected = SvgaParseFailure::class)
    fun `a varint longer than ten bytes is rejected instead of wrapping`() {
        SvgaWire(ByteArray(11) { 0xFF.toByte() }).readRawVarint()
    }

    @Test(expected = SvgaParseFailure::class)
    fun `a varint whose continuation bit runs off the end is rejected`() {
        SvgaWire(byteArrayOf(0x80.toByte(), 0x80.toByte())).readRawVarint()
    }

    // -------------------------------------------------------------- tags

    @Test
    fun `a tag splits into field number and wire type`() {
        val wire = SvgaWire(byteArrayOf(0x0D, 0x00, 0x00, 0xC8.toByte(), 0x43))
        assertEquals(1, wire.nextField())
        assertEquals(5, wire.wireType)
        assertEquals(400.0f, wire.readFloat(), 0f)
        assertNull(wire.nextField())
        assertTrue(wire.atEnd())
    }

    @Test
    fun `a high field number survives a two byte tag`() {
        // field 200, wire type 0 => tag varint (200 shl 3) = 1600 = low group 64, high group 12.
        val wire = SvgaWire(byteArrayOf(0xC0.toByte(), 0x0C, 0x2A))
        assertEquals(200, wire.nextField())
        assertEquals(0, wire.wireType)
        assertEquals(42L, wire.readRawVarint())
    }

    @Test(expected = SvgaParseFailure::class)
    fun `field number zero is not a message`() {
        // 0x00 would be field 0 wire type 0, which proto3 cannot emit.
        SvgaWire(byteArrayOf(0x00)).nextField()
    }

    // -------------------------------------------------------------- scalars, tolerantly

    @Test
    fun `an int thirty two written as fixed thirty two is still read`() {
        val wire = SvgaWire(byteArrayOf(0x15, 0x2A, 0x00, 0x00, 0x00))
        wire.nextField()
        assertEquals(5, wire.wireType)
        assertEquals(42, wire.readInt32())
    }

    @Test
    fun `a float written as a varint is read as that integer`() {
        // Some exporters round a whole-number scale factor into a varint.
        val wire = SvgaWire(byteArrayOf(0x08, 0x02))
        wire.nextField()
        assertEquals(0, wire.wireType)
        assertEquals(2.0f, wire.readFloat(), 0f)
    }

    @Test
    fun `fixed thirty two is little endian`() {
        // 1.0f is 0x3F800000, on the wire as 00 00 80 3F.
        val wire = SvgaWire(byteArrayOf(0x0D, 0x00, 0x00, 0x80.toByte(), 0x3F))
        wire.nextField()
        assertEquals(1.0f, wire.readFloat(), 0f)
    }

    @Test
    fun `fixed sixty four is little endian`() {
        val wire = SvgaWire(byteArrayOf(0x09, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00))
        wire.nextField()
        assertEquals(1, wire.readFixed64())
    }

    @Test(expected = SvgaParseFailure::class)
    fun `a scalar asked for with the wrong wire type is a failure`() {
        val wire = SvgaWire(byteArrayOf(0x0A, 0x01, 0x41)) // field 1, length-delimited
        wire.nextField()
        wire.readInt32()
    }

    // -------------------------------------------------------------- length-delimited

    @Test
    fun `a multi byte length prefix is honoured`() {
        // 300 unread bytes behind a two-byte length varint of 0xAC 0x02.
        val payload = ByteArray(300) { (it % 7).toByte() }
        val message = byteArrayOf(0x1A.toByte(), 0xAC.toByte(), 0x02) + payload
        val wire = SvgaWire(message)
        assertEquals(3, wire.nextField())
        assertEquals(payload.toList(), wire.readLengthDelimited().toList())
    }

    @Test
    fun `a sub message is a cursor over exactly its own bytes`() {
        // field 2, length 2, holding field 1 (varint) = 7.
        val wire = SvgaWire(byteArrayOf(0x12, 0x02, 0x08, 0x07, 0x99.toByte()))
        wire.nextField()
        val nested = wire.readMessage()
        assertEquals(1, nested.nextField())
        assertEquals(7L, nested.readRawVarint())
        // The trailing 0x99 belongs to nobody: the nested cursor is finished at its own length.
        assertNull(nested.nextField())
        assertTrue(nested.remaining() < wire.remaining())
    }

    @Test(expected = SvgaParseFailure::class)
    fun `a length that runs past the buffer is rejected`() {
        SvgaWire(byteArrayOf(0x1A, 0x7F, 0x01, 0x02)).readLengthDelimited()
    }

    @Test(expected = SvgaParseFailure::class)
    fun `a negative length is rejected`() {
        // A ten-byte length varint can encode -1; that is not a slice anyone should copy.
        val message = byteArrayOf(0x1A) + ByteArray(9) { 0xFF.toByte() } + byteArrayOf(0x01)
        SvgaWire(message).readLengthDelimited()
    }

    @Test(expected = SvgaParseFailure::class)
    fun `a truncated fixed sixty four is rejected`() {
        val wire = SvgaWire(byteArrayOf(0x09, 0x01, 0x02))
        wire.nextField()
        wire.readFixed64()
    }

    // -------------------------------------------------------------- skipping

    @Test
    fun `unknown fields of every supported wire type are walked past`() {
        val message = byteArrayOf(
            0x38.toByte(), 0x64,               // field 7 varint 100
            0x42.toByte(), 0x03, 0x01, 0x02, 0x03, // field 8 bytes(3)
            0x4D, 0x00, 0x00, 0x80.toByte(), 0x3F,      // field 9 fixed32
            0x51, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // field 10 fixed64
            0x08.toByte(), 0x01,               // field 1 varint 1, the one we care about
        )
        val wire = SvgaWire(message)
        val seen = mutableListOf<Int>()
        while (true) {
            val field = wire.nextField() ?: break
            seen += field
            if (field == 1) assertEquals(1L, wire.readRawVarint()) else wire.skipValue()
        }
        assertEquals(listOf(7, 8, 9, 10, 1), seen)
    }

    @Test(expected = SvgaParseFailure::class)
    fun `a group marker is refused rather than guessed at`() {
        // Wire type 3 (start group) has no length to skip by; proto3 never emits it.
        val wire = SvgaWire(byteArrayOf(0x0B, 0x08, 0x01, 0x0C))
        wire.nextField()
        wire.skipValue()
    }

    @Test(expected = SvgaParseFailure::class)
    fun `a group end marker is refused too`() {
        val wire = SvgaWire(byteArrayOf(0x0C))
        wire.nextField()
        wire.skipValue()
    }
}
