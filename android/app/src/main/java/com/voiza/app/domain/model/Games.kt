package com.voiza.app.domain.model

// ---------------------------------------------------------------------------
// Games domain model — the client's read of one authoritative engine.
//
// Nothing here decides a winner, a score, a dice value or a payout. The board types
// below exist so a screen can draw what the server said, and so a tap can be turned
// into the one coordinate the engine expects. Every rule that moves money lives in
// the backend; the numbers shown here are echoes of it.
// ---------------------------------------------------------------------------

/** `game_session_status`. WAITING -> READY -> IN_PROGRESS -> COMPLETED, plus the exits. */
enum class GameStatus { WAITING, READY, IN_PROGRESS, COMPLETED, CANCELLED, DISPUTED }

/** `game_settlement_status`. PENDING means no money has moved yet. */
enum class GameSettlementStatus { PENDING, SETTLED, PARTIAL, REFUNDED, DISPUTED }

/** `game_participant_status`. */
enum class GameParticipantStatus { REQUESTED, JOINED, READY, PLAYING, COMPLETED, LEFT, DISCONNECTED }

/**
 * The phase tag the server adds to a `game:update`. It says why the board changed,
 * which the session row alone cannot (a fresh WAITING row and a cancelled one look
 * alike apart from this).
 */
enum class GamePhase { LOBBY, READY, PLAYING, FINISHED, CANCELLED, UNKNOWN }

data class GameDefinition(
    val key: String,
    val name: String,
    val description: String?,
    val minPlayers: Int,
    val maxPlayers: Int,
    val turnTimeoutSeconds: Int,
    val entryFeeEnabled: Boolean,
    val entryFeeDiamonds: Int,
    val prizeEnabled: Boolean,
    val commissionBps: Int,
    val dailyEntryLimit: Int,
    val rulesVersion: Int,
    val isActive: Boolean,
) {
    /** A disabled fee is a zero fee, and the lobby charges what the definition says. */
    val fee: Int get() = if (entryFeeEnabled) entryFeeDiamonds else 0

    /** "2-4 players" or "2 players", for the one line the card has room for. */
    val playerRange: String
        get() = if (minPlayers == maxPlayers) "$minPlayers players" else "$minPlayers-$maxPlayers players"
}

data class GameParticipant(
    val userId: String,
    val username: String,
    val avatarUrl: String?,
    /** Board seat, assigned by the engine in join order. Never chosen by a client. */
    val position: Int,
    val status: GameParticipantStatus,
    /** Game Points — not money, not purchasable, not withdrawable. */
    val score: Long,
    val rank: Int?,
    val entryFeeDiamonds: Int,
    val prizeDiamonds: Int,
    val ready: Boolean,
) {
    val isLive: Boolean
        get() = status == GameParticipantStatus.PLAYING ||
            status == GameParticipantStatus.JOINED ||
            status == GameParticipantStatus.READY
}

data class GamePayout(val rank: Int, val userId: String, val diamonds: Int)

/** Where every diamond of the pool went, as the settlement engine reported it. */
data class GameSettlement(
    val grossPool: Int,
    val commission: Int,
    val prizePool: Int,
    val distributed: Int,
    /** What the platform kept: pool minus commission minus prizes actually paid out. */
    val deductions: Int,
    val payouts: List<GamePayout>,
)

// ---- Boards ---------------------------------------------------------------

sealed interface GameBoard {
    /** A game this build can play but not draw (an engine added server-side first). */
    data class Unsupported(val gameKey: String) : GameBoard

    /** WAITING/READY: the opening board does not exist until the match starts. */
    data object NotStarted : GameBoard
}

/** Tic-Tac-Toe. A cell holds a *seat*, so a tap can only ever claim the mover's own. */
data class TicTacToeBoard(
    val grid: List<Int?>,
    val turnPosition: Int,
    val winnerPosition: Int?,
    val winLine: List<Int>,
    val draw: Boolean,
    val timeoutPosition: Int?,
    val moveCount: Int,
) : GameBoard {
    val isOver: Boolean get() = winnerPosition != null || draw
    fun isEmpty(cell: Int): Boolean = grid.getOrElse(cell) { 0 } == null
}

data class QuizQuestionView(val id: Int, val prompt: String, val options: List<String>)

/** One answer the server accepted, with the points it awarded. */
data class QuizAnswerView(val optionIndex: Int, val correct: Boolean, val points: Int, val latencyMs: Int)

/**
 * Quiz Battle. There is no turn owner: every seat answers the same live round, and
 * `answers` is keyed by userId so a player sees who has committed without seeing
 * what they committed — the payload carries no answer key to check against.
 */
data class QuizBoard(
    val questions: List<QuizQuestionView>,
    val index: Int,
    val roundStartedAtMs: Long,
    val secondsPerQuestion: Int,
    val correctPoints: Int,
    val maxSpeedBonus: Int,
    val answers: Map<String, Map<Int, QuizAnswerView>>,
    val finished: Boolean,
) : GameBoard {
    val liveQuestion: QuizQuestionView? get() = questions.getOrNull(index)
    fun hasAnswered(userId: String?): Boolean = !userId.isNullOrEmpty() && answers.containsKey(userId)
    fun answerOf(userId: String?, round: Int): QuizAnswerView? =
        userId?.let { answers[it] }?.get(round)

    /** Every seat's answer for a round, in seat order, for the reveal strip. */
    fun roundResults(round: Int, players: List<GameParticipant>): List<GameParticipant> =
        players.sortedByDescending { answerOf(it.userId, round)?.points ?: -1 }
}

data class LudoSeat(
    val position: Int,
    /** One entry per token: -1 in the yard, HOME (57) finished, otherwise steps travelled. */
    val pieces: List<Int>,
    /** A die roll waiting to be spent. Cleared by a move, a pass or the clock. */
    val pendingRoll: Int?,
    val piecesHome: Int,
) {
    val total: Int get() = pieces.size

    /**
     * Which tokens this seat may move with `roll`. Mirrors the engine's rule so the
     * screen can grey out impossible taps — the engine re-checks every one of them,
     * so a client that lies about this list simply gets its move rejected.
     */
    fun legalPieces(roll: Int, startRoll: Int, home: Int): List<Int> =
        pieces.mapIndexedNotNull { piece, steps ->
            when {
                steps == -1 -> if (roll == startRoll) piece else null
                steps >= home -> null
                steps + roll <= home -> piece
                else -> null
            }
        }
}

/** Ludo, drawn as a linear track: the engine only exposes steps travelled per token. */
data class LudoBoard(
    val startRoll: Int,
    val turnPosition: Int,
    val seats: Map<Int, LudoSeat>,
    val finished: Boolean,
    val winnerPosition: Int?,
    val rollCount: Int,
) : GameBoard {
    val trackLength: Int get() = LUDO_TRACK + LUDO_HOME_COLUMN
    fun seat(position: Int): LudoSeat? = seats[position]
}

const val LUDO_TRACK = 52
const val LUDO_HOME_COLUMN = 6
const val LUDO_HOME = LUDO_TRACK + LUDO_HOME_COLUMN - 1
const val LUDO_YARD = -1

/** Squares where a token cannot be captured: each lane's entry and the eight after it. */
val LUDO_SAFE_CELLS: Set<Int> = setOf(0, 8, 13, 21, 26, 34, 39, 47)

// ---- Session --------------------------------------------------------------

data class GameSession(
    val id: String,
    val gameKey: String,
    val roomId: String?,
    val createdBy: String,
    val status: GameStatus,
    val settlementStatus: GameSettlementStatus,
    val rulesVersion: Int,
    val board: GameBoard,
    val entryFeeDiamonds: Int,
    val maxPlayers: Int,
    val turnOwnerId: String?,
    /** Device-clock millis; null when the game is not waiting on anyone's clock. */
    val turnDeadlineAtMs: Long?,
    val startedAt: String?,
    val endedAt: String?,
    val createdAt: String,
    val participants: List<GameParticipant>,
    val phase: GamePhase,
    val settlement: GameSettlement?,
    val refundedDiamonds: Int?,
) {
    val isOver: Boolean get() = status == GameStatus.COMPLETED || status == GameStatus.CANCELLED
    val isOpen: Boolean get() = status == GameStatus.WAITING || status == GameStatus.READY

    fun participant(userId: String?): GameParticipant? =
        userId?.let { id -> participants.firstOrNull { it.userId == id } }

    /** Seat label for a board cell: whoever owns that seat, or an empty seat. */
    fun nameOfPosition(position: Int?): String? =
        position?.let { pos -> participants.firstOrNull { it.position == pos }?.username }

    val livePlayers: List<GameParticipant> get() = participants.filter { it.isLive }

    /** Winners first, then by seat; a draw leaves ranks null so seat order holds. */
    val standings: List<GameParticipant>
        get() = participants.sortedWith(
            Comparator<GameParticipant> { a, b ->
                val left = a.rank
                val right = b.rank
                when {
                    left == null && right == null -> a.position.compareTo(b.position)
                    left == null -> 1
                    right == null -> -1
                    else -> left.compareTo(right)
                }
            },
        )

    fun canJoin(userId: String?): Boolean {
        if (userId == null || status != GameStatus.WAITING) return false
        val me = participant(userId)
        if (me != null && me.status != GameParticipantStatus.LEFT) return false
        return participants.count { it.isLive } < maxPlayers
    }

    /** Only the host who opened the game may start it; the server enforces the same. */
    fun canStart(userId: String?): Boolean =
        userId != null && status == GameStatus.READY && createdBy == userId

    fun canCancel(userId: String?): Boolean =
        userId != null && isOpen && createdBy == userId
}

/** Whole seconds left on the clock, never negative. A display aid: the server forfeits. */
fun remainingSeconds(turnDeadlineAtMs: Long?, nowMs: Long): Int? {
    val deadline = turnDeadlineAtMs ?: return null
    return maxOf(0, ((deadline - nowMs) / 1_000L).toInt())
}

/** One row of GET /api/games/me/history: what this account played, and what it paid for it. */
data class GameHistoryRow(
    val sessionId: String,
    val gameKey: String,
    val status: GameStatus,
    val rank: Int?,
    val score: Int,
    val prizeDiamonds: Int,
    val entryFeeDiamonds: Int,
    val endedAt: String?,
    val createdAt: String,
) {
    /** Fee is spent, prize is won; the net line the player actually cares about. */
    val netDiamonds: Int get() = prizeDiamonds - entryFeeDiamonds
}
