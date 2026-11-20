package com.voiza.app.data.export

import com.voiza.app.domain.model.AgencyHostAttendanceDay
import com.voiza.app.domain.model.AgencyHostAttendanceReport
import com.voiza.app.domain.model.AgencyHostAttendanceRow
import com.voiza.app.domain.model.AgencyHostAttendanceTotals
import com.voiza.app.domain.model.AgencyHostRow
import com.voiza.app.domain.model.AgencyStatus
import org.junit.Assert.assertTrue
import org.junit.Test

class AgencyAttendanceCsvTest {
    @Test
    fun `export contains summary daily and every host row without extra personal fields`() {
        val report = AgencyHostAttendanceReport(
            days = 7,
            timezone = "UTC",
            totals = AgencyHostAttendanceTotals(checkIns = 5, hostsCheckedIn = 2, hostAttendanceDays = 4),
            daily = listOf(AgencyHostAttendanceDay("2026-11-20", 3, 2)),
            hosts = listOf(
                AgencyHostAttendanceRow("ali_live", null, 3, 2, "2026-11-20T18:30:00Z"),
                AgencyHostAttendanceRow("sara", null, 2, 2, "2026-11-21T09:00:00Z"),
            ),
        )

        val csv = report.toAttendanceCsv()

        assertTrue(csv.startsWith("\uFEFFrecord_type,date,username"))
        assertTrue(csv.contains("SUMMARY,,,5,2,4,,7,UTC"))
        assertTrue(csv.contains("DAILY,2026-11-20,,3,2,,"))
        assertTrue(csv.contains("HOST,,ali_live,3,,2,2026-11-20T18:30:00Z,7,UTC"))
        assertTrue(csv.contains("HOST,,sara,2,,2,2026-11-21T09:00:00Z,7,UTC"))
        assertTrue(!csv.contains("avatar"))
        assertTrue(!csv.contains("phone"))
    }

    @Test
    fun `export escapes commas quotes and embedded newlines in host names`() {
        val report = AgencyHostAttendanceReport(
            days = 30,
            timezone = "UTC",
            totals = AgencyHostAttendanceTotals(1, 1, 1),
            daily = emptyList(),
            hosts = listOf(AgencyHostAttendanceRow("ali,\"live\"\nteam", null, 1, 1, null)),
        )

        val csv = report.toAttendanceCsv()

        assertTrue(csv.contains("\"ali,\"\"live\"\"\nteam\",1,,1,,30,UTC"))
    }

    @Test
    fun `export neutralizes spreadsheet formulas in host names`() {
        val report = AgencyHostAttendanceReport(
            days = 7,
            timezone = "UTC",
            totals = AgencyHostAttendanceTotals(1, 1, 1),
            daily = emptyList(),
            hosts = listOf(
                AgencyHostAttendanceRow("=HYPERLINK(\"https://example.com\")", null, 1, 1, null),
                AgencyHostAttendanceRow("  @SUM(1,1)", null, 1, 1, null),
            ),
        )

        val csv = report.toAttendanceCsv()

        assertTrue(csv.contains("'=HYPERLINK(\"\"https://example.com\"\")"))
        assertTrue(csv.contains("'  @SUM(1,1)"))
    }
    @Test
    fun `roster export includes authorized roster fields and excludes identifiers`() {
        val hosts = listOf(
            AgencyHostRow(
                username = "ali_live",
                avatarUrl = "https://example.com/avatar.png",
                status = AgencyStatus.ACTIVE,
                statusLabel = "Active",
                joinedAt = "2026-10-01T12:00:00Z",
                commissionLabel = "10%",
                accruedCoins = 12500,
                last30dCoins = 2400,
            ),
        )

        val csv = hosts.toRosterCsv()

        assertTrue(csv.startsWith("\uFEFFusername,status,joined_at,commission_rate"))
        assertTrue(csv.contains("ali_live,Active,2026-10-01T12:00:00Z,10%,12500,2400"))
        assertTrue(!csv.contains("avatar.png"))
        assertTrue(!csv.contains("user_id"))
    }

    @Test
    fun `roster export quotes text and neutralizes formula-like usernames`() {
        val hosts = listOf(
            AgencyHostRow("=SUM(1,1)", null, null, "Unknown", null, "10%", 0, 0),
            AgencyHostRow("ali,live", null, null, "Unknown", null, "10%", 0, 0),
        )

        val csv = hosts.toRosterCsv()

        assertTrue(csv.contains("'=SUM(1,1)"))
        assertTrue(csv.contains("\"ali,live\""))
    }

}
