package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.BannersResponse
import com.voiza.app.domain.model.BannerFormat
import com.voiza.app.domain.model.BannerPlacement
import com.voiza.app.domain.model.BannerScreen
import com.voiza.app.domain.model.BannerTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * What a banner row is allowed to mean on a device.
 *
 * The wire is parsed with Gson exactly as Retrofit parses it, because a key the backend omits arrives
 * as null rather than as the declared default — and the two cases that matter here are both about a
 * row that cannot be honoured: one this app has no surface for, and one whose tap target it cannot
 * name.
 */
class BannerMapperTest {

    private val gson = Gson()

    /**
     * One row written the way the API writes it: a value of `null` is the key being absent from the
     * body rather than `"field": null` in it, because those reach the DTO differently and only the
     * absent one is what a row trimmed by an older endpoint looks like.
     */
    private fun row(vararg fields: Pair<String, Any?>): String {
        val body = fields.filter { it.second != null }.joinToString(",") { (key, value) ->
            if (value is Number) "\"$key\":$value" else "\"$key\":\"$value\""
        }
        return "{$body}"
    }

    private fun parse(json: String) =
        gson.fromJson(json, BannersResponse::class.java).toDomain()

    /** One complete row — every case that reaches the mapper needs both an id and art. */
    private fun firstRow(vararg fields: Pair<String, Any?>) =
        parse("""{"banners":[${row("id" to "b1", "key" to "winter", *fields)}]}""").firstOrNull()

    private val minimal = listOf("placement" to "HOME", "title" to "Winter sale", "url" to "/uploads/winter.png")

    @Test
    fun `a live row maps with the verb and value the server paired`() {
        val banner = firstRow(
            "placement" to "GIFT",
            "title" to "New year",
            "subtitle" to "Double R-coins",
            "url" to "/uploads/newyear.mp4",
            "format" to "MP4",
            "durationMs" to 6000,
            "ctaType" to "ROOM",
            "ctaValue" to "22222222-2222-2222-2222-222222222203",
        )

        assertEquals(BannerPlacement.GIFT, banner?.placement)
        assertEquals(BannerFormat.MP4, banner?.format)
        assertEquals(6_000, banner?.durationMs)
        assertEquals(
            BannerTarget.Room("22222222-2222-2222-2222-222222222203"),
            banner?.target,
        )
    }

    @Test
    fun `a row with no id or no art is dropped, not drawn`() {
        // No id means no impression and no tap can ever be attributed to it; no url means no art.
        assertNull(
            parse(
                """{"banners":[${row("key" to "x", "placement" to "HOME", "title" to "T", "url" to "/a.png")}]}""",
            ).firstOrNull(),
        )
        assertNull(
            parse(
                """{"banners":[${row("id" to "x", "key" to "x", "placement" to "HOME", "title" to "T")}]}""",
            ).firstOrNull(),
        )
    }

    @Test
    fun `a placement this app has no surface for is dropped rather than drawn somewhere`() {
        // Rendering a GAME row in the gift panel would be an approval the operator never gave, so an
        // enum this build does not know is not a banner at all.
        assertNull(firstRow("placement" to "LOCK_SCREEN", "title" to "T", "url" to "/a.png"))
        // Case does not matter: the server sends upper-case, a hand-written row may not.
        assertEquals(
            BannerPlacement.HOME,
            firstRow("placement" to "home", "title" to "T", "url" to "/a.png")?.placement,
        )
    }

    @Test
    fun `an unknown format becomes a still image rather than a hidden campaign`() {
        // Same call the gift engine makes for an animation format it has never seen: the poster is
        // still worth drawing, and a container the app guesses wrong degrades to a picture.
        assertEquals(BannerFormat.PNG, firstRow(*minimal.toTypedArray(), "format" to "APNG")?.format)
        assertEquals(BannerFormat.PNG, firstRow(*minimal.toTypedArray())?.format)
    }

    @Test
    fun `an absent duration is the surface's own dwell, kept as zero`() {
        assertEquals(0, firstRow(*minimal.toTypedArray())?.durationMs)
    }

    @Test
    fun `a tap target this app cannot name means no tap target`() {
        // Each of these is a row the server would have refused at the write; a client that has to be
        // forgiving here is a client that turns a stray string into a route.
        assertEquals(BannerTarget.None, pair("ctaType" to "INTERNAL", "ctaValue" to "GIFT_PANEL").target)
        assertEquals(BannerTarget.None, pair("ctaType" to "URL", "ctaValue" to "http://example.com").target)
        assertEquals(BannerTarget.None, pair("ctaType" to "ROOM").target)
        assertEquals(BannerTarget.None, pair("ctaType" to "NONE").target)

        // The screens this build has a route for, however the value is spelled, and a real link.
        assertEquals(
            BannerTarget.Internal(BannerScreen.WALLET),
            pair("ctaType" to "INTERNAL", "ctaValue" to "wallet").target,
        )
        assertEquals(
            BannerTarget.Link("https://voiza.example/sale"),
            pair("ctaType" to "URL", "ctaValue" to "https://voiza.example/sale").target,
        )
    }

    private fun pair(vararg extra: Pair<String, Any?>) =
        firstRow(*minimal.toTypedArray(), *extra)!!

    @Test
    fun `a list keeps its rows in the server's order and drops only what it cannot honour`() {
        val banners = gson.fromJson(
            """{"banners":[
                 ${row("id" to "1", "placement" to "HOME", "title" to "One", "url" to "/a.png")},
                 ${row("id" to "2", "placement" to "SPLASH", "title" to "Two")},
                 ${row("id" to "3", "placement" to "GAME", "title" to "Three",
                       "url" to "https://cdn.example/b.gif", "format" to "GIF")}
               ]}""",
            BannersResponse::class.java,
        ).toDomain()

        assertEquals(listOf("1", "3"), banners.map { it.id })
        assertEquals(BannerPlacement.GAME, banners[1].placement)
        assertEquals(BannerFormat.GIF, banners[1].format)
    }

    @Test
    fun `an empty or missing list is no campaigns rather than an error`() {
        assertEquals(emptyList<Any>(), gson.fromJson("""{}""", BannersResponse::class.java).toDomain())
        assertEquals(
            emptyList<Any>(),
            gson.fromJson("""{"banners":[]}""", BannersResponse::class.java).toDomain(),
        )
    }
}
