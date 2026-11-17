package com.voiza.app.domain.model

/**
 * The landing rankings (`/api/rankings`): three boards over the ledger, each readable live
 * (the window in progress) or settled (the finished one before it). Only a settled window pays
 * a podium reward, and the server decides the place, the amount and whether it was already taken.
 */

/** Which side of the ledger a board counts. The wire key is the server's own constant. */
enum class RankingBoardKind(val wire: String, val label: String) {
    HOST("host", "Host"),
    RICH("rich", "Rich"),
    GIFTER("gifter", "Gifter"),
}

/** The period tabs. The server names the actual window; these only select it. */
enum class RankingPeriod(val wire: String, val label: String) {
    DAY("day", "Daily"),
    WEEK("week", "Weekly"),
    MONTH("month", "Monthly"),
}

/** One ranked member. The position and the score are the server's aggregation, never a local sum. */
data class RankingLeader(
    val position: Int,
    val user: MiniUser,
    val earned: Long,
)

/** The caller's own row: their score, and the place the server counted for them (null = unranked). */
data class RankingSelf(val position: Int?, val earned: Long)

/**
 * The podium reward for the finished window of the selected period. `claimable` and `claimed`
 * are the server's answers; a client that flips them changes only what it draws.
 */
data class RankingReward(
    val periodKey: String,
    val position: Int,
    val amount: Int,
    val claimed: Boolean,
    val claimable: Boolean,
)

data class RankingBoard(
    val board: RankingBoardKind,
    val period: RankingPeriod,
    val settled: Boolean,
    /** The server's own name for the window it ranked ("Today", "Yesterday", "Last week"…). */
    val windowLabel: String,
    val windowKey: String,
    /** r_coin | diamond — what the scores are counted in. */
    val unit: String,
    val leaders: List<RankingLeader>,
    val self: RankingSelf?,
    val reward: RankingReward?,
)

/** What a claim returned: the receipt, and whether this tap was the one that minted. */
data class RankingClaimResult(
    val board: RankingBoardKind,
    val periodKey: String,
    val position: Int,
    val amount: Int,
    val alreadyClaimed: Boolean,
)