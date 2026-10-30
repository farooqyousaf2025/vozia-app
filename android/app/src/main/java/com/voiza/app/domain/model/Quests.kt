package com.voiza.app.domain.model

/**
 * One daily quest as the server resolved it for this member (migration 0020).
 *
 * [progress] is a counter the server incremented when a gift posted or a chat row was stored;
 * nothing on the phone can raise it. [xpAwarded] is what finishing it actually paid, which is why
 * it is shown instead of [xpReward] on a completed row — an operator may have re-priced the quest
 * after it was completed.
 */
data class DailyQuest(
    val key: String,
    val title: String,
    val description: String,
    /** GIFT_SENT | DIAMONDS_SPENT | CHAT_MESSAGE — the server-side event that advances it. */
    val metric: String,
    val target: Int,
    val progress: Int,
    val xpReward: Int,
    val completed: Boolean,
    val completedAt: String?,
    val xpAwarded: Int,
) {
    /** How far along the bar is; a target of zero can only come from a broken row, so it stays empty. */
    val fraction: Float
        get() = if (target <= 0) 0f else (progress.toFloat() / target).coerceIn(0f, 1f)

    /** How much is still missing, never negative even if the server capped progress at the target. */
    val remaining: Int get() = (target - progress).coerceAtLeast(0)

    /** "2 / 50" — the counter as the server stores it, capped at the target for display. */
    val progressLabel: String get() = "${progress.coerceAtMost(target)} / $target"
}

/**
 * Today's check-in, with the streak the server computed from yesterday's row.
 *
 * [streakDay] is the streak that stands right now (today's row, or yesterday's while today is
 * still open), and [nextRewardXp] is what the next check-in pays. Both are server answers, so the
 * screen never adds a step itself.
 */
data class CheckInState(
    val available: Boolean,
    val done: Boolean,
    val streakDay: Int,
    val xpAwardedToday: Int,
    val nextRewardXp: Int,
    val nextStreakDay: Int,
    val baseXp: Int,
    val streakStepXp: Int,
    val maxStreakDays: Int,
) {
    /** How many dots to light: the streak in progress, counting today once it is claimed. */
    val litDays: Int get() = streakDay.coerceIn(0, maxStreakDays)
}

/** GET /api/quests: the day, its quests, and the check-in state for this member. */
data class QuestsToday(
    /** The server's local date (`YYYY-MM-DD`) in [resetTimezone]. */
    val date: String,
    val resetTimezone: String,
    val quests: List<DailyQuest>,
    val completedCount: Int,
    val xpEarnedToday: Int,
    val checkIn: CheckInState?,
) {
    val allDone: Boolean get() = quests.isNotEmpty() && completedCount >= quests.size
}

/** POST /api/quests/checkin: what it paid and the status as it now stands. */
data class CheckInResult(
    val xpAwarded: Int,
    val status: QuestsToday?,
)
