package com.voiza.app.data.mapper

import com.google.gson.Gson
import com.voiza.app.data.remote.dto.AgencyHostsEnvelope
import com.voiza.app.data.remote.dto.AgencyHostAttendanceEnvelope
import com.voiza.app.data.remote.dto.AgencyHostGoalsEnvelope
import com.voiza.app.data.remote.dto.AgencyHostRecognitionEnvelope
import com.voiza.app.data.remote.dto.AgencyHostLeaderboardEnvelope
import com.voiza.app.data.remote.dto.AgencyPositionEnvelope
import com.voiza.app.data.remote.dto.AgencySettlementsEnvelope
import com.voiza.app.data.remote.dto.AgencySubsEnvelope
import com.voiza.app.domain.model.AgencyKind
import com.voiza.app.domain.model.AgencySettlementStatus
import com.voiza.app.domain.model.AgencyStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the agency's own book is allowed to mean on a device.
 *
 * Two properties are worth holding: the mapper copies the server's arithmetic and never recomputes it,
 * so a figure on screen is the one the journal booked; and a word this build has not met still arrives
 * as that word rather than as a blank or a crash, because a rate changed after this APK shipped must
 * not turn an agency into nothing. Parsed with Gson exactly as Retrofit parses it, so a key the backend
 * leaves out arrives as null instead of as the declared default.
 */
class AgencyBookMappersTest {

    private val gson = Gson()

    private fun position(json: String) = gson.fromJson(json, AgencyPositionEnvelope::class.java).toPosition()

    private val masterJson = """
        {"agency":{
          "id":"ag-master","name":"Karachi Collective","kind":"MASTER","status":"ACTIVE",
          "createdAt":"2026-01-04T09:00:00.000Z","commissionLabel":"10% of gifts, agency rate",
          "hostCount":7,"activeHostCount":5,"subAgencyCount":2,"master":null,
          "earnings":{"accruedCoins":1000,"overrideCoins":0,"retainedCoins":1000,
                      "receivedOverrideCoins":250,"last30dCoins":400,"last30dOverrideCoins":0},
          "account":{"currency":"USD","availableMinor":987654,"pendingMinor":12000,"frozenMinor":0}
        }}
    """.trimIndent()

    private val subJson = """
        {"agency":{
          "id":"ag-sub","name":"Lahore Cells","kind":"SUB","status":"ACTIVE",
          "createdAt":"2026-03-01T09:00:00.000Z","commissionLabel":"10% of gifts, agency rate",
          "hostCount":3,"activeHostCount":3,"subAgencyCount":0,
          "master":{"id":"ag-master","name":"Karachi Collective","overrideBps":2500,
                    "overrideLabel":"Master takes 25% — keeps 75%"},
          "earnings":{"accruedCoins":1000,"overrideCoins":250,"retainedCoins":750,
                      "receivedOverrideCoins":0,"last30dCoins":400,"last30dOverrideCoins":100},
          "account":null
        }}
    """.trimIndent()

    @Test
    fun `a master reads its own share, and the coins taken in from below`() {
        val parsed = position(masterJson)!!

        assertEquals(AgencyKind.MASTER, parsed.kind)
        assertTrue(parsed.isMaster)
        assertEquals("Master agency", parsed.kindLabel)
        assertEquals("Active", parsed.statusLabel)
        assertNull("a master has no master", parsed.master)
        assertEquals(2, parsed.subAgencyCount)
        assertEquals(1000, parsed.earnings.accruedCoins)
        assertEquals(250, parsed.earnings.receivedOverrideCoins)
        assertEquals("USD", parsed.account?.currency)
        assertEquals(987654, parsed.account?.availableMinor)
    }

    @Test
    fun `a sub keeps the split the server booked instead of working it out from the rate`() {
        val parsed = position(subJson)!!

        assertFalse(parsed.isMaster)
        assertEquals("Sub-agency", parsed.kindLabel)
        assertEquals("Karachi Collective", parsed.master?.name)
        assertEquals(2500, parsed.master?.overrideBps)
        // 1000 counted, 250 passed up, 750 kept — copied straight through. Re-deriving retained from
        // the bps here would disagree with the journal the moment the master's rate changed.
        assertEquals(1000, parsed.earnings.accruedCoins)
        assertEquals(250, parsed.earnings.overrideCoins)
        assertEquals(750, parsed.earnings.retainedCoins)
        assertEquals(0, parsed.earnings.receivedOverrideCoins)
        assertNull("no payout account until the first gift accrues", parsed.account)
    }

    @Test
    fun `a kind or state this build has not met still names itself`() {
        val parsed = position(
            """{"agency":{"name":"New Territory","kind":"FRANCHISE","status":"ARCHIVED",
                "master":{"name":"Nobody","overrideBps":null,"overrideLabel":"Master takes nothing — keeps 100%"}}}""",
        )!!

        assertNull(AgencyKind.fromWire("FRANCHISE"))
        assertNull(parsed.kind)
        assertEquals("FRANCHISE", parsed.kindLabel)
        assertEquals("ARCHIVED", parsed.statusLabel)
        // A null rate is not zero and not a gap: it is the server saying no share was agreed.
        assertNull(parsed.master?.overrideBps)
        assertEquals("Master takes nothing — keeps 100%", parsed.master?.overrideLabel)
        assertEquals(0, parsed.earnings.accruedCoins)
    }

    @Test
    fun `an envelope with no agency in it is no position, not an empty one`() {
        assertNull(position("{}"))
        assertNull(position("""{"agency":null}"""))

        // Keys the backend left out are null, not the Kotlin defaults — Gson builds without
        // initialisers — so the fallbacks belong to the mapper and every absent figure reads as zero.
        val bare = position("""{"agency":{"name":"Nameless"}}""")!!
        assertEquals("", bare.commissionLabel)
        assertEquals(0, bare.hostCount)
        assertEquals(0, bare.earnings.last30dCoins)
        assertEquals("Agency", bare.kindLabel)
        assertEquals("Unknown", bare.statusLabel)
    }

    @Test
    fun `the roster carries what it is told and no column a member must not see`() {
        val hosts = gson.fromJson(
            """{"hosts":[
                 {"username":"ali_live","avatarUrl":null,"status":"ACTIVE","joinedAt":"2026-02-02T00:00:00.000Z",
                  "commissionLabel":"12% of gifts","accruedCoins":600,"last30dCoins":200},
                 null,
                 {"username":"sara","status":"PENDING"}
               ]}""",
            AgencyHostsEnvelope::class.java,
        ).toHosts()

        assertEquals(listOf("ali_live", "sara"), hosts.map { it.username })
        assertEquals(600, hosts[0].accruedCoins)
        assertEquals("12% of gifts", hosts[0].commissionLabel)
        assertEquals(AgencyStatus.PENDING, hosts[1].status)
        assertEquals(0, hosts[1].accruedCoins)
        assertNull(hosts[1].joinedAt)
    }

    @Test
    fun `host attendance mapper preserves verified check-ins and omits absent hosts`() {
        val report = gson.fromJson(
            """{"report":{
                "days":7,"timezone":"UTC",
                "totals":{"checkIns":5,"hostsCheckedIn":2,"hostAttendanceDays":4},
                "daily":[{"date":"2026-11-20","checkIns":3,"hostsCheckedIn":2},{"date":"2026-11-21","checkIns":2,"hostsCheckedIn":1}],
                "hosts":[
                  {"username":"ali_live","avatarUrl":null,"checkIns":3,"attendanceDays":2,"lastCheckInAt":"2026-11-20T18:30:00.000Z"},
                  null,
                  {"username":"sara","checkIns":2,"attendanceDays":2,"lastCheckInAt":"2026-11-21T09:00:00.000Z"}
                ]
            }}""",
            AgencyHostAttendanceEnvelope::class.java,
        ).toAttendanceDomain()!!

        assertEquals(5, report.totals.checkIns)
        assertEquals(2, report.totals.hostsCheckedIn)
        assertEquals(4, report.totals.hostAttendanceDays)
        assertEquals(2, report.daily.size)
        assertEquals(3, report.daily.first().checkIns)
        assertEquals(listOf("ali_live", "sara"), report.hosts.map { it.username })
        assertEquals(2, report.hosts.first().attendanceDays)
        assertEquals("2026-11-20T18:30:00.000Z", report.hosts.first().lastCheckInAt)
    }

    @Test
    fun `host goals mapper preserves server progress and safely defaults missing values`() {
        val goals = gson.fromJson(
            """{"goals":{
                "weeklyAttendanceTargetDays":3,"windowDays":7,"timezone":"UTC",
                "activeHostCount":2,"hostsMeetingGoal":1,"updatedAt":"2026-11-21T00:00:00.000Z",
                "hosts":[
                  {"username":"ali_live","attendanceDays":3,"targetDays":3,"progressPercent":100,"remainingDays":0,"metTarget":true},
                  null,
                  {"username":"sara","attendanceDays":1,"targetDays":3,"progressPercent":33,"remainingDays":2,"metTarget":false},
                  {"username":"   ","attendanceDays":0}
                ]
            }}""",
            AgencyHostGoalsEnvelope::class.java,
        ).toGoalsDomain()!!

        assertEquals(3, goals.weeklyAttendanceTargetDays)
        assertEquals(2, goals.activeHostCount)
        assertEquals(1, goals.hostsMeetingGoal)
        assertEquals(listOf("ali_live", "sara"), goals.hosts.map { it.username })
        assertTrue(goals.hosts.first().metTarget)
        assertEquals(100, goals.hosts.first().progressPercent)
        assertEquals(2, goals.hosts.last().remainingDays)
        assertFalse(goals.hosts.last().metTarget)
    }

    @Test
    fun `host recognition mapper keeps earned dates and safely ignores null rows`() {
        val recognition = gson.fromJson(
            """{"recognition":{
                "timezone":"UTC","activeHostCount":2,"hostsWithAchievements":1,
                "hosts":[
                  {"username":"ali_live","attendanceDays":30,"milestones":[
                    {"code":"FIRST_CHECK_IN","title":"First Spark","description":"First verified day","attendanceDaysRequired":1,"unlockedAt":"2026-08-01"},
                    null,
                    {"code":"SEVEN_DAYS","title":"Weekly Regular","description":"Seven days","attendanceDaysRequired":7,"unlockedAt":"2026-08-07"},
                    {"code":"THIRTY_DAYS","title":"Monthly Star","description":"Thirty days","attendanceDaysRequired":30,"unlockedAt":"2026-08-30"},
                    {"code":"HUNDRED_DAYS","title":"Century Club","description":"One hundred days","attendanceDaysRequired":100,"unlockedAt":null}
                  ]},
                  null,
                  {"username":"sara","attendanceDays":0,"milestones":[
                    {"code":"FIRST_CHECK_IN","title":"First Spark","attendanceDaysRequired":1,"unlockedAt":null}
                  ]}
                ]
            }}""",
            AgencyHostRecognitionEnvelope::class.java,
        ).toRecognitionDomain()!!

        assertEquals("UTC", recognition.timezone)
        assertEquals(2, recognition.activeHostCount)
        assertEquals(1, recognition.hostsWithAchievements)
        assertEquals(listOf("ali_live", "sara"), recognition.hosts.map { it.username })
        assertEquals(30, recognition.hosts.first().attendanceDays)
        assertEquals(4, recognition.hosts.first().milestones.size)
        assertEquals("2026-08-01", recognition.hosts.first().milestones.first().unlockedAt)
        assertEquals(null, recognition.hosts.first().milestones.last().unlockedAt)
        assertEquals(null, recognition.hosts.last().milestones.single().unlockedAt)
    }

    @Test
    fun `a master's allocation rows repeat the sub's own figures`() {
        val subs = gson.fromJson(
            """{"subAgencies":[
                 {"id":"ag-sub","name":"Lahore Cells","status":"ACTIVE","hostCount":3,"activeHostCount":3,
                  "parentOverrideBps":2500,"parentOverrideLabel":"Master takes 25% — keeps 75%",
                  "accruedCoins":1000,"overrideCoins":250,"retainedCoins":750}
               ]}""",
            AgencySubsEnvelope::class.java,
        ).toSubs()

        val sub = subs.single()
        assertEquals("Master takes 25% — keeps 75%", sub.overrideLabel)
        assertEquals(250, sub.overrideCoins)
        assertEquals(750, sub.retainedCoins)
        assertEquals(3, sub.activeHostCount)

        assertTrue(gson.fromJson("{}", AgencySubsEnvelope::class.java).toSubs().isEmpty())
    }

    @Test
    fun `a batch state this build has not met keeps the server's word`() {
        val rows = gson.fromJson(
            """{"settlements":[
                 {"reference":"SET-0001","amount":90000,"currency":"USD","status":"PAID",
                  "periodFrom":"2026-09-01T00:00:00.000Z","periodTo":"2026-09-30T00:00:00.000Z",
                  "entryCount":44,"createdAt":"2026-10-02T00:00:00.000Z","paidAt":"2026-10-05T00:00:00.000Z"},
                 {"reference":"SET-0002","amount":12000,"currency":"USD","status":"HELD_FOR_REVIEW",
                  "entryCount":6,"createdAt":"2026-11-01T00:00:00.000Z","paidAt":null}
               ]}""",
            AgencySettlementsEnvelope::class.java,
        ).toSettlements()

        assertEquals(AgencySettlementStatus.PAID, rows[0].status)
        assertEquals("Paid", rows[0].statusLabel)
        assertEquals(90000, rows[0].amountMinor)
        assertEquals("2026-10-05T00:00:00.000Z", rows[0].paidAt)

        assertNull(AgencySettlementStatus.fromWire("HELD_FOR_REVIEW"))
        assertNull(rows[1].status)
        assertEquals("HELD_FOR_REVIEW", rows[1].statusLabel)
        assertNull(rows[1].paidAt)
    }
    @Test
    fun `agency leaderboard mapper preserves ranks activity summaries and earned badges`() {
        val leaderboard = gson.fromJson(
            """{"leaderboard":{
                "days":30,"timezone":"UTC","activeHostCount":2,"hostsWithAttendance":2,
                "totalCheckIns":31,"totalAttendanceDays":31,"hostsWithBadges":2,
                "hosts":[
                  {"rank":1,"username":"ali_live","attendanceDays":30,"checkIns":30,
                   "lastCheckInAt":"2026-11-20T10:00:00.000Z","badges":[
                     {"code":"FIRST_CHECK_IN","title":"First Spark","unlockedAt":"2026-08-01"},
                     null,
                     {"code":"THIRTY_DAYS","title":"Thirty-Day Milestone","unlockedAt":"2026-08-30"}
                   ]},
                  null,
                  {"rank":2,"username":"sara","attendanceDays":1,"checkIns":1,
                   "lastCheckInAt":null,"badges":[]}
                ]
            }}""",
            AgencyHostLeaderboardEnvelope::class.java,
        ).toLeaderboardDomain()!!

        assertEquals(30, leaderboard.days)
        assertEquals("UTC", leaderboard.timezone)
        assertEquals(2, leaderboard.activeHostCount)
        assertEquals(2, leaderboard.hostsWithAttendance)
        assertEquals(31, leaderboard.totalCheckIns)
        assertEquals(31, leaderboard.totalAttendanceDays)
        assertEquals(2, leaderboard.hostsWithBadges)
        assertEquals(listOf("ali_live", "sara"), leaderboard.hosts.map { it.username })
        assertEquals(1, leaderboard.hosts.first().rank)
        assertEquals(30, leaderboard.hosts.first().attendanceDays)
        assertEquals(30, leaderboard.hosts.first().checkIns)
        assertEquals(listOf("First Spark", "Thirty-Day Milestone"), leaderboard.hosts.first().badges.map { it.title })
        assertEquals("2026-08-30", leaderboard.hosts.first().badges.last().unlockedAt)
        assertEquals(2, leaderboard.hosts.last().rank)
        assertTrue(leaderboard.hosts.last().badges.isEmpty())
    }

}
