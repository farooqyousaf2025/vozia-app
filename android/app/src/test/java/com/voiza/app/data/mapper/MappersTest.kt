package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.EmojiCatalogueDto
import com.voiza.app.data.remote.dto.GiftDto
import com.voiza.app.data.remote.dto.LeaderboardResponse
import com.voiza.app.data.remote.dto.MiniUserDto
import com.voiza.app.data.remote.dto.RoomDto
import com.voiza.app.data.remote.dto.SeatDto
import com.voiza.app.data.remote.dto.SeatPolicyResponse
import com.voiza.app.data.remote.dto.SocketGiftAnimatedDto
import com.voiza.app.data.remote.dto.SocketHandRaiseDto
import com.voiza.app.data.remote.dto.SocketLikeDto
import com.voiza.app.data.remote.dto.SocketRoomProfileDto
import com.voiza.app.data.remote.dto.SocketWalletUpdateDto
import com.voiza.app.data.remote.dto.StorePurchaseResponse
import com.voiza.app.data.remote.dto.StoreResponse
import com.voiza.app.data.remote.dto.ThemeCatalogueDto
import com.voiza.app.data.remote.dto.UserDto
import com.voiza.app.domain.model.DEFAULT_AMBIENT_EFFECT
import com.voiza.app.domain.model.DEFAULT_ROOM_THEME
import com.voiza.app.domain.model.FALLBACK_EMOJI_CODE_PATTERN
import com.voiza.app.domain.model.GiftEffectKind
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.RoomCategory
import com.voiza.app.domain.model.RoomStatus
import com.voiza.app.domain.model.RoomSort
import com.voiza.app.domain.model.RoomType
import com.voiza.app.domain.model.SeatPolicy
import com.voiza.app.domain.model.SeatStatus
import com.voiza.app.domain.model.StoreItemKind
import com.voiza.app.domain.model.UserRank
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
    fun `the room carries the wallpaper url the server resolved`() {
        val room = gson.fromJson(
            """{"id":"r1","roomNumber":7,"title":"T","host":$host,
               "category":"PARTY","type":"PUBLIC","status":"ACTIVE",
               "theme":"nebula","themeWallpaper":"/uploads/3f9c.png"}""",
            RoomDto::class.java,
        ).toDomain()

        // Operator art lives in the upload store, so the only correct wallpaper the
        // client can draw is the one the API named.
        assertEquals("/uploads/3f9c.png", room.themeWallpaper)
    }

    @Test
    fun `a room with no wallpaper key draws nothing instead of a guessed path`() {
        val room = gson.fromJson(
            roomJson(""""category":"CHAT","type":"PUBLIC","status":"ACTIVE","theme":"aurora""""),
            RoomDto::class.java,
        ).toDomain()

        assertNull(room.themeWallpaper)
        assertEquals("aurora", room.theme)
    }

    @Test
    fun `the published theme catalogue keeps its urls and the welcome loop`() {
        val catalogue = gson.fromJson(
            """{"themes":[{"slug":"aurora","name":"Aurora","accent":"#3ddc97",
                           "wallpaper":"/themes/aurora/wallpaper.png"},
                          {"slug":"neon","name":"Neon","accent":"#ff00aa",
                           "wallpaper":"/uploads/neon.png"}],
               "defaultTheme":"neon","welcome":"/welcome.json","effects":["/effects/room-glow.json"]}""",
            ThemeCatalogueDto::class.java,
        ).toDomain()

        assertEquals("neon", catalogue.defaultTheme)
        assertEquals("/welcome.json", catalogue.welcome)
        assertEquals(2, catalogue.themes.size)
        assertEquals("/uploads/neon.png", catalogue.themes[1].wallpaper)
        assertEquals("#ff00aa", catalogue.themes[1].accent)
    }

    @Test
    fun `a catalogue from an older backend still names a default and no welcome`() {
        val catalogue = gson.fromJson(
            """{"themes":[{"slug":"aurora","name":"Aurora","accent":"#3ddc97",
                           "wallpaper":"/themes/aurora/wallpaper.png"}]}""",
            ThemeCatalogueDto::class.java,
        ).toDomain()

        // A blank default would make the room settings form open on nothing selected.
        assertEquals(DEFAULT_ROOM_THEME, catalogue.defaultTheme)
        assertNull(catalogue.welcome)
    }

    @Test
    fun `the emoji catalogue keeps the server token and the art url`() {
        val catalogue = gson.fromJson(
            """{"codePattern":"\\[[a-z0-9][a-z0-9-]{0,31}\\]","emojis":[
                 {"key":"smile","label":"Smile","code":"[smile]","url":"/emoji/smile.webp"},
                 {"key":"heart_eyes","label":"Heart eyes","code":"[heart_eyes]","url":"https://cdn/heart.webp"}]}""",
            EmojiCatalogueDto::class.java,
        ).toDomain()

        assertEquals(2, catalogue.emojis.size)
        // A chat row stores the token, so the client must send and match the server's own spelling.
        assertEquals("[heart_eyes]", catalogue.emojis[1].code)
        assertEquals("https://cdn/heart.webp", catalogue.emojis[1].url)
        assertEquals("\\[[a-z0-9][a-z0-9-]{0,31}\\]", catalogue.codePattern)
        assertTrue(Regex(catalogue.codePattern).matches("[smile]"))
    }

    @Test
    fun `an emoji row with no art is dropped rather than shown blank`() {
        val catalogue = gson.fromJson(
            """{"emojis":[{"key":"gone","label":"Gone","code":"[gone]","url":""},
                          {"key":"ok","label":"Ok","code":"[ok]","url":"/emoji/ok.webp"}]}""",
            EmojiCatalogueDto::class.java,
        ).toDomain()

        // The picker would offer a tile with nothing in it, and no message could ever match it.
        assertEquals(1, catalogue.emojis.size)
        assertEquals("[ok]", catalogue.emojis[0].code)
    }

    @Test
    fun `a missing label falls back to the key and a missing code is spelled from it`() {
        val option = gson.fromJson(
            """{"emojis":[{"key":"tongue","url":"/emoji/tongue.webp"}]}""",
            EmojiCatalogueDto::class.java,
        ).toDomain().emojis.single()

        assertEquals("[tongue]", option.code)
        assertEquals("tongue", option.label)
    }

    @Test
    fun `an unusable or absent code pattern falls back, never crashes a bubble`() {
        val older = gson.fromJson("""{"emojis":[]}""", EmojiCatalogueDto::class.java).toDomain()
        assertEquals(FALLBACK_EMOJI_CODE_PATTERN, older.codePattern)

        // Regex() throws on a bad pattern, and every chat bubble builds one from this string.
        val broken = gson.fromJson(
            """{"codePattern":"[unclosed","emojis":[]}""", EmojiCatalogueDto::class.java,
        ).toDomain()
        assertEquals(FALLBACK_EMOJI_CODE_PATTERN, broken.codePattern)
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

    @Test
    fun `the rung the server resolved arrives as name art and colour`() {
        // Exactly what toMiniUser() emits for room:user_joined, which does read users.xp.
        val user = gson.fromJson(
            """{"id":"u1","username":"ana","vipLevel":2,
               "rank":{"level":9,"name":"Gold III","badge":"/badges/level-9.png","accent":"#ecbc58"}}""",
            MiniUserDto::class.java,
        ).toDomain()

        assertEquals(9, user.rank?.level)
        assertEquals("Gold III", user.rank?.name)
        assertEquals("/badges/level-9.png", user.rank?.badge)
        assertEquals("#ecbc58", user.rank?.accent)
        // The spend tier is still its own thing: the ladder never replaces it.
        assertEquals(2, user.vipLevel)
    }

    @Test
    fun `a lean payload that ships no rank leaves it absent instead of inventing level zero`() {
        // fetchAudience() and the seat list select neither xp nor rank.
        val seat = gson.fromJson(
            """{"seatIndex":3,"status":"OCCUPIED","isMuted":false,"isSpeaker":true,
               "user":{"id":"u1","username":"ana"}}""",
            SeatDto::class.java,
        ).toDomain()

        assertNull(seat.user?.rank)
    }

    @Test
    fun `a rung with no name is dropped because the app must not label a ladder rung`() {
        val user = gson.fromJson(
            """{"id":"u1","username":"ana","rank":{"level":4,"badge":"/badges/level-4.png","accent":"#fff"}}""",
            MiniUserDto::class.java,
        ).toDomain()

        assertNull(user.rank)
    }

    @Test
    fun `the signed-in account carries its experience and rung from the server`() {
        val account = gson.fromJson(
            """{"id":"u1","phone":"+1","username":"ana","diamondBalance":10,"rCoinBalance":0,
               "totalGiftsSent":0,"totalGiftsReceived":0,"userType":"USER","status":"ACTIVE",
               "isVerified":false,"vipLevel":0,"xp":30500,
               "rank":{"level":9,"name":"Gold III","badge":"/uploads/b.png","accent":"#ecbc58"},
               "nextRank":{"level":10,"name":"Platinum I","remainingXp":9500}}""",
            UserDto::class.java,
        ).toDomain()

        assertEquals(30500L, account.xp)
        assertEquals(UserRank(9, "Gold III", "/uploads/b.png", "#ecbc58"), account.rank)
    }

    @Test
    fun `an old server without the rank fields still deserialises the account`() {
        // Gson writes a missing xp key as zero on the primitive, and null on the object.
        val account = gson.fromJson(
            """{"id":"u1","phone":"+1","username":"ana","diamondBalance":10,"rCoinBalance":0,
               "totalGiftsSent":0,"totalGiftsReceived":0,"userType":"USER","status":"ACTIVE",
               "isVerified":false,"vipLevel":0}""",
            UserDto::class.java,
        ).toDomain()

        assertEquals(0L, account.xp)
        assertNull(account.rank)
    }

    @Test
    fun `a leaderboard row shows the rung each earner holds`() {
        val board = gson.fromJson(
            """{"window":"week","role":"senders","unit":"diamond",
               "leaders":[{"id":"u1","username":"ana","avatarUrl":null,"earned":5000,
                           "rank":{"level":12,"name":"Platinum III","badge":"/badges/level-12.png","accent":"#9fd8ff"}}]}""",
            LeaderboardResponse::class.java,
        ).toDomain()

        val row = board.rows.single()
        assertEquals("Platinum III", row.user.rank?.name)
        assertEquals("/badges/level-12.png", row.user.rank?.badge)
        assertEquals(5000L, row.earned)
    }

    @Test
    fun `a seat user ships the ring and flourish the server resolved for them`() {
        // fetchMiniUser() joins the worn columns, so a room draws what the member paid for.
        val user = gson.fromJson(
            """{"id":"u1","username":"ana",
               "profileFrame":{"key":"ring-gold","name":"Gold ring",
                               "art":"/frames/trace/frame-3.png","accent":"#ecbc58"},
               "entryEffect":"/effects/welcome-hearts.json"}""",
            MiniUserDto::class.java,
        ).toDomain()

        assertEquals("ring-gold", user.profileFrame?.key)
        assertEquals("/frames/trace/frame-3.png", user.profileFrame?.art)
        assertEquals("#ecbc58", user.profileFrame?.accent)
        assertEquals("/effects/welcome-hearts.json", user.entryEffect)
    }

    @Test
    fun `a ring with no art or a blank flourish leaves the avatar plain`() {
        val user = gson.fromJson(
            """{"id":"u2","username":"bo","profileFrame":{"key":"broken","art":""},
               "entryEffect":"  "}""",
            MiniUserDto::class.java,
        ).toDomain()

        // Drawing a frame with no PNG would add an invisible overlay and shrink the face for
        // nothing; a blank URL must read as "wears none", not as the empty string.
        assertNull(user.profileFrame)
        assertNull(user.entryEffect)
    }

    @Test
    fun `the account carries the ring and flourish that are actually worn`() {
        val account = gson.fromJson(
            """{"id":"u1","phone":"+1","username":"ana","diamondBalance":10,"rCoinBalance":0,
               "totalGiftsSent":0,"totalGiftsReceived":0,"userType":"USER","status":"ACTIVE",
               "isVerified":false,"vipLevel":0,
               "profileFrame":{"key":"ring-immortal","name":"Immortal",
                               "art":"/frames/trace/frame-10.png","accent":"#ff6ec7"},
               "entryEffect":"/effects/welcome-spectrum.json"}""",
            UserDto::class.java,
        ).toDomain()

        assertEquals("ring-immortal", account.profileFrame?.key)
        assertEquals("Immortal", account.profileFrame?.name)
        assertEquals("/effects/welcome-spectrum.json", account.entryEffect)
    }

    @Test
    fun `the store catalogue keeps prices, periods and the caller's own marks`() {
        val store = gson.fromJson(
            """{"items":[
                 {"kind":"FRAME","key":"ring-gold","name":"Gold ring",
                  "art":"/frames/trace/frame-3.png","accent":"#ecbc58","priceDiamonds":300,
                  "periodDays":30,"owned":true,"expiresAt":"2026-11-27T10:00:00.000Z","equipped":true},
                 {"kind":"THEME","key":"nebula","name":"Nebula",
                  "art":"/themes/nebula/wallpaper.png","accent":"#b02fd6","priceDiamonds":1500,
                  "periodDays":30},
                 {"kind":"EFFECT","key":"welcome-hearts","name":"Hearts",
                  "art":"/effects/welcome-hearts.json","priceDiamonds":1200,"periodDays":null}],
               "owned":[
                 {"kind":"FRAME","key":"ring-gold","name":"Gold ring",
                  "art":"/frames/trace/frame-3.png","onSale":true,
                  "expiresAt":"2026-11-27T10:00:00.000Z","acquiredVia":"PURCHASE"},
                 {"kind":"THEME","key":"retired-aurora","name":"Old Aurora","art":"",
                  "onSale":false,"expiresAt":null,"acquiredVia":"ADMIN_GRANT"}]}""",
            StoreResponse::class.java,
        ).toDomain()

        assertEquals(3, store.items.size)
        val gold = store.itemsOf(StoreItemKind.FRAME).single()
        assertEquals(300, gold.priceDiamonds)
        assertEquals(30, gold.periodDays)
        assertTrue(gold.owned)
        assertTrue(gold.equipped)

        // Absent booleans and a null period are meaningful: not owned, and permanent.
        val hearts = store.itemsOf(StoreItemKind.EFFECT).single()
        assertFalse(hearts.owned)
        assertFalse(hearts.equipped)
        assertNull(hearts.periodDays)
        assertNull(hearts.expiresAt)

        // A theme is worn by a room, so the shop never marks it as worn by the account.
        assertFalse(store.itemsOf(StoreItemKind.THEME).single().equipped)

        // The receipt survives the operator retiring the row: it is still the member's.
        val retired = store.owned.last()
        assertFalse(retired.onSale)
        assertEquals("ADMIN_GRANT", retired.acquiredVia)
        assertNull(retired.expiresAt)
    }

    @Test
    fun `a store row of a kind this build does not know is dropped`() {
        val store = gson.fromJson(
            """{"items":[
                 {"kind":"STICKER","key":"wave","name":"Wave","art":"/stickers/wave.png",
                  "priceDiamonds":50,"periodDays":7},
                 {"kind":"EFFECT","key":"welcome","name":"Welcome",
                  "art":"/effects/welcome.json","priceDiamonds":800,"periodDays":null}]}""",
            StoreResponse::class.java,
        ).toDomain()

        // A backend may add a fourth catalogue; that row must not crash or render as a blank card.
        assertEquals(1, store.items.size)
        assertEquals(StoreItemKind.EFFECT, store.items.single().kind)
        assertTrue(store.owned.isEmpty())
    }

    @Test
    fun `a purchase response maps the wallet the ledger debited`() {
        val purchase = gson.fromJson(
            """{"item":{"kind":"FRAME","key":"ring-gold","name":"Gold ring",
                        "art":"/frames/trace/frame-3.png","accent":"#ecbc58","priceDiamonds":300,
                        "periodDays":30,"owned":true,"expiresAt":"2026-11-27T10:00:00.000Z"},
               "wallet":{"id":"u1","phone":"+1","username":"ana","diamondBalance":700,
                         "rCoinBalance":40,"totalGiftsSent":0,"totalGiftsReceived":0,
                         "userType":"USER","status":"ACTIVE","isVerified":false,"vipLevel":0}}""",
            StorePurchaseResponse::class.java,
        ).toDomain()

        assertTrue(purchase.item?.owned == true)
        assertEquals(700, purchase.user?.diamondBalance)
    }

    @Test
    fun `a purchase envelope without an item still reports the wallet instead of throwing`() {
        // The money already moved when this is parsed, so a malformed item must not lose the
        // confirmation — and, because this transform runs outside apiCall's try, it must not throw.
        val purchase = gson.fromJson(
            """{"wallet":{"id":"u1","phone":"+1","username":"ana","diamondBalance":500,
                         "rCoinBalance":0,"totalGiftsSent":0,"totalGiftsReceived":0,
                         "userType":"USER","status":"ACTIVE","isVerified":false,"vipLevel":0}}""",
            StorePurchaseResponse::class.java,
        ).toDomain()

        assertNull(purchase.item)
        assertEquals(500, purchase.user?.diamondBalance)
    }
}
