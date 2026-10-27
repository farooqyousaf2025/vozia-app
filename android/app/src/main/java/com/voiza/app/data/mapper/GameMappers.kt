package com.voiza.app.data.mapper

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.voiza.app.data.remote.dto.GameDefinitionDto
import com.voiza.app.data.remote.dto.GameHistoryRowDto
import com.voiza.app.data.remote.dto.GameParticipantDto
import com.voiza.app.data.remote.dto.GameResultDto
import com.voiza.app.data.remote.dto.GameSessionDto
import com.voiza.app.data.remote.dto.GameSettlementDto
import com.voiza.app.domain.model.GameBoard
import com.voiza.app.domain.model.GameDefinition
import com.voiza.app.domain.model.GameHistoryRow
import com.voiza.app.domain.model.GameParticipant
import com.voiza.app.domain.model.GameParticipantStatus
import com.voiza.app.domain.model.GamePayout
import com.voiza.app.domain.model.GamePhase
import com.voiza.app.domain.model.GameSession
import com.voiza.app.domain.model.GameSettlement
import com.voiza.app.domain.model.GameSettlementStatus
import com.voiza.app.domain.model.GameStatus
import com.voiza.app.domain.model.LudoBoard
import com.voiza.app.domain.model.LudoSeat
import com.voiza.app.domain.model.QuizAnswerView
import com.voiza.app.domain.model.QuizBoard
import com.voiza.app.domain.model.QuizQuestionView
import com.voiza.app.domain.model.TicTacToeBoard
import java.text.SimpleDateFormat
import java.util.Locale

// ---------------------------------------------------------------------------
// Games: wire -> domain.
//
// `state` is the one field whose shape is not fixed by the contract, so it is read
// key by key here instead of being deserialised blind: a board the app cannot parse
// comes back as `Unsupported` and the screen says so, rather than crashing on a game
// the backend shipped first.
// ---------------------------------------------------------------------------

fun GameDefinitionDto.toDomain(): GameDefinition = GameDefinition(
    key = key,
    name = name,
    description = description,
    minPlayers = minPlayers,
    maxPlayers = maxPlayers,
    turnTimeoutSeconds = turnTimeoutSeconds,
    entryFeeEnabled = entryFeeEnabled,
    entryFeeDiamonds = entryFeeDiamonds,
    prizeEnabled = prizeEnabled,
    commissionBps = commissionBps,
    dailyEntryLimit = dailyEntryLimit,
    rulesVersion = rulesVersion,
    isActive = isActive,
)

fun GameParticipantDto.toDomain(): GameParticipant = GameParticipant(
    userId = userId,
    username = username,
    avatarUrl = avatarUrl,
    position = position,
    status = enumOrDefault(status, GameParticipantStatus.JOINED),
    score = score.toLong(),
    rank = rank,
    entryFeeDiamonds = entryFeeDiamonds,
    prizeDiamonds = prizeDiamonds,
    ready = ready,
)

fun GameSettlementDto.toDomain(): GameSettlement = GameSettlement(
    grossPool = grossPool,
    commission = commission,
    prizePool = prizePool,
    distributed = distributed,
    // The emit does not repeat this line of the settlement row; gross - commission - prize is the
    // identity the backend settles against, so it is arithmetic on the server's own numbers.
    deductions = grossPool - commission - prizePool,
    payouts = payouts.map { GamePayout(rank = it.rank, userId = it.userId, diamonds = it.diamonds) },
)

/**
 * A REST read carries `result` rather than the emit's `settlement`, and the per-seat prize is on
 * each participant — both written by the settlement engine, neither computed from a client figure.
 */
fun GameResultDto.toDomain(participants: List<GameParticipant>): GameSettlement = GameSettlement(
    grossPool = grossPool,
    commission = commission,
    prizePool = prizePool,
    distributed = distributed,
    deductions = deductions,
    payouts = participants
        .filter { it.prizeDiamonds > 0 }
        .map { GamePayout(rank = it.rank ?: (it.position + 1), userId = it.userId, diamonds = it.prizeDiamonds) },
)

fun GameSessionDto.toDomain(): GameSession {
    val seats = participants.map { it.toDomain() }
    return GameSession(
        id = id,
        gameKey = gameKey,
        roomId = roomId,
        createdBy = createdBy,
        status = enumOrDefault(status, GameStatus.WAITING),
        settlementStatus = enumOrDefault(settlementStatus, GameSettlementStatus.PENDING),
        rulesVersion = rulesVersion,
        board = parseBoard(gameKey, state),
        entryFeeDiamonds = entryFeeDiamonds,
        maxPlayers = maxPlayers,
        turnOwnerId = turnOwnerId,
        turnDeadlineAtMs = isoToEpochMs(turnDeadlineAt),
        startedAt = startedAt,
        endedAt = endedAt,
        createdAt = createdAt,
        participants = seats,
        phase = phase.toGamePhase(),
        settlement = settlement?.toDomain() ?: result?.toDomain(seats),
        refundedDiamonds = refunded,
    )
}

fun GameHistoryRowDto.toDomain(): GameHistoryRow = GameHistoryRow(
    sessionId = sessionId,
    gameKey = gameKey,
    status = enumOrDefault(status, GameStatus.WAITING),
    rank = rank,
    score = score,
    prizeDiamonds = prizeDiamonds,
    entryFeeDiamonds = entryFeeDiamonds,
    endedAt = endedAt,
    createdAt = createdAt,
)

/**
 * The `phase` tag on a `game:update`, in the lowercase the emit actually uses. `waiting` and
 * `lobby` are both the pre-match desk: one is a freshly opened table, the other a seat change.
 */
private fun String?.toGamePhase(): GamePhase = when (this) {
    "waiting", "lobby" -> GamePhase.LOBBY
    "ready" -> GamePhase.READY
    "playing" -> GamePhase.PLAYING
    "finished" -> GamePhase.FINISHED
    "cancelled" -> GamePhase.CANCELLED
    else -> GamePhase.UNKNOWN
}

// ---- Board parsing --------------------------------------------------------

internal fun parseBoard(gameKey: String, raw: JsonElement?): GameBoard {
    if (raw == null || !raw.isJsonObject) return GameBoard.NotStarted
    val obj = raw.asJsonObject
    return when (gameKey.uppercase(Locale.ROOT)) {
        "TIC_TAC_TOE" -> parseTicTacToe(obj)
        "QUIZ_BATTLE" -> parseQuiz(obj)
        "LUDO" -> parseLudo(obj)
        else -> GameBoard.Unsupported(gameKey)
    }
}

private fun parseTicTacToe(obj: JsonObject): TicTacToeBoard = TicTacToeBoard(
    grid = obj.optArray("grid").map { cell -> cell?.takeIf { it.isNumber }?.asInt },
    turnPosition = obj.optInt("turnPosition"),
    winnerPosition = obj.optNullableInt("winnerPosition"),
    winLine = obj.optArray("winLine").mapNotNull { it?.takeIf { e -> e.isNumber }?.asInt },
    draw = obj.optBoolean("draw"),
    timeoutPosition = obj.optNullableInt("timeoutPosition"),
    moveCount = obj.optInt("moveCount"),
)

private fun parseQuiz(obj: JsonObject): QuizBoard {
    val questions = obj.optArray("questions").mapNotNull { element ->
        if (element == null || !element.isJsonObject) return@mapNotNull null
        val q = element.asJsonObject
        QuizQuestionView(
            id = q.optInt("id"),
            prompt = q.optString("prompt"),
            options = q.optArray("options").mapNotNull { it?.takeIf { o -> o.isText }?.asString },
        )
    }
    val answers = mutableMapOf<String, MutableMap<Int, QuizAnswerView>>()
    obj.get("answers")?.takeIf { it.isJsonObject }?.asJsonObject?.entrySet()?.forEach { (userId, rounds) ->
        if (!rounds.isJsonObject) return@forEach
        val perRound = mutableMapOf<Int, QuizAnswerView>()
        rounds.asJsonObject.entrySet().forEach { (round, value) ->
            if (!value.isJsonObject) return@forEach
            val a = value.asJsonObject
            perRound[round.toIntOrNull() ?: return@forEach] = QuizAnswerView(
                optionIndex = a.optInt("optionIndex"),
                correct = a.optBoolean("correct"),
                points = a.optInt("points"),
                latencyMs = a.optInt("latencyMs"),
            )
        }
        answers[userId] = perRound
    }
    return QuizBoard(
        questions = questions,
        index = obj.optInt("index"),
        roundStartedAtMs = obj.optLong("roundStartedAtMs"),
        secondsPerQuestion = obj.optInt("secondsPerQuestion", 15),
        correctPoints = obj.optInt("correctPoints", 100),
        maxSpeedBonus = obj.optInt("maxSpeedBonus", 50),
        answers = answers,
        finished = obj.optBoolean("finished"),
    )
}

private fun parseLudo(obj: JsonObject): LudoBoard {
    val seats = mutableMapOf<Int, LudoSeat>()
    obj.get("players")?.takeIf { it.isJsonObject }?.asJsonObject?.entrySet()?.forEach { (key, value) ->
        if (!value.isJsonObject) return@forEach
        val seat = value.asJsonObject
        val position = key.toIntOrNull() ?: seat.optInt("position")
        seats[position] = LudoSeat(
            position = position,
            pieces = seat.optArray("pieces").mapNotNull { it?.takeIf { p -> p.isNumber }?.asInt },
            pendingRoll = seat.optNullableInt("pendingRoll"),
            piecesHome = seat.optInt("piecesHome"),
        )
    }
    return LudoBoard(
        startRoll = obj.optInt("startRoll", 6),
        turnPosition = obj.optInt("turnPosition"),
        seats = seats,
        finished = obj.optBoolean("finished"),
        winnerPosition = obj.optNullableInt("winnerPosition"),
        rollCount = obj.optInt("rollCount"),
    )
}

// ---- JSON + time helpers ---------------------------------------------------

/** Gson exposes primitive kind only on `JsonPrimitive`; boards arrive as loose JSON. */
private val JsonElement.isNumber: Boolean
    get() = isJsonPrimitive && asJsonPrimitive.isNumber

private val JsonElement.isText: Boolean
    get() = isJsonPrimitive && asJsonPrimitive.isString

private val JsonElement.isFlag: Boolean
    get() = isJsonPrimitive && asJsonPrimitive.isBoolean

/** Missing or wrongly-typed keys read as empty rather than throwing on the socket thread. */
private fun JsonObject.optArray(field: String): List<JsonElement?> =
    get(field)?.takeIf { it.isJsonArray }?.asJsonArray?.toList() ?: emptyList()

private fun JsonObject.optInt(field: String, fallback: Int = 0): Int =
    get(field)?.takeIf { it.isNumber }?.asInt ?: fallback

private fun JsonObject.optLong(field: String, fallback: Long = 0L): Long =
    get(field)?.takeIf { it.isNumber }?.asLong ?: fallback

private fun JsonObject.optBoolean(field: String, fallback: Boolean = false): Boolean =
    get(field)?.takeIf { it.isFlag }?.asBoolean ?: fallback

private fun JsonObject.optString(field: String, fallback: String = ""): String =
    get(field)?.takeIf { it.isText }?.asString ?: fallback

/** A nullable board field: JSON `null` and a missing key mean the same thing here. */
private fun JsonObject.optNullableInt(field: String): Int? =
    get(field)?.takeIf { it.isNumber }?.asInt

/**
 * `turnDeadlineAt` is an ISO-8601 UTC string. The countdown it feeds is a display
 * convenience measured against the device clock, so it is clamped at zero upstream:
 * the server's own timeout sweep is what actually ends a stalled turn.
 */
internal fun isoToEpochMs(value: String?): Long? {
    if (value.isNullOrBlank()) return null
    val patterns = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        "yyyy-MM-dd'T'HH:mm:ssXXX",
    )
    for (pattern in patterns) {
        val parsed = runCatching {
            SimpleDateFormat(pattern, Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
                .parse(value)
        }.getOrNull()
        if (parsed != null) return parsed.time
    }
    return null
}
