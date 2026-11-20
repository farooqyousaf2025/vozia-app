package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.AgencyAccountDto
import com.voiza.app.data.remote.dto.AgencyEarningsDto
import com.voiza.app.data.remote.dto.AgencyHostDto
import com.voiza.app.data.remote.dto.AgencyHostActivityEnvelope
import com.voiza.app.data.remote.dto.AgencyHostAttendanceEnvelope
import com.voiza.app.domain.model.AgencyHostActivityWeek
import com.voiza.app.domain.model.AgencyHostAttendanceReport
import com.voiza.app.domain.model.AgencyHostAttendanceTotals
import com.voiza.app.domain.model.AgencyHostAttendanceDay
import com.voiza.app.domain.model.AgencyHostAttendanceRow
import com.voiza.app.domain.model.AgencyHostActivityReport
import com.voiza.app.domain.model.AgencyHostActivityTotals
import com.voiza.app.domain.model.AgencyHostActivityDay
import com.voiza.app.domain.model.AgencyHostActivityRow
import com.voiza.app.data.remote.dto.AgencyHostsEnvelope
import com.voiza.app.data.remote.dto.AgencyMasterDto
import com.voiza.app.data.remote.dto.AgencyPositionDto
import com.voiza.app.data.remote.dto.AgencyPositionEnvelope
import com.voiza.app.data.remote.dto.AgencySettlementDto
import com.voiza.app.data.remote.dto.AgencySettlementsEnvelope
import com.voiza.app.data.remote.dto.AgencySubDto
import com.voiza.app.data.remote.dto.AgencySubsEnvelope
import com.voiza.app.domain.model.AgencyAccount
import com.voiza.app.domain.model.AgencyEarnings
import com.voiza.app.domain.model.AgencyHostRow
import com.voiza.app.domain.model.AgencyKind
import com.voiza.app.domain.model.AgencyMaster
import com.voiza.app.domain.model.AgencyPosition
import com.voiza.app.domain.model.AgencySettlementRow
import com.voiza.app.domain.model.AgencySettlementStatus
import com.voiza.app.domain.model.AgencyStatus
import com.voiza.app.domain.model.AgencySubRow

// ---------------------------------------------------------------------------
// The agency's own book.
//
// Every figure is copied, none is worked out: the split between what a sub keeps and what its master
// takes is the server's arithmetic on the accruals it booked, and re-deriving it here from a rate
// would produce a number that disagrees with the journal the moment a rate changes for the next gift.
//
// A label falls back to the server's own word when this build has no name for the value, so a new
// batch state reads as that state instead of vanishing from the row that carries it.
// ---------------------------------------------------------------------------

private fun wireStatus(value: String?): Pair<AgencyStatus?, String> {
    val status = AgencyStatus.fromWire(value)
    return status to (status?.label ?: value?.trim().orIfBlank { "Unknown" })
}

private fun String?.orIfBlank(fallback: () -> String): String =
    if (this.isNullOrBlank()) fallback() else this

fun AgencyMasterDto.toDomain(): AgencyMaster = AgencyMaster(
    name = name.orEmpty(),
    overrideBps = overrideBps,
    overrideLabel = overrideLabel.orEmpty(),
)

fun AgencyEarningsDto.toDomain(): AgencyEarnings = AgencyEarnings(
    accruedCoins = accruedCoins ?: 0,
    overrideCoins = overrideCoins ?: 0,
    retainedCoins = retainedCoins ?: 0,
    receivedOverrideCoins = receivedOverrideCoins ?: 0,
    last30dCoins = last30dCoins ?: 0,
    last30dOverrideCoins = last30dOverrideCoins ?: 0,
)

fun AgencyAccountDto.toDomain(): AgencyAccount = AgencyAccount(
    currency = currency.orEmpty(),
    availableMinor = availableMinor ?: 0,
    pendingMinor = pendingMinor ?: 0,
    frozenMinor = frozenMinor ?: 0,
)

fun AgencyPositionDto.toDomain(): AgencyPosition {
    val (status, statusLabel) = wireStatus(status)
    val parsedKind = AgencyKind.fromWire(kind)
    return AgencyPosition(
        id = id.orEmpty(),
        name = name.orEmpty(),
        kind = parsedKind,
        kindLabel = parsedKind?.label ?: kind.orIfBlank { "Agency" },
        status = status,
        statusLabel = statusLabel,
        commissionLabel = commissionLabel.orEmpty(),
        hostCount = hostCount ?: 0,
        activeHostCount = activeHostCount ?: 0,
        subAgencyCount = subAgencyCount ?: 0,
        master = master?.toDomain(),
        earnings = earnings?.toDomain() ?: AgencyEarnings(0, 0, 0, 0, 0, 0),
        account = account?.toDomain(),
    )
}

fun AgencyHostActivityEnvelope.toDomain(): AgencyHostActivityReport? {
    val report = report ?: return null
    val totals = report.totals
    return AgencyHostActivityReport(
        days = report.days ?: 7,
        timezone = report.timezone ?: "UTC",
        totals = AgencyHostActivityTotals(
            totals?.roomsCreated ?: 0, totals?.roomsWithVisitors ?: 0,
            totals?.memberVisits ?: 0, totals?.uniqueVisitors ?: 0,
        ),
        daily = report.daily.orEmpty().mapNotNull { row ->
            val date = row.date?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            AgencyHostActivityDay(date, row.roomsCreated ?: 0, row.roomsWithVisitors ?: 0, row.memberVisits ?: 0, row.uniqueVisitors ?: 0)
        },
        weekly = report.weekly.orEmpty().mapNotNull { row ->
            val weekStart = row.weekStart?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            AgencyHostActivityWeek(weekStart, row.roomsCreated ?: 0, row.roomsWithVisitors ?: 0, row.memberVisits ?: 0, row.uniqueVisitors ?: 0)
        },
        hosts = report.hosts.orEmpty().mapNotNull { row ->
            val username = row.username?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            AgencyHostActivityRow(username, row.avatarUrl, row.roomsCreated ?: 0, row.roomsWithVisitors ?: 0, row.memberVisits ?: 0, row.uniqueVisitors ?: 0)
        },
    )
}

fun AgencyHostAttendanceEnvelope.toAttendanceDomain(): AgencyHostAttendanceReport? {
    val report = report ?: return null
    val totals = report.totals
    return AgencyHostAttendanceReport(
        days = report.days ?: 7,
        timezone = report.timezone ?: "UTC",
        totals = AgencyHostAttendanceTotals(
            totals?.checkIns ?: 0, totals?.hostsCheckedIn ?: 0, totals?.hostAttendanceDays ?: 0,
        ),
        daily = report.daily.orEmpty().filterNotNull().mapNotNull { row ->
            val date = row.date?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            AgencyHostAttendanceDay(date, row.checkIns ?: 0, row.hostsCheckedIn ?: 0)
        },
        hosts = report.hosts.orEmpty().filterNotNull().mapNotNull { row ->
            val username = row.username?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            AgencyHostAttendanceRow(username, row.avatarUrl, row.checkIns ?: 0, row.attendanceDays ?: 0, row.lastCheckInAt)
        },
    )
}

fun AgencyHostDto.toDomain(): AgencyHostRow {
    val (status, statusLabel) = wireStatus(status)
    return AgencyHostRow(
        username = username.orEmpty(),
        avatarUrl = avatarUrl,
        status = status,
        statusLabel = statusLabel,
        joinedAt = joinedAt,
        commissionLabel = commissionLabel.orEmpty(),
        accruedCoins = accruedCoins ?: 0,
        last30dCoins = last30dCoins ?: 0,
    )
}

fun AgencySubDto.toDomain(): AgencySubRow {
    val (status, statusLabel) = wireStatus(status)
    return AgencySubRow(
        name = name.orEmpty(),
        status = status,
        statusLabel = statusLabel,
        hostCount = hostCount ?: 0,
        activeHostCount = activeHostCount ?: 0,
        overrideLabel = parentOverrideLabel.orEmpty(),
        accruedCoins = accruedCoins ?: 0,
        overrideCoins = overrideCoins ?: 0,
        retainedCoins = retainedCoins ?: 0,
    )
}

fun AgencySettlementDto.toDomain(): AgencySettlementRow {
    val parsed = AgencySettlementStatus.fromWire(status)
    return AgencySettlementRow(
        reference = reference.orEmpty(),
        amountMinor = amount ?: 0,
        currency = currency.orEmpty(),
        status = parsed,
        statusLabel = parsed?.label ?: status?.trim().orIfBlank { "Unknown" },
        periodFrom = periodFrom,
        periodTo = periodTo,
        entryCount = entryCount ?: 0,
        createdAt = createdAt,
        paidAt = paidAt,
    )
}

fun AgencyPositionEnvelope.toPosition(): AgencyPosition? = agency?.toDomain()

fun AgencyHostsEnvelope.toHosts(): List<AgencyHostRow> = hosts.orEmpty().filterNotNull().map { it.toDomain() }

fun AgencySubsEnvelope.toSubs(): List<AgencySubRow> = subAgencies.orEmpty().filterNotNull().map { it.toDomain() }

fun AgencySettlementsEnvelope.toSettlements(): List<AgencySettlementRow> =
    settlements.orEmpty().filterNotNull().map { it.toDomain() }
