package com.voiza.app.domain.model

/**
 * A PK battle: two rooms, one clock, and the diamonds their supporters spent inside the window
 * (migration 0021).
 *
 * [scoreA] and [scoreB] are the server's answer. While the battle runs they are re-summed from the
 * `transactions` rows that moved the diamonds; once it is FINISHED they are the frozen result the
 * prize was paid on. Nothing on the phone can raise either number, and the countdown on the screen
 * is decoration — the server's sweeper decides when the race is over.
 */
data class PkBattle(
    val id: String,
    val status: PkStatus,
    val roomA: PkRoomRef,
    val roomB: PkRoomRef,
    val durationSeconds: Int,
    val scoreA: Int,
    val scoreB: Int,
    val invitedAt: String?,
    val inviteExpiresAt: String?,
    /** The same instant as [inviteExpiresAt], parsed so the invitation can count down. */
    val inviteExpiresAtMs: Long?,
    val startedAt: String?,
    val endsAt: String?,
    /** The same instant as [endsAt], parsed so the live clock can count down. */
    val endsAtMs: Long?,
    val finishedAt: String?,
    val remainingMs: Long,
    val winnerRoomId: String?,
    val bonusXp: Int,
    val bonusUserId: String?,
    val stopped: Boolean,
) {
    val isInvited: Boolean get() = status == PkStatus.INVITED
    val isActive: Boolean get() = status == PkStatus.ACTIVE
    val isFinished: Boolean get() = status == PkStatus.FINISHED

    /** Finished with equal totals: no winner and no prize. */
    val isDraw: Boolean get() = isFinished && winnerRoomId == null

    val winnerRoom: PkRoomRef?
        get() = when (winnerRoomId) {
            roomA.id -> roomA
            roomB.id -> roomB
            else -> null
        }

    /** The side [roomId] fights on, or null when it is not in this battle. */
    fun sideOf(roomId: String?): PkSide? = when (roomId) {
        roomA.id -> PkSide.A
        roomB.id -> PkSide.B
        else -> null
    }

    /** The room across the table from [roomId]. */
    fun opponentOf(roomId: String?): PkRoomRef? = when (sideOf(roomId)) {
        PkSide.A -> roomB
        PkSide.B -> roomA
        null -> null
    }

    val scoreOfA: Int get() = scoreA
    val total: Int get() = scoreA + scoreB

    /** Share of the bar given to A, so the two bars always add up to one. */
    val fractionA: Float
        get() = if (total <= 0) 0.5f else (scoreA.toFloat() / total).coerceIn(0f, 1f)

    /** "02:35" — how much of the agreed window is left, for the countdown label only. */
    fun clockLabel(remaining: Long = remainingMs): String {
        val seconds = (remaining.coerceAtLeast(0) / 1000).toInt()
        return "%02d:%02d".format(seconds / 60, seconds % 60)
    }

    /**
     * What the clock reads at [nowMs]. This is decoration on the phone: the server's sweeper is
     * what ends a race, so the label never drives a state change by itself.
     */
    fun remainingAt(nowMs: Long): Long {
        if (!isActive) return 0
        val end = endsAtMs ?: return remainingMs
        return (end - nowMs).coerceAtLeast(0)
    }

    /** How long the challenged host still has to answer, or 0 once it is no longer open. */
    fun inviteRemainingAt(nowMs: Long): Long {
        if (!isInvited) return 0
        val end = inviteExpiresAtMs ?: return 0
        return (end - nowMs).coerceAtLeast(0)
    }
}

enum class PkStatus {
    INVITED,
    ACTIVE,
    FINISHED,
    DECLINED,
    CANCELLED,
    EXPIRED,

    /** A status this build does not know; treated as "nothing to show", never as live. */
    UNKNOWN,
}

enum class PkSide { A, B }

/** The two rooms as a battle names them: just enough to draw the scoreboard. */
data class PkRoomRef(
    val id: String,
    val title: String,
    val coverUrl: String?,
    val hostId: String,
    val hostUsername: String,
)

/** The dials an operator owns, read from `GET /api/pk/settings`. */
data class PkSettings(
    val isEnabled: Boolean,
    val inviteTimeoutSeconds: Int,
    val minDurationSeconds: Int,
    val defaultDurationSeconds: Int,
    val maxDurationSeconds: Int,
    val winnerBonusXp: Int,
) {
    /** The durations the invitation form may offer, in the range the server will accept. */
    fun durationChoices(): List<Int> {
        if (maxDurationSeconds < minDurationSeconds) return listOf(defaultDurationSeconds)
        val presets = listOf(60, 120, 180, 300, 600, 900, 1800)
        val within = presets.filter { it in minDurationSeconds..maxDurationSeconds }
        return (listOf(defaultDurationSeconds) + within).distinct().sorted()
    }
}
