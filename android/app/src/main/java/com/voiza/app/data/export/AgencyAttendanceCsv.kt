package com.voiza.app.data.export

import com.voiza.app.domain.model.AgencyHostAttendanceReport

/**
 * A lossless, spreadsheet-friendly export of the attendance report already returned to this owner.
 * No identifiers, contact details, financial figures, or inferred session durations are added.
 */
fun AgencyHostAttendanceReport.toAttendanceCsv(): String {
    val rows = buildList {
        add(listOf(
            "SUMMARY", "", "", totals.checkIns.toString(), totals.hostsCheckedIn.toString(),
            totals.hostAttendanceDays.toString(), "", days.toString(), timezone,
        ))
        daily.forEach { day ->
            add(listOf(
                "DAILY", day.date, "", day.checkIns.toString(), day.hostsCheckedIn.toString(),
                "", "", days.toString(), timezone,
            ))
        }
        hosts.forEach { host ->
            add(listOf(
                "HOST", "", host.username, host.checkIns.toString(), "",
                host.attendanceDays.toString(), host.lastCheckInAt.orEmpty(), days.toString(), timezone,
            ))
        }
    }
    val header = listOf(
        "record_type", "date", "username", "check_ins", "hosts_checked_in",
        "attendance_days", "last_verified_check_in", "window_days", "timezone",
    )
    return buildString {
        // UTF-8 BOM improves automatic UTF-8 detection in common desktop spreadsheet apps.
        append('\uFEFF')
        (listOf(header) + rows).forEach { row ->
            append(row.joinToString(",") { it.toCsvField() })
            append("\r\n")
        }
    }
}

private fun String.toCsvField(): String {
    // Treat user-controlled text beginning with a spreadsheet formula marker as plain text.
    // Also guard leading control characters commonly used to bypass CSV formula checks.
    val firstMeaningful = dropWhile { it == ' ' || it == '\t' || it == '\r' || it == '\n' }
        .firstOrNull()
    val formulaLike = firstMeaningful?.let { it in setOf('=', '+', '-', '@') } == true
    val controlPrefixed = firstOrNull()?.let { it in setOf('\t', '\r', '\n') } == true
    val safe = if (formulaLike || controlPrefixed) "'$this" else this
    return if (safe.any { it == ',' || it == '"' || it == '\r' || it == '\n' }) {
        "\"" + safe.replace("\"", "\"\"") + "\""
    } else {
        safe
    }
}
