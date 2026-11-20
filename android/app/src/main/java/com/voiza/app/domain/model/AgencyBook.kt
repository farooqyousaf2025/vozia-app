package com.voiza.app.domain.model

// ---------------------------------------------------------------------------
// The agency's own book — `GET /api/agency/*`, migration 0033 extended by 0040's hierarchy.
//
// These are the figures the platform owes a roster of hosts, read from the agency's side. Nothing in
// here is editable by the member looking at it: a rate is agreed by an operator who holds
// `commission:manage`, and a payout batch is raised by finance. That is why no request in this feature
// carries a body, and why none carries an agency id either — `requireAgencyOwner` finds the book from
// the token alone, so a member cannot ask about a roster they do not run.
//
// Two units appear throughout and neither is the other's proxy. Coins are what an agency negotiates in
// and what the gift path counts; minor currency units are what a batch actually pays. A master's share
// of a sub-agency's commission moves between two payables (0040), so the same coins are shown once as
// "passed up" on the sub's row and once as "taken in" on the master's — never as two commissions.
//
// `kind`, `status` and a batch's state parse to a label when this build knows the word and fall back
// to the server's own string when it does not. A state added later must read as that state, not as a
// failure.
// ---------------------------------------------------------------------------

/** Where the agency sits: a master keeps its whole share, a sub passes part of its own up. */
enum class AgencyKind(val wire: String, val label: String) {
    MASTER("MASTER", "Master agency"),
    SUB("SUB", "Sub-agency"),
    ;

    companion object {
        fun fromWire(value: String?): AgencyKind? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

/** An agency, a host on its roster, or a sub-agency under it — one state machine for all three. */
enum class AgencyStatus(val wire: String, val label: String) {
    PENDING("PENDING", "Waiting for approval"),
    ACTIVE("ACTIVE", "Active"),
    SUSPENDED("SUSPENDED", "Suspended"),
    ;

    companion object {
        fun fromWire(value: String?): AgencyStatus? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

/** One payout batch, as far as the agency is allowed to see it: no operator name, no bank reference. */
enum class AgencySettlementStatus(val wire: String, val label: String) {
    DRAFT("DRAFT", "Not approved yet"),
    APPROVED("APPROVED", "Approved, awaiting payment"),
    PAID("PAID", "Paid"),
    VOID("VOID", "Cancelled"),
    ;

    companion object {
        fun fromWire(value: String?): AgencySettlementStatus? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

/** The master this agency reports to. Absent for a master, which has none. */
data class AgencyMaster(
    val name: String,
    /** Null means no share was agreed, so the master takes nothing. It is not a zero and not a gap. */
    val overrideBps: Int?,
    val overrideLabel: String,
)

data class AgencyEarnings(
    /** Lifetime commission counted on this roster, before any share goes up. */
    val accruedCoins: Int,
    val overrideCoins: Int,
    val retainedCoins: Int,
    /** Taken in from this agency's own sub-agencies. Always zero for a sub. */
    val receivedOverrideCoins: Int,
    val last30dCoins: Int,
    val last30dOverrideCoins: Int,
)

/** What is owed, in the account's own currency and minor units. Null until the first gift opens it. */
data class AgencyAccount(
    val currency: String,
    val availableMinor: Int,
    val pendingMinor: Int,
    val frozenMinor: Int,
)

/** The whole answer of `GET /api/agency/position` — the header card and the split it explains. */
data class AgencyPosition(
    val id: String,
    val name: String,
    val kind: AgencyKind?,
    val kindLabel: String,
    val status: AgencyStatus?,
    val statusLabel: String,
    /** What a new host on this roster is taken at, and which level decided it — the server's sentence. */
    val commissionLabel: String,
    val hostCount: Int,
    val activeHostCount: Int,
    val subAgencyCount: Int,
    val master: AgencyMaster?,
    val earnings: AgencyEarnings,
    val account: AgencyAccount?,
) {
    val isMaster: Boolean get() = kind == AgencyKind.MASTER
}

/** Read-only activity derived from persisted room creation and non-host participant-entry records. */
data class AgencyHostActivityTotals(
    val roomsCreated: Int, val roomsWithVisitors: Int, val memberVisits: Int, val uniqueVisitors: Int,
)
data class AgencyHostActivityDay(
    val date: String, val roomsCreated: Int, val roomsWithVisitors: Int, val memberVisits: Int, val uniqueVisitors: Int,
)
data class AgencyHostActivityRow(
    val username: String, val avatarUrl: String?, val roomsCreated: Int, val roomsWithVisitors: Int,
    val memberVisits: Int, val uniqueVisitors: Int,
)
data class AgencyHostActivityWeek(
    val weekStart: String, val roomsCreated: Int, val roomsWithVisitors: Int, val memberVisits: Int, val uniqueVisitors: Int,
)
data class AgencyHostActivityReport(
    val days: Int, val timezone: String, val totals: AgencyHostActivityTotals,
    val daily: List<AgencyHostActivityDay>, val weekly: List<AgencyHostActivityWeek>, val hosts: List<AgencyHostActivityRow>,
)

data class AgencyHostAttendanceTotals(
    val checkIns: Int, val hostsCheckedIn: Int, val hostAttendanceDays: Int,
)
data class AgencyHostAttendanceDay(
    val date: String, val checkIns: Int, val hostsCheckedIn: Int,
)
data class AgencyHostAttendanceRow(
    val username: String, val avatarUrl: String?, val checkIns: Int, val attendanceDays: Int, val lastCheckInAt: String?,
)
data class AgencyHostAttendanceReport(
    val days: Int, val timezone: String, val totals: AgencyHostAttendanceTotals,
    val daily: List<AgencyHostAttendanceDay>, val hosts: List<AgencyHostAttendanceRow>,
)

data class AgencyHostGoalRow(
    val username: String, val avatarUrl: String?, val attendanceDays: Int, val targetDays: Int,
    val progressPercent: Int, val remainingDays: Int, val metTarget: Boolean,
)
data class AgencyHostGoals(
    val weeklyAttendanceTargetDays: Int, val windowDays: Int, val timezone: String,
    val activeHostCount: Int, val hostsMeetingGoal: Int, val hosts: List<AgencyHostGoalRow>, val updatedAt: String,
)

/** One host on the roster. No phone number and no account id: those are the operator's columns. */
data class AgencyHostRow(
    val username: String,
    val avatarUrl: String?,
    val status: AgencyStatus?,
    val statusLabel: String,
    val joinedAt: String?,
    val commissionLabel: String,
    val accruedCoins: Int,
    val last30dCoins: Int,
)

/** One sub-agency, and what it keeps after its share comes up. */
data class AgencySubRow(
    val name: String,
    val status: AgencyStatus?,
    val statusLabel: String,
    val hostCount: Int,
    val activeHostCount: Int,
    val overrideLabel: String,
    val accruedCoins: Int,
    val overrideCoins: Int,
    val retainedCoins: Int,
)

/** One settled batch, in the money it pays rather than the coins it was counted from. */
data class AgencySettlementRow(
    val reference: String,
    val amountMinor: Int,
    val currency: String,
    val status: AgencySettlementStatus?,
    val statusLabel: String,
    val periodFrom: String?,
    val periodTo: String?,
    val entryCount: Int,
    val createdAt: String?,
    val paidAt: String?,
)


/** A live room owned by a host currently assigned to this agency. */
data class AgencyLiveRoom(
    val id: String,
    val title: String,
    val roomNumber: String,
    val hostUsername: String,
    val memberCount: Int,
)

/** A non-owner member currently present in an agency-scoped live room. */
data class AgencyRoomMember(
    val userId: String,
    val username: String,
    val role: String,
    val isMuted: Boolean,
)

/** Immutable moderation audit entry returned by the agency-scoped audit endpoint. */
data class AgencyRoomModerationAudit(
    val id: String,
    val targetUserId: String,
    val targetUsername: String,
    val actorUserId: String,
    val actorUsername: String,
    val action: String,
    val reason: String?,
    val createdAt: String?,
)
