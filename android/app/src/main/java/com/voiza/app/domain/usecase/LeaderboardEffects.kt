package com.voiza.app.domain.usecase

import com.voiza.app.domain.model.RankingLeader
import com.voiza.app.domain.model.RankingSelf

/**
 * Pure display math for the landing rankings. Nothing here scores or re-ranks: the server's
 * positions arrive final, and these functions only decide how they are laid out and labelled.
 */

/** The server's cap on a board's length; a place beyond it is drawn as "50+", never guessed. */
const val RANKING_BOARD_LIMIT = 50

/**
 * The podium in display order: second on the left, first in the centre, third on the right.
 * Slots without a leader stay null so a board with one or two names still draws its pedestal.
 */
fun podiumSlots(leaders: List<RankingLeader>): List<RankingLeader?> {
    val byPlace = leaders.take(3)
    return listOf(
        byPlace.getOrNull(1),
        byPlace.getOrNull(0),
        byPlace.getOrNull(2),
    )
}

/**
 * The pinned self row's place label. A member the server did not rank (no score in the window,
 * or a place past the cap) reads as "50+" — the list ends at fifty, so anything below it is
 * "below the board", not a number the client invented.
 */
fun selfPlaceLabel(self: RankingSelf?, limit: Int = RANKING_BOARD_LIMIT): String =
    when {
        self == null -> ""
        self.position == null || self.position > limit -> "$limit+"
        else -> self.position.toString()
    }

/** The unit a board counts in, as a member reads it: coins earned, diamonds spent. */
fun rankingUnitLabel(unit: String): String = when (unit) {
    "r_coin" -> "coins"
    else -> "diamonds"
}

/** Compact score text: 1234567 becomes "1.23M", 12345 becomes "12.3K", small scores stay whole. */
fun compactScore(value: Long): String = when {
    value >= 1_000_000 -> trimZero(String.format("%.2f", value / 1_000_000.0)) + "M"
    value >= 10_000 -> trimZero(String.format("%.1f", value / 1_000.0)) + "K"
    else -> value.toString()
}

private fun trimZero(s: String): String = s.trimEnd('0').trimEnd('.')