package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.MyApplicationsDto
import com.voiza.app.data.remote.dto.RoleApplicationDto
import com.voiza.app.data.remote.dto.RoleCatalogueDto
import com.voiza.app.domain.model.ApplicationFieldInput
import com.voiza.app.domain.model.ApplicationStatus
import com.voiza.app.domain.model.PartnerRole
import com.voiza.app.domain.model.formatPartnerAnswer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the server's forms are allowed to mean on a device.
 *
 * The picker draws questions it was handed rather than four forms written down in Kotlin, so the two
 * properties worth testing are that nothing here invents a privilege and that nothing here throws away
 * a value this build has not met. Parsed with Gson exactly as Retrofit parses it, because a key the
 * backend omits arrives as null rather than as the declared default.
 */
class RoleApplicationMappersTest {

    private val gson = Gson()

    private fun catalogue(json: String) = gson.fromJson(json, RoleCatalogueDto::class.java).toDomain()

    private fun history(json: String) = gson.fromJson(json, MyApplicationsDto::class.java).toDomain()

    @Test
    fun `the picker maps each role with the server's own granted flag`() {
        val parsed = catalogue(
            """{"roles":[
                 {"role":"HOST","title":"Host a room","blurb":"Go live","benefits":["Payouts"],
                  "granted":true,
                  "openApplication":{"id":"a1","role":"HOST","status":"APPROVED","data":{"city":"Dhaka"}},
                  "fields":[{"key":"fullName","label":"Full name","input":"TEXT","required":true}]},
                 {"role":"AGENCY","title":"Run an agency","granted":false,
                  "openApplication":{"id":"a2","role":"AGENCY","status":"PENDING"},
                  "fields":[{"key":"teamSize","label":"Team size","input":"NUMBER","min":1}]}
               ],
               "agencies":[{"id":"g1","name":"Dhaka Talent"}]}""",
        )

        assertEquals(2, parsed.entries.size)
        assertEquals("HOST", parsed.entries[0].form.role)
        assertEquals("Host a room", parsed.entries[0].form.title)
        assertEquals(listOf("Payouts"), parsed.entries[0].form.benefits)
        assertTrue(parsed.entries[0].granted)
        assertEquals("APPROVED", parsed.entries[0].openApplication?.status)
        assertFalse(parsed.entries[1].granted)
        assertEquals(ApplicationStatus.PENDING, parsed.entries[1].openApplication?.statusEnum)
        assertEquals(listOf("Dhaka Talent"), parsed.agencies.map { it.name })
    }

    @Test
    fun `a role is held because an operator approved it, never because a profile column says so`() {
        // user_type is a display marker the room service writes for anyone who opens a room, so the
        // catalogue carries no such field. An entry is granted only when the server sets it.
        val host = catalogue("""{"roles":[{"role":"HOST","granted":true,"openApplication":{"id":"a","status":"APPROVED"}}]}""")
        assertTrue(host.entries.single().granted)

        val pending = catalogue("""{"roles":[{"role":"HOST","granted":false,"openApplication":{"id":"a","status":"PENDING"}}]}""")
        assertFalse(pending.entries.single().granted)

        // The single-role route answers the same shape without the two status keys at all.
        val bare = catalogue("""{"roles":[{"role":"HOST","title":"Host"}]}""")
        assertFalse(bare.entries.single().granted)
        assertNull(bare.entries.single().openApplication)
    }

    @Test
    fun `a role this build has not met is still a card, still not granted, and still unfilled`() {
        val entry = catalogue("""{"roles":[{"role":"SPONSOR","title":"Sponsor a room","granted":false,"fields":[]}]}""")
            .entries
            .single()

        // The wire value survives untouched: it is what the apply route is called with, and the card is
        // rendered from the server's title rather than from a name this APK knows.
        assertEquals("SPONSOR", entry.form.role)
        assertEquals("Sponsor a room", entry.form.title)
        assertNull(entry.form.knownRole)
        assertNull(PartnerRole.fromWire("SPONSOR"))
        assertFalse(entry.granted)
        assertNull(entry.openApplication)

        // On a history row, where the app has to name the role itself, an unknown one is prettified.
        val row = gson.fromJson("""{"id":"a","role":"SPONSOR","status":"PENDING"}""", RoleApplicationDto::class.java)
            .toDomain()
        assertEquals("Sponsor", row.roleLabel)
    }

    @Test
    fun `a field the app cannot draw is named as unsupported instead of drawn as a text box`() {
        val parsed = catalogue(
            """{"roles":[{"role":"HOST","fields":[
                 {"key":"fullName","label":"Full name","input":"TEXT","required":true,"max":80},
                 {"key":"tier","label":"Tier","input":"RADIO","required":false},
                 {"key":"ageConfirmed","label":"I am over 18","input":"CHECKBOX"}
               ]}]}""",
        ).entries.single().form

        assertEquals(3, parsed.fields.size)
        assertEquals(ApplicationFieldInput.TEXT, parsed.fields[0].input)
        assertEquals(80, parsed.fields[0].max)
        assertEquals(ApplicationFieldInput.UNSUPPORTED, parsed.fields[1].input)
        assertEquals(listOf("tier"), parsed.unsupportedFields.map { it.key })
        assertEquals(ApplicationFieldInput.CHECKBOX, parsed.fields[2].input)

        // A question the server did not mark required, or did not describe at all, is not required.
        assertFalse(parsed.fields[2].required)
        assertFalse(parsed.fields[1].required)
    }

    @Test
    fun `the answers are kept exactly as the form wrote them`() {
        val application = gson.fromJson(
            """{"id":"a1","role":"COIN_SELLER","status":"PENDING",
                "data":{"businessOrFullName":"E2E Seller","expectedMonthlyVolume":50000,
                        "ageConfirmed":true,"verificationDetails":null,"contactEmail":"a@b.co"}}""",
            RoleApplicationDto::class.java,
        ).toDomain()

        assertEquals("a1", application.id)
        assertEquals("COIN_SELLER", application.role)
        assertTrue(application.isOpen)
        assertFalse(application.needsApplicant)
        assertEquals(5, application.answers.size)
        assertNull(application.answers["verificationDetails"])
        assertEquals("E2E Seller", application.answers["businessOrFullName"])
    }

    @Test
    fun `an answer reads back as the member typed it, not as the decoder stored it`() {
        // Gson puts every JSON number in a Map<String, Any?> through a Double, which is the one place
        // this module could show a team size as "12.0".
        val history = history(
            """{"applications":[{"id":"a","role":"HOST","status":"PENDING",
                "data":{"teamSize":12,"share":0.25,"ageConfirmed":true,"refused":false,"blank":null}}]}""",
        ).applications.single()

        assertEquals("12", formatPartnerAnswer(history.answers["teamSize"]))
        assertEquals("0.25", formatPartnerAnswer(history.answers["share"]))
        assertEquals("Yes", formatPartnerAnswer(history.answers["ageConfirmed"]))
        assertEquals("No", formatPartnerAnswer(history.answers["refused"]))
        assertEquals("", formatPartnerAnswer(history.answers["blank"]))
    }

    @Test
    fun `the note the member sees is the one written for the state the row is in`() {
        val note = gson.fromJson(
            """{"id":"a","role":"COIN_SELLER","status":"PENDING",
                "decisionNote":"welcome aboard","infoRequestNote":"which rails?","revokeReason":"rails failed"}""",
            RoleApplicationDto::class.java,
        ).toDomain()
        assertEquals("welcome aboard", note.noteForApplicant)

        val asked = note.copy(status = "INFO_REQUESTED", infoRequestNote = "which rails?")
        assertEquals("which rails?", asked.noteForApplicant)

        val rejected = note.copy(status = "REJECTED", decisionNote = "not enough history")
        assertEquals("not enough history", rejected.noteForApplicant)

        val revoked = note.copy(status = "REVOKED", decisionNote = "welcome aboard", revokeReason = "rails failed")
        assertEquals("rails failed", revoked.noteForApplicant)
    }

    @Test
    fun `an unknown state is neither open nor waiting, so the screen offers no action on it`() {
        // A status added later must not become a withdraw button by default: acting on a row the app
        // cannot describe is how a future "PAUSED" state would be cancelled from a phone.
        val future = gson.fromJson("""{"id":"a","role":"HOST","status":"ON_HOLD"}""", RoleApplicationDto::class.java).toDomain()
        assertNull(future.statusEnum)
        assertFalse(future.isOpen)
        assertFalse(future.needsApplicant)
        assertEquals("Host", future.roleLabel)
    }

    @Test
    fun `a grant is described but grants nothing here`() {
        val approved = gson.fromJson(
            """{"id":"a","role":"AGENCY","status":"APPROVED",
                "grant":{"kind":"AGENCY","id":"g1","label":"Dhaka Talent","status":"ACTIVE"}}""",
            RoleApplicationDto::class.java,
        ).toDomain()

        assertEquals("AGENCY", approved.grant?.kind)
        assertEquals("Dhaka Talent", approved.grant?.label)
        assertEquals("ACTIVE", approved.grant?.status)
        // The row that carries a grant has been decided, so the applicant has nothing left to do.
        assertFalse(approved.isOpen)
    }

    @Test
    fun `what the account holds is read from the same response and never inferred from it`() {
        val parsed = history("""{"applications":[{"id":"a","role":"HOST","status":"REVOKED"}],"activeRoles":["AGENCY"]}""")

        assertEquals(listOf("AGENCY"), parsed.activeRoles)
        assertEquals(listOf("Agency"), parsed.activeRoleLabels())
        assertEquals("REVOKED", parsed.applications.single().status)
        assertFalse(parsed.applications.single().isOpen)
    }

    @Test
    fun `an empty or missing payload maps to nothing rather than failing the screen`() {
        assertEquals(0, catalogue("{}").entries.size)
        assertEquals(0, catalogue("""{"roles":[],"agencies":[]}""").agencies.size)
        assertEquals(0, history("{}").applications.size)
        assertEquals(0, history("""{"applications":[],"activeRoles":[]}""").activeRoles.size)
        assertEquals(
            0,
            catalogue("""{"roles":[{"role":"HOST","fields":[null],"benefits":[null,"Payouts"]}]}""")
                .entries
                .single()
                .form
                .fields
                .size,
        )
    }

    @Test
    fun `a role or status sent in another case still reads as the one the server meant`() {
        val parsed = history("""{"applications":[{"id":"a","role":"coin_seller","status":" info_requested "}],"activeRoles":["coin_seller"]}""")
        val application = parsed.applications.single()

        assertEquals(ApplicationStatus.INFO_REQUESTED, application.statusEnum)
        assertTrue(application.isOpen)
        assertTrue(application.needsApplicant)
        assertEquals("Coin seller", application.roleLabel)
        assertEquals(listOf("Coin seller"), parsed.activeRoleLabels())
    }
}
