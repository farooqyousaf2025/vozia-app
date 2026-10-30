package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.PkBattleDto
import com.voiza.app.data.remote.dto.PkRoomDto
import com.voiza.app.data.remote.dto.PkSettingsDto
import com.voiza.app.domain.model.PkBattle
import com.voiza.app.domain.model.PkRoomRef
import com.voiza.app.domain.model.PkSettings
import com.voiza.app.domain.model.PkStatus

// ---------------------------------------------------------------------------
// PK battles (migration 0021). Every figure is copied from the server; the only
// arithmetic in this feature lives on the domain model as a display helper.
// Gson builds these classes without running initialisers, so nullable fields
// are expected and a battle without rooms cannot be shown at all: it maps to
// null and the caller keeps its empty state.
// ---------------------------------------------------------------------------

fun PkRoomDto.toDomain(): PkRoomRef? {
    val id = id ?: return null
    return PkRoomRef(
        id = id,
        title = title.orEmpty(),
        coverUrl = coverUrl,
        hostId = hostId.orEmpty(),
        hostUsername = hostUsername.orEmpty(),
    )
}

fun PkBattleDto.toDomain(): PkBattle? {
    val id = id ?: return null
    val a = roomA?.toDomain() ?: return null
    val b = roomB?.toDomain() ?: return null
    return PkBattle(
        id = id,
        status = status.toPkStatus(),
        roomA = a,
        roomB = b,
        durationSeconds = durationSeconds,
        scoreA = scores?.a ?: 0,
        scoreB = scores?.b ?: 0,
        invitedAt = invitedAt,
        inviteExpiresAt = inviteExpiresAt,
        inviteExpiresAtMs = isoToEpochMs(inviteExpiresAt),
        startedAt = startedAt,
        endsAt = endsAt,
        endsAtMs = isoToEpochMs(endsAt),
        finishedAt = finishedAt,
        remainingMs = remainingMs,
        winnerRoomId = winnerRoomId,
        bonusXp = bonusXp,
        bonusUserId = bonusUserId,
        stopped = stopped,
    )
}

/** An unrecognised status is not live: an older phone must never draw a ghost race. */
fun String?.toPkStatus(): PkStatus = when (this?.uppercase()) {
    "INVITED" -> PkStatus.INVITED
    "ACTIVE" -> PkStatus.ACTIVE
    "FINISHED" -> PkStatus.FINISHED
    "DECLINED" -> PkStatus.DECLINED
    "CANCELLED" -> PkStatus.CANCELLED
    "EXPIRED" -> PkStatus.EXPIRED
    else -> PkStatus.UNKNOWN
}

fun PkSettingsDto.toDomain(): PkSettings = PkSettings(
    isEnabled = isEnabled,
    inviteTimeoutSeconds = inviteTimeoutSeconds,
    minDurationSeconds = minDurationSeconds,
    defaultDurationSeconds = defaultDurationSeconds,
    maxDurationSeconds = maxDurationSeconds,
    winnerBonusXp = winnerBonusXp,
)
