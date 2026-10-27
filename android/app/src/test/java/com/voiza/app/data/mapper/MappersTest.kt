package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.GiftDto
import com.voiza.app.data.remote.dto.LeaderboardResponse
import com.voiza.app.data.remote.dto.RoomDto
import com.voiza.app.data.remote.dto.SeatDto
import com.voiza.app.data.remote.dto.SeatPolicyResponse
import com.voiza.app.data.remote.dto.SocketGiftAnimatedDto
import com.voiza.app.data.remote.dto.SocketHandRaiseDto
import com.voiza.app.data.remote.dto.SocketLikeDto
import com.voiza.app.data.remote.dto.SocketRoomProfileDto
import com.voiza.app.data.remote.dto.SocketWalletUpdateDto
import com.voiza.app.domain.model.DEFAULT_AMBIENT_EFFECT
import com.voiza.app.domain.model.DEFAULT_ROOM_THEME
import com.voiza.app.domain.model.GiftEffectKind
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.RoomCategory
import com.voiza.app.domain.model.RoomStatus
import com.voiza.app.domain.model.RoomSort
import com.voiza.app.domain.model.RoomType
import com.voiza.app.domain.model.SeatPolicy
import com.voiza.app.domain.model.SeatStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The wire is JSON, not Kotlin, so these tests build DTOs with Gson exactly like
 * the Retrofit converter and the socket parser do. That matters: Gson constructs
 * a data class without running its default initialisers, so a key the backend
 * omits lands as null rather than the declared default. Every case here is a
 * shape the server really sends.
 */
class MappersTest {

    private val gson = Gson()

    private val host = """{"id":"h1","username":"host"}"""

    private fun roomJson(enums: String) =
        """{"id":"r1","roomNumber":7,"title":"T","host":$host,$enums}"""

    @Test
    fun `an unknown enum value degrades to the safe default instead of throwing`() {
        val room = gson.fromJson(
            roomJson(""""category":"PODCAST","type":"PUBLIC","status":"ACTIVE""""),
            RoomDto::class.java,
        ).toDomain()

        // A backend enum addition must not take the room list down with it.
        assertEquals(RoomCategory.PARTY, room.category)
        assertEquals(RoomType.PUBLIC, room.type)
        assertEquals(RoomStatus.ACTIVE, room.status)
    }

    @Test
    fun `enum parsing is case insensitive`() {
        val room = gson.fromJson(
            roomJson(""""category":"music","type":"private","status":"closed""""),
            RoomDto::class.java,
        ).toDomain()

        assertEquals(RoomCategory.MUSIC, room.category)
        assertEquals(RoomType.PRIVATE, room.type)
        assertEquals(RoomStatus.CLOSED, room.status)
    }

    @Test
    fun `an omitted theme falls back to the shipped wallpaper`() {
        val room = gson.fromJson(
            roomJson(""""category":"CHAT","type":"PUBLIC","status":"ACTIVE""""),
            RoomDto::class.java,
        ).toDomain()

        assertEquals(DEFAULT_ROOM_THEME, room.theme)
    }

    @Test
    fun `the room object carries no seats because the envelope owns them`() {
        val dto = gson.fromJson(
            roomJson(""""category":"CHAT","type":"PUBLIC","status":"ACTIVE""""),
            RoomDto::class.java,
        )

        // Regression guard for RoomDto.seats: it must stay `List<SeatDto>?`.
        // With a non-null default, Gson still leaves it null and the seat grid
        // mapping throws on the first room detail.
        assertNull(dto.seats)
        assertEquals(emptyList<SeatDto>(), dto.toDomain().seats)
    }

    @Test
    fun `a seat status the client does not know reads as empty`() {
        val seat = gson.fromJson(
            """{"seatIndex":2,"status":"RESERVED","user":null}""",
            SeatDto::class.java,
        ).toDomain()

        assertEquals(SeatStatus.EMPTY, seat.status)
        assertNull(seat.user)
        // A boolean key the server omits must not arrive as "true".
        assertFalse(seat.isMuted)
    }

    @Test
    fun `a hand raise without a user is dropped instead of mapped to a phantom`() {
        val withUser = gson.fromJson(
            """{"roomId":"r1","raised":true,"user":{"id":"u2","username":"ana"}}""",
            SocketHandRaiseDto::class.java,
        ).toDomainOrNull()

        assertEquals("u2", withUser?.user?.id)
        assertEquals(true, withUser?.raised)

        val withoutUser = gson.fromJson(
            """{"roomId":"r1","raised":true}""",
            SocketHandRaiseDto::class.java,
        ).toDomainOrNull()

        assertNull(withoutUser)
    }

    @Test
    fun `gift sound url and vip tier survive the mapping`() {
        val gift = gson.fromJson(
            """{"id":"g9","name":"Castle","iconUrl":"/gifts/castle.png",
               "soundUrl":"/gifts/sounds/fanfare.wav","diamondPrice":5000,"rCoinValue":4500,
               "category":"LUXURY","minVipLevel":8}""",
            GiftDto::class.java,
        ).toDomain()

        assertEquals("/gifts/sounds/fanfare.wav", gift.soundUrl)
        assertEquals(8, gift.minVipLevel)
    }

    @Test
    fun `a gift echo without sound or animation keys maps to a silent overlay`() {
        val event = gson.fromJson(
            """{"roomId":"r1","quantity":3,"totalDiamonds":30,"totalRCoins":30,"seatIndex":0,
               "gift":{"id":"g1","name":"Rose","iconUrl":"/gifts/rose.png",
                        "diamondPrice":10,"rCoinValue":9,"category":"ROSE"},
               "sender":{"id":"u1","username":"sender"},
               "receiver":{"id":"u2","username":"receiver"}}""",
            SocketGiftAnimatedDto::class.java,
        ).toDomain()

        // GiftEffectOverlay reads a null animation as "use the Compose fallback"
        // and GiftSoundPlayer reads a null sound as silence — neither may throw.
        assertNull(event.gift.soundUrl)
        assertNull(event.animationUrl)
        assertEquals(3, event.quantity)
        assertEquals(30L, event.totalDiamonds)
    }

    @Test
    fun `a wallet update names only the balance it changed`() {
        // WalletRepositoryImpl merges this over the cached user; a missing key must
        // stay null so a gift sender never reads their R-coin balance as zero.
        val diamonds = gson.fromJson("""{"diamondBalance":400}""", SocketWalletUpdateDto::class.java)
        val rCoins = gson.fromJson("""{"rCoinBalance":120}""", SocketWalletUpdateDto::class.java)

        assertEquals(400, diamonds.diamondBalance)
        assertNull(diamonds.rCoinBalance)
        assertEquals(120, rCoins.rCoinBalance)
        assertNull(rCoins.diamondBalance)
    }

    @Test
    fun `a gift with no tier set plays in the ticker, not over the room`() {
        val gift = gson.fromJson(
            """{"id":"g1","name":"Rose","iconUrl":"/gifts/rose.png",
               "diamondPrice":10,"rCoinValue":9,"category":"ROSE"}""",
            GiftDto::class.java,
        ).toDomain()

        // A gift an operator has not ruled on must not be able to blind the room.
        assertEquals(GiftEffectKind.TICKER, gift.effectKind)
        assertEquals(0, gift.sortOrder)

        val ruled = gson.fromJson(
            """{"id":"g9","name":"Castle","iconUrl":"/gifts/castle.png","diamondPrice":5000,
               "rCoinValue":4500,"category":"LUXURY","sortOrder":80,"effectKind":"FULLSCREEN"}""",
            GiftDto::class.java,
        ).toDomain()
        assertEquals(GiftEffectKind.FULLSCREEN, ruled.effectKind)
        assertEquals(80, ruled.sortOrder)

        val misspelled = gson.fromJson(
            """{"id":"g7","name":"Ring","iconUrl":"/gifts/ring.png","diamondPrice":100,
               "rCoinValue":90,"category":"SPECIAL","effectKind":"SUPERNOVA"}""",
            GiftDto::class.java,
        ).toDomain()
        assertEquals(GiftEffectKind.TICKER, misspelled.effectKind)
    }

    @Test
    fun `a room carries the ambient loop and like count the server chose`() {
        val room = gson.fromJson(
            """{"id":"r1","roomNumber":7,"title":"T","host":$host,
               "category":"PARTY","type":"PUBLIC","status":"ACTIVE",
               "ambientEffect":"/effects/room-confetti.json","likeCount":420}""",
            RoomDto::class.java,
        ).toDomain()

        assertEquals("/effects/room-confetti.json", room.ambientEffect)
        assertEquals(420L, room.likeCount)
    }

    @Test
    fun `a room without an ambient key still has a loop to play`() {
        val room = gson.fromJson(
            roomJson(""""category":"CHAT","type":"PUBLIC","status":"ACTIVE""""),
            RoomDto::class.java,
        ).toDomain()

        // The join response is what sizes the effect layer; a missing key may not
        // leave the room with nothing to render.
        assertEquals(DEFAULT_AMBIENT_EFFECT, room.ambientEffect)
        assertEquals(0L, room.likeCount)
    }

    @Test
    fun `a like batch keeps the server total and may name nobody`() {
        val withUser = gson.fromJson(
            """{"roomId":"r1","count":12,"total":980,
               "user":{"id":"u1","username":"ana"}}""",
            SocketLikeDto::class.java,
        ).toDomain()

        assertEquals(12, withUser.count)
        assertEquals(980L, withUser.total)
        assertEquals("u1", withUser.user?.id)

        // The room-wide batch is broadcast without an instigator.
        val anonymous = gson.fromJson(
            """{"roomId":"r1","count":3,"total":983}""",
            SocketLikeDto::class.java,
        ).toDomain()
        assertNull(anonymous.user)
        assertEquals(3, anonymous.count)
    }

    @Test
    fun `the leaderboard names its board and survives an empty page`() {
        val senders = gson.fromJson(
            """{"window":"day","role":"senders","unit":"diamond",
               "leaders":[{"id":"u1","username":"ana","avatarUrl":null,"earned":5000},
                          {"id":"u2","username":"bo"}]}""",
            LeaderboardResponse::class.java,
        ).toDomain()

        assertEquals(RankBoard.SENDERS, senders.board)
        assertEquals("day", senders.window)
        assertEquals(5000L, senders.rows.first().earned)
        // `earned` is absent for u2: Gson leaves it null, the mapper reads zero.
        assertEquals(0L, senders.rows.last().earned)

        val empty = gson.fromJson("""{"window":"week"}""", LeaderboardResponse::class.java).toDomain()
        assertEquals(RankBoard.RECEIVERS, empty.board)
        assertEquals("week", empty.window)
        assertTrue(empty.rows.isEmpty())
    }

    @Test
    fun `the seat policy carries the server's own bounds, keyed under a Kotlin-safe name`() {
        val response = gson.fromJson(
            """{"seatCapacity":{"min":2,"default":16,"max":33},"speakerSeats":15,"maxSpeakerSeats":32}""",
            SeatPolicyResponse::class.java,
        )
        val policy = response.seatCapacity.toDomain()

        // `default` is a keyword, so the DTO holds it as defaultCapacity.
        assertEquals(2, policy.minSeats)
        assertEquals(16, policy.defaultSeats)
        assertEquals(33, policy.maxSeats)
        assertTrue(policy.isUsable)
        // Seat 0 is the host seat: the room is one seat larger than the speaker number.
        assertEquals(response.speakerSeats + 1, policy.defaultSeats)
        assertEquals(response.maxSpeakerSeats + 1, policy.maxSeats)
    }

    @Test
    fun `a policy that cannot describe a room is unusable, so the form sends no capacity`() {
        assertFalse(SeatPolicy(minSeats = 0, defaultSeats = 0, maxSeats = 0).isUsable)
        // An empty range is worse than none: the slider would have nothing to sit on.
        assertFalse(SeatPolicy(minSeats = 2, defaultSeats = 1, maxSeats = 2).isUsable)
        assertFalse(SeatPolicy(minSeats = 2, defaultSeats = 40, maxSeats = 33).isUsable)
    }

    @Test
    fun `a room's seat count is what the server said, never a client default`() {
        val room = gson.fromJson(
            roomJson(""""category":"CHAT","type":"PUBLIC","status":"ACTIVE","seatCapacity":21"""),
            RoomDto::class.java,
        ).toDomain()

        // 21 seats is only possible because the administrator raised the policy; the client shows
        // the room it was told about instead of clipping it back to the old 3x3 grid.
        assertEquals(21, room.seatCapacity)
        // The `room` object has no seats of its own — the grid is the envelope's sibling key.
        assertTrue(room.seats.isEmpty())
    }

    @Test
    fun `the host's language, region and rules survive the mapping`() {
        val room = gson.fromJson(
            """{"id":"r1","roomNumber":7,"title":"T","host":$host,
               "category":"MUSIC","type":"PUBLIC","status":"ACTIVE",
               "language":"en-BD","region":"BD","rules":"mic off when not on the seat"}""",
            RoomDto::class.java,
        ).toDomain()

        assertEquals("en-BD", room.language)
        assertEquals("BD", room.region)
        assertEquals("mic off when not on the seat", room.rules)
    }

    @Test
    fun `a room whose host never stated a language reads as nothing, not as a guess`() {
        val room = gson.fromJson(
            roomJson(""""category":"CHAT","type":"PUBLIC","status":"ACTIVE""""),
            RoomDto::class.java,
        ).toDomain()

        // The server sends null for "not said"; the lobby must then show no tag rather than
        // inventing one, and must not treat an absent key as the string "null".
        assertNull(room.language)
        assertNull(room.region)
        assertNull(room.rules)
    }

    @Test
    fun `a profile edit broadcast is the room's new state, cleared fields and all`() {
        val event = gson.fromJson(
            """{"roomId":"r1","title":"Renamed","description":null,"category":"MUSIC",
               "language":"en","region":null,"rules":"be kind"}""",
            SocketRoomProfileDto::class.java,
        ).toDomain()

        assertEquals("Renamed", event.title)
        assertEquals(RoomCategory.MUSIC, event.category)
        assertEquals("en", event.language)
        assertEquals("be kind", event.rules)
        // An explicit null is the host clearing that field, so the screen must blank it.
        assertNull(event.description)
        assertNull(event.region)
    }

    @Test
    fun `a category the build does not know in a profile edit does not crash the room`() {
        val event = gson.fromJson(
            """{"roomId":"r1","title":"T","category":"PODCAST","language":null,"region":null}""",
            SocketRoomProfileDto::class.java,
        ).toDomain()

        assertEquals(RoomCategory.PARTY, event.category)
    }

    @Test
    fun `the default sort sends no parameter so the server keeps its own ordering`() {
        // "Default" exists precisely so the lobby can decline to pick an ordering.
        assertNull(RoomSort.DEFAULT.apiValue)
        assertEquals("trending", RoomSort.TRENDING.apiValue)
        assertEquals("recent", RoomSort.RECENT.apiValue)
        assertEquals("popular", RoomSort.POPULAR.apiValue)
    }
}
