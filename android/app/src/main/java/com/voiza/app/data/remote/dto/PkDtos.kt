package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// /api/pk (migration 0021). Two rooms, one clock, and a gift race whose score
// is the ledger's sum of GIFT_SENT diamonds inside the battle window.
//
// Nothing in this file is a number the phone may set: `scores` are read from
// `transactions` by the server on every read, frozen only when the battle ends.
// The DTO fields are nullable because Gson builds the class without running
// Kotlin initialisers — a missing key must land as null, never as a made-up 0.
// ---------------------------------------------------------------------------

data class PkRoomDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("title") val title: String? = null,
    @SerializedName("coverUrl") val coverUrl: String? = null,
    @SerializedName("hostId") val hostId: String? = null,
    @SerializedName("hostUsername") val hostUsername: String? = null,
)

data class PkScoresDto(
    @SerializedName("a") val a: Int = 0,
    @SerializedName("b") val b: Int = 0,
)

data class PkBattleDto(
    @SerializedName("id") val id: String? = null,
    /** INVITED | ACTIVE | FINISHED | DECLINED | CANCELLED | EXPIRED */
    @SerializedName("status") val status: String? = null,
    @SerializedName("roomA") val roomA: PkRoomDto? = null,
    @SerializedName("roomB") val roomB: PkRoomDto? = null,
    @SerializedName("durationSeconds") val durationSeconds: Int = 0,
    @SerializedName("scores") val scores: PkScoresDto? = null,
    /** Always "diamond" today; carried so a change of unit is a server decision. */
    @SerializedName("unit") val unit: String? = null,
    @SerializedName("invitedAt") val invitedAt: String? = null,
    @SerializedName("inviteExpiresAt") val inviteExpiresAt: String? = null,
    @SerializedName("startedAt") val startedAt: String? = null,
    @SerializedName("endsAt") val endsAt: String? = null,
    @SerializedName("finishedAt") val finishedAt: String? = null,
    @SerializedName("remainingMs") val remainingMs: Long = 0,
    @SerializedName("winnerRoomId") val winnerRoomId: String? = null,
    /** XP actually paid to the winning room's top spender; 0 when there was none. */
    @SerializedName("bonusXp") val bonusXp: Int = 0,
    @SerializedName("bonusUserId") val bonusUserId: String? = null,
    /** True when an operator ended it before the clock. */
    @SerializedName("stopped") val stopped: Boolean = false,
)

data class PkSettingsDto(
    @SerializedName("isEnabled") val isEnabled: Boolean = false,
    @SerializedName("inviteTimeoutSeconds") val inviteTimeoutSeconds: Int = 0,
    @SerializedName("minDurationSeconds") val minDurationSeconds: Int = 0,
    @SerializedName("defaultDurationSeconds") val defaultDurationSeconds: Int = 0,
    @SerializedName("maxDurationSeconds") val maxDurationSeconds: Int = 0,
    @SerializedName("winnerBonusXp") val winnerBonusXp: Int = 0,
)

data class PkSettingsEnvelope(
    @SerializedName("settings") val settings: PkSettingsDto? = null,
)

data class PkBattleEnvelope(
    @SerializedName("battle") val battle: PkBattleDto? = null,
)

data class PkHistoryResponse(
    @SerializedName("battles") val battles: List<PkBattleDto>? = null,
)

/** No score, winner or experience field: the server reads the gift ledger instead. */
data class PkInviteBody(
    @SerializedName("roomId") val roomId: String,
    @SerializedName("opponentRoomId") val opponentRoomId: String,
    @SerializedName("durationSeconds") val durationSeconds: Int? = null,
)
