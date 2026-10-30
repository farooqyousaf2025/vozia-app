package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// GET /api/quests and POST /api/quests/checkin (migration 0020).
//
// Every number here is the server's. `progress` is incremented when a gift posts
// or a chat row is stored, `xpAwarded` is what the quest actually paid, and the
// date is resolved in the platform's reset timezone — a phone with a wrong clock
// cannot open tomorrow early.
// ---------------------------------------------------------------------------

data class DailyQuestDto(
    @SerializedName("key") val key: String? = null,
    @SerializedName("title") val title: String? = null,
    @SerializedName("description") val description: String? = null,
    @SerializedName("metric") val metric: String? = null,
    @SerializedName("target") val target: Int = 0,
    @SerializedName("progress") val progress: Int = 0,
    @SerializedName("xpReward") val xpReward: Int = 0,
    @SerializedName("completed") val completed: Boolean = false,
    @SerializedName("completedAt") val completedAt: String? = null,
    // What finishing it paid; 0 until then, and not necessarily `xpReward` if an
    // operator re-priced the quest after it was completed.
    @SerializedName("xpAwarded") val xpAwarded: Int = 0,
)

data class CheckInDto(
    @SerializedName("available") val available: Boolean = false,
    @SerializedName("done") val done: Boolean = false,
    @SerializedName("streakDay") val streakDay: Int = 0,
    @SerializedName("xpAwardedToday") val xpAwardedToday: Int = 0,
    @SerializedName("nextRewardXp") val nextRewardXp: Int = 0,
    @SerializedName("nextStreakDay") val nextStreakDay: Int = 0,
    @SerializedName("baseXp") val baseXp: Int = 0,
    @SerializedName("streakStepXp") val streakStepXp: Int = 0,
    @SerializedName("maxStreakDays") val maxStreakDays: Int = 0,
)

data class QuestsTodayDto(
    @SerializedName("date") val date: String? = null,
    @SerializedName("resetTimezone") val resetTimezone: String? = null,
    @SerializedName("quests") val quests: List<DailyQuestDto>? = null,
    @SerializedName("completedCount") val completedCount: Int = 0,
    @SerializedName("xpEarnedToday") val xpEarnedToday: Int = 0,
    @SerializedName("checkIn") val checkIn: CheckInDto? = null,
)

/** 201 from POST /api/quests/checkin: what it paid, the refreshed status, and the account. */
data class CheckInResponseDto(
    @SerializedName("xpAwarded") val xpAwarded: Int = 0,
    @SerializedName("status") val status: QuestsTodayDto? = null,
    @SerializedName("user") val user: UserDto? = null,
)
