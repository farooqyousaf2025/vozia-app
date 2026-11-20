package com.voiza.app.data.export

import com.voiza.app.domain.model.AgencyHostAttendanceDay
import com.voiza.app.domain.model.AgencyHostAttendanceReport
import com.voiza.app.domain.model.AgencyHostAttendanceRow
import com.voiza.app.domain.model.AgencyHostAttendanceTotals
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
}
