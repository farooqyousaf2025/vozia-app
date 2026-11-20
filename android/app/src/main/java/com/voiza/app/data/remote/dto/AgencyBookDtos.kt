package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// The agency's own book (`/api/agency`, migration 0040).
//
// Four GETs, each wrapped in the object the controller sends. There is no body type in this file
// because nothing a member can send changes a figure here: rates and batches are an operator's
// decisions, and the agency is named by the token rather than by a parameter, so no payload can
// point at somebody else's roster.
//
// Gson builds these without running their initialisers, so every key whose absence would change the
// answer is nullable and takes its fallback in the mapper.
// ---------------------------------------------------------------------------

/** `master` is null for a master agency — the absence is the fact, not a missing value. */
data class AgencyMasterDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("name") val name: String? = null,
    @SerializedName("overrideBps") val overrideBps: Int? = null,
    @SerializedName("overrideLabel") val overrideLabel: String? = null,
)

data class AgencyEarningsDto(
    @SerializedName("accruedCoins") val accruedCoins: Int? = null,
    @SerializedName("overrideCoins") val overrideCoins: Int? = null,
    @SerializedName("retainedCoins") val retainedCoins: Int? = null,
    @SerializedName("receivedOverrideCoins") val receivedOverrideCoins: Int? = null,
    @SerializedName("last30dCoins") val last30dCoins: Int? = null,
    @SerializedName("last30dOverrideCoins") val last30dOverrideCoins: Int? = null,
)

/** Minor units of `currency`. Absent means the account has not been opened yet — no gift has accrued. */
data class AgencyAccountDto(
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("availableMinor") val availableMinor: Int? = null,
    @SerializedName("pendingMinor") val pendingMinor: Int? = null,
    @SerializedName("frozenMinor") val frozenMinor: Int? = null,
)

/** GET /api/agency/position. */
data class AgencyPositionDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("name") val name: String? = null,
    /** MASTER or SUB, derived server-side from the parent link. Kept a string so a new value parses. */
    @SerializedName("kind") val kind: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("commissionLabel") val commissionLabel: String? = null,
    @SerializedName("hostCount") val hostCount: Int? = null,
    @SerializedName("activeHostCount") val activeHostCount: Int? = null,
    @SerializedName("subAgencyCount") val subAgencyCount: Int? = null,
    @SerializedName("master") val master: AgencyMasterDto? = null,
    @SerializedName("earnings") val earnings: AgencyEarningsDto? = null,
    @SerializedName("account") val account: AgencyAccountDto? = null,
)

data class AgencyPositionEnvelope(
    @SerializedName("agency") val agency: AgencyPositionDto? = null,
)

/** GET /api/agency/hosts. */
data class AgencyActivityTotalsDto(
    @SerializedName("roomsCreated") val roomsCreated: Int? = null,
    @SerializedName("roomsWithVisitors") val roomsWithVisitors: Int? = null,
    @SerializedName("memberVisits") val memberVisits: Int? = null,
    @SerializedName("uniqueVisitors") val uniqueVisitors: Int? = null,
)

data class AgencyActivityDayDto(
    @SerializedName("date") val date: String? = null,
    @SerializedName("roomsCreated") val roomsCreated: Int? = null,
    @SerializedName("roomsWithVisitors") val roomsWithVisitors: Int? = null,
    @SerializedName("memberVisits") val memberVisits: Int? = null,
    @SerializedName("uniqueVisitors") val uniqueVisitors: Int? = null,
)

data class AgencyHostActivityRowDto(
    @SerializedName("username") val username: String? = null,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("roomsCreated") val roomsCreated: Int? = null,
    @SerializedName("roomsWithVisitors") val roomsWithVisitors: Int? = null,
    @SerializedName("memberVisits") val memberVisits: Int? = null,
    @SerializedName("uniqueVisitors") val uniqueVisitors: Int? = null,
)

data class AgencyActivityWeekDto(
    @SerializedName("weekStart") val weekStart: String? = null,
    @SerializedName("roomsCreated") val roomsCreated: Int? = null,
    @SerializedName("roomsWithVisitors") val roomsWithVisitors: Int? = null,
    @SerializedName("memberVisits") val memberVisits: Int? = null,
    @SerializedName("uniqueVisitors") val uniqueVisitors: Int? = null,
)

data class AgencyHostActivityReportDto(
    @SerializedName("days") val days: Int? = null,
    @SerializedName("timezone") val timezone: String? = null,
    @SerializedName("totals") val totals: AgencyActivityTotalsDto? = null,
    @SerializedName("daily") val daily: List<AgencyActivityDayDto>? = null,
    @SerializedName("weekly") val weekly: List<AgencyActivityWeekDto>? = null,
    @SerializedName("hosts") val hosts: List<AgencyHostActivityRowDto>? = null,
)

data class AgencyHostActivityEnvelope(
    @SerializedName("report") val report: AgencyHostActivityReportDto? = null,
)

data class AgencyAttendanceTotalsDto(
    @SerializedName("checkIns") val checkIns: Int? = null,
    @SerializedName("hostsCheckedIn") val hostsCheckedIn: Int? = null,
    @SerializedName("hostAttendanceDays") val hostAttendanceDays: Int? = null,
)
data class AgencyAttendanceDayDto(
    @SerializedName("date") val date: String? = null,
    @SerializedName("checkIns") val checkIns: Int? = null,
    @SerializedName("hostsCheckedIn") val hostsCheckedIn: Int? = null,
)
data class AgencyHostAttendanceRowDto(
    @SerializedName("username") val username: String? = null,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("checkIns") val checkIns: Int? = null,
    @SerializedName("attendanceDays") val attendanceDays: Int? = null,
    @SerializedName("lastCheckInAt") val lastCheckInAt: String? = null,
)
data class AgencyHostAttendanceReportDto(
    @SerializedName("days") val days: Int? = null,
    @SerializedName("timezone") val timezone: String? = null,
    @SerializedName("totals") val totals: AgencyAttendanceTotalsDto? = null,
    @SerializedName("daily") val daily: List<AgencyAttendanceDayDto>? = null,
    @SerializedName("hosts") val hosts: List<AgencyHostAttendanceRowDto>? = null,
)
data class AgencyHostAttendanceEnvelope(
    @SerializedName("report") val report: AgencyHostAttendanceReportDto? = null,
)

data class AgencyHostGoalRowDto(
    @SerializedName("username") val username: String? = null,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("attendanceDays") val attendanceDays: Int? = null,
    @SerializedName("targetDays") val targetDays: Int? = null,
    @SerializedName("progressPercent") val progressPercent: Int? = null,
    @SerializedName("remainingDays") val remainingDays: Int? = null,
    @SerializedName("metTarget") val metTarget: Boolean? = null,
)
data class AgencyHostGoalsDto(
    @SerializedName("weeklyAttendanceTargetDays") val weeklyAttendanceTargetDays: Int? = null,
    @SerializedName("windowDays") val windowDays: Int? = null,
    @SerializedName("timezone") val timezone: String? = null,
    @SerializedName("activeHostCount") val activeHostCount: Int? = null,
    @SerializedName("hostsMeetingGoal") val hostsMeetingGoal: Int? = null,
    @SerializedName("hosts") val hosts: List<AgencyHostGoalRowDto>? = null,
    @SerializedName("updatedAt") val updatedAt: String? = null,
)
data class AgencyHostGoalsEnvelope(
    @SerializedName("goals") val goals: AgencyHostGoalsDto? = null,
)
data class AgencyHostGoalsUpdateBody(
    @SerializedName("weeklyAttendanceTargetDays") val weeklyAttendanceTargetDays: Int,
)

data class AgencyHostDto(
    @SerializedName("username") val username: String? = null,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("joinedAt") val joinedAt: String? = null,
    @SerializedName("commissionLabel") val commissionLabel: String? = null,
    @SerializedName("accruedCoins") val accruedCoins: Int? = null,
    @SerializedName("last30dCoins") val last30dCoins: Int? = null,
)

data class AgencyHostsEnvelope(
    @SerializedName("hosts") val hosts: List<AgencyHostDto>? = null,
)

/** GET /api/agency/sub-agencies — master-only; a sub-agency is refused with 403 `master_only`. */
data class AgencySubDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("name") val name: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("hostCount") val hostCount: Int? = null,
    @SerializedName("activeHostCount") val activeHostCount: Int? = null,
    @SerializedName("parentOverrideBps") val parentOverrideBps: Int? = null,
    @SerializedName("parentOverrideLabel") val parentOverrideLabel: String? = null,
    @SerializedName("accruedCoins") val accruedCoins: Int? = null,
    @SerializedName("overrideCoins") val overrideCoins: Int? = null,
    @SerializedName("retainedCoins") val retainedCoins: Int? = null,
)

data class AgencySubsEnvelope(
    @SerializedName("subAgencies") val subAgencies: List<AgencySubDto>? = null,
)

/** GET /api/agency/settlements. `paidAt` is null until finance records the transfer. */
data class AgencySettlementDto(
    @SerializedName("reference") val reference: String? = null,
    @SerializedName("amount") val amount: Int? = null,
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("periodFrom") val periodFrom: String? = null,
    @SerializedName("periodTo") val periodTo: String? = null,
    @SerializedName("entryCount") val entryCount: Int? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("paidAt") val paidAt: String? = null,
)

data class AgencySettlementsEnvelope(
    @SerializedName("settlements") val settlements: List<AgencySettlementDto>? = null,
)
