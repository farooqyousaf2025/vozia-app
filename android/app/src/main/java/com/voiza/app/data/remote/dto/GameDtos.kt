package com.voiza.app.data.remote.dto

import com.google.gson.JsonElement
import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// Wire DTOs for the games contract (`/api/games` + `game:update`).
//
// The board itself arrives as `state`: one JSON object whose shape belongs to the
// game that owns it, so it stays a JsonElement here and is parsed per game key in
// data/mapper/GameMappers.kt. Whatever the server sends is already the public
// projection — Quiz Battle's answer keys are stripped before a session leaves the
// backend, and the client has no code path that looks for them.
// ---------------------------------------------------------------------------

data class GameDefinitionDto(
    @SerializedName("key") val key: String,
    @SerializedName("name") val name: String,
    @SerializedName("description") val description: String? = null,
    @SerializedName("minPlayers") val minPlayers: Int = 2,
    @SerializedName("maxPlayers") val maxPlayers: Int = 2,
    @SerializedName("turnTimeoutSeconds") val turnTimeoutSeconds: Int = 30,
    @SerializedName("entryFeeEnabled") val entryFeeEnabled: Boolean = false,
    @SerializedName("entryFeeDiamonds") val entryFeeDiamonds: Int = 0,
    @SerializedName("prizeEnabled") val prizeEnabled: Boolean = false,
    @SerializedName("commissionBps") val commissionBps: Int = 0,
    @SerializedName("dailyEntryLimit") val dailyEntryLimit: Int = 0,
    @SerializedName("rulesVersion") val rulesVersion: Int = 0,
    @SerializedName("isActive") val isActive: Boolean = true,
)

data class GameParticipantDto(
    @SerializedName("userId") val userId: String,
    @SerializedName("username") val username: String,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("position") val position: Int = 0,
    @SerializedName("status") val status: String = "JOINED",
    @SerializedName("score") val score: Int = 0,
    @SerializedName("rank") val rank: Int? = null,
    @SerializedName("entryFeeDiamonds") val entryFeeDiamonds: Int = 0,
    @SerializedName("prizeDiamonds") val prizeDiamonds: Int = 0,
    @SerializedName("ready") val ready: Boolean = false,
)

data class GamePayoutDto(
    @SerializedName("rank") val rank: Int,
    @SerializedName("userId") val userId: String,
    @SerializedName("diamonds") val diamonds: Int = 0,
)

/**
 * The pool split as the `game:update` emit sends it — the only place the server names the
 * per-seat payouts. A REST read carries [GameResultDto] instead.
 */
data class GameSettlementDto(
    @SerializedName("grossPool") val grossPool: Int = 0,
    @SerializedName("commission") val commission: Int = 0,
    @SerializedName("prizePool") val prizePool: Int = 0,
    @SerializedName("distributed") val distributed: Int = 0,
    @SerializedName("payouts") val payouts: List<GamePayoutDto> = emptyList(),
)

/**
 * `game_sessions.result`: what the settlement engine wrote when it closed the match. A REST read
 * carries this and not the emit's `settlement`, so the pool split survives a reload.
 */
data class GameResultDto(
    @SerializedName("grossPool") val grossPool: Int = 0,
    @SerializedName("commission") val commission: Int = 0,
    @SerializedName("prizePool") val prizePool: Int = 0,
    /** Pool left after commission and prizes: absorbed by the platform, not paid out. */
    @SerializedName("deductions") val deductions: Int = 0,
    @SerializedName("distributed") val distributed: Int = 0,
    @SerializedName("rulesVersion") val rulesVersion: Int = 0,
)

/**
 * A session, and at the same time one `game:update` emit: the server spreads the
 * session DTO and adds `phase`/`settlement`/`refunded` on top, so the three extras
 * live here as nullables instead of a second type that would drift from the first.
 */
data class GameSessionDto(
    @SerializedName("id") val id: String,
    @SerializedName("gameKey") val gameKey: String,
    @SerializedName("roomId") val roomId: String? = null,
    @SerializedName("createdBy") val createdBy: String = "",
    @SerializedName("status") val status: String = "WAITING",
    @SerializedName("settlementStatus") val settlementStatus: String = "PENDING",
    @SerializedName("rulesVersion") val rulesVersion: Int = 0,
    @SerializedName("state") val state: JsonElement? = null,
    @SerializedName("entryFeeDiamonds") val entryFeeDiamonds: Int = 0,
    @SerializedName("maxPlayers") val maxPlayers: Int = 2,
    @SerializedName("turnOwnerId") val turnOwnerId: String? = null,
    @SerializedName("turnDeadlineAt") val turnDeadlineAt: String? = null,
    @SerializedName("result") val result: GameResultDto? = null,
    @SerializedName("startedAt") val startedAt: String? = null,
    @SerializedName("endedAt") val endedAt: String? = null,
    @SerializedName("createdAt") val createdAt: String = "",
    @SerializedName("participants") val participants: List<GameParticipantDto> = emptyList(),
    @SerializedName("phase") val phase: String? = null,
    @SerializedName("settlement") val settlement: GameSettlementDto? = null,
    @SerializedName("refunded") val refunded: Int? = null,
)

data class CreateGameBody(
    @SerializedName("gameKey") val gameKey: String,
    @SerializedName("roomId") val roomId: String,
)

/**
 * A move. `payload` carries only the coordinates the engine reads (a cell, an option,
 * a piece) — there is no key here for a score, a dice value or a winner, because the
 * server computes those.
 */
data class GameActionBody(
    @SerializedName("type") val type: String,
    @SerializedName("payload") val payload: Map<String, Any?>,
)

data class GameReasonBody(@SerializedName("reason") val reason: String)

data class GameSessionEnvelope(@SerializedName("session") val session: GameSessionDto)

data class GameCatalogResponse(
    @SerializedName("games") val games: List<GameDefinitionDto> = emptyList(),
    @SerializedName("sessions") val sessions: List<GameSessionDto>? = null,
)

data class GameHistoryRowDto(
    @SerializedName("sessionId") val sessionId: String,
    @SerializedName("gameKey") val gameKey: String,
    @SerializedName("status") val status: String = "",
    @SerializedName("rank") val rank: Int? = null,
    @SerializedName("score") val score: Int = 0,
    @SerializedName("prizeDiamonds") val prizeDiamonds: Int = 0,
    @SerializedName("entryFeeDiamonds") val entryFeeDiamonds: Int = 0,
    @SerializedName("endedAt") val endedAt: String? = null,
    @SerializedName("createdAt") val createdAt: String = "",
)

data class GameHistoryResponse(
    @SerializedName("games") val games: List<GameHistoryRowDto> = emptyList(),
)

data class GameDisputeDto(
    @SerializedName("id") val id: String,
    @SerializedName("sessionId") val sessionId: String,
    @SerializedName("reason") val reason: String = "",
    @SerializedName("status") val status: String = "OPEN",
    @SerializedName("resolution") val resolution: String? = null,
    @SerializedName("createdAt") val createdAt: String = "",
    @SerializedName("reviewedAt") val reviewedAt: String? = null,
)

data class GameDisputeEnvelope(@SerializedName("dispute") val dispute: GameDisputeDto)
