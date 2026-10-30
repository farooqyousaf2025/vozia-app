package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.CheckInDto
import com.voiza.app.data.remote.dto.CheckInResponseDto
import com.voiza.app.data.remote.dto.DailyQuestDto
import com.voiza.app.data.remote.dto.QuestsTodayDto
import com.voiza.app.domain.model.CheckInResult
import com.voiza.app.domain.model.CheckInState
import com.voiza.app.domain.model.DailyQuest
import com.voiza.app.domain.model.QuestsToday

// ---------------------------------------------------------------------------
// Quests (migration 0020). Every field is copied; the only derived values live
// on the domain model as display helpers, so nothing here invents progress or a
// reward. Absent collections become empty rather than a crash, because Gson
// builds a Kotlin data class without running its initialisers.
// ---------------------------------------------------------------------------

fun DailyQuestDto.toDomain(): DailyQuest = DailyQuest(
    key = key.orEmpty(),
    title = title.orEmpty(),
    description = description.orEmpty(),
    metric = metric.orEmpty(),
    target = target,
    progress = progress,
    xpReward = xpReward,
    completed = completed,
    completedAt = completedAt,
    xpAwarded = xpAwarded,
)

fun CheckInDto.toDomain(): CheckInState = CheckInState(
    available = available,
    done = done,
    streakDay = streakDay,
    xpAwardedToday = xpAwardedToday,
    nextRewardXp = nextRewardXp,
    nextStreakDay = nextStreakDay,
    baseXp = baseXp,
    streakStepXp = streakStepXp,
    maxStreakDays = maxStreakDays,
)

fun QuestsTodayDto.toDomain(): QuestsToday = QuestsToday(
    date = date.orEmpty(),
    resetTimezone = resetTimezone.orEmpty(),
    quests = quests.orEmpty().map { it.toDomain() },
    completedCount = completedCount,
    xpEarnedToday = xpEarnedToday,
    checkIn = checkIn?.toDomain(),
)

fun CheckInResponseDto.toDomain(): CheckInResult = CheckInResult(
    xpAwarded = xpAwarded,
    status = status?.toDomain(),
)
