package com.voiza.app.domain.usecase

import com.voiza.app.domain.model.GiftAnimatedEvent

/**
 * Scheduling rules for the room's realtime effects, kept out of Compose so they
 * are testable and so the numbers live in one place.
 *
 * The durations and caps follow the pacing of Tencent's TUILiveKit (MIT) gift/like
 * pipeline — that kit is the reference for how often a ticker row may replace
 * another and how long a takeover may hold the screen — but nothing here calls a
 * Tencent SDK: every event these functions act on is emitted by our own
 * backend/src/services/socket.service.ts.
 */
object RoomEffects {
    /**
     * Takeovers play one at a time and the waiting line is short on purpose: past
     * three, a viewer is watching a queue instead of a room.
     */
    const val TAKEOVER_MAX = 3

    /** Rows the gift column keeps on screen before the oldest scrolls away. */
    const val TICKER_MAX = 3

    /** How long a ticker row stays before it is dropped, even if more arrive. */
    const val GIFT_DISMISS_MS = 3_000L

    /** A burst of taps is reported once per window, not once per tap. */
    const val LIKE_FLUSH_MS = 6_000L

    /** The server refuses a like count outside 1..100, so never send more. */
    const val LIKE_MAX_REPORT = 100

    /** Hearts an inbound `room:liked` plays, spaced so a batch reads as a puff. */
    const val HEARTS_PER_EVENT = 3
    const val HEART_STAGGER_MS = 100L

    /** How long one heart flies, and how many may be in the air at once. */
    const val HEART_LIFE_MS = 1_000L
    const val HEART_MAX = 30

    /** How long a welcome banner holds before it slides away. */
    const val ENTRY_BANNER_MS = 4_000L

    /** Tiles per gift panel page: four across, two down. */
    const val PANEL_COLUMNS = 4
    const val PANEL_ROWS = 2
    const val PANEL_PAGE_SIZE = PANEL_COLUMNS * PANEL_ROWS

    /**
     * Add a full-screen gift to the takeover line.
     *
     * Your own gifts win the queue: when it is full, the first entry that is not
     * yours is dropped to make room. If every waiting entry is yours and this is
     * somebody else's gift, the incoming one is dropped instead of pushing our own
     * purchase out of the line.
     */
    fun enqueueTakeover(
        current: List<GiftAnimatedEvent>,
        incoming: GiftAnimatedEvent,
        myUserId: String?,
    ): List<GiftAnimatedEvent> {
        if (current.size < TAKEOVER_MAX) return current + incoming
        val waiting = current.indexOfFirst { it.sender.id != myUserId }
        if (waiting < 0 && incoming.sender.id != myUserId) return current
        // Nothing of ours is waiting, so the oldest slot goes; otherwise the first
        // gift that is not ours does, keeping our own purchases in line.
        val next = current.toMutableList()
        next.removeAt(if (waiting < 0) 0 else waiting)
        next.add(incoming)
        return next
    }

    /** Add a ticker row; the column always shows the most recent [TICKER_MAX]. */
    fun appendTicker(current: List<GiftAnimatedEvent>, incoming: GiftAnimatedEvent): List<GiftAnimatedEvent> =
        (current + incoming).takeLast(TICKER_MAX)

    /**
     * Size of a joiner's entry banner from their spend tier. Three steps because
     * that is what a viewer can actually distinguish in a two-second banner;
     * `users.vip_level` runs to 20 and is set by an operator, never self-service.
     */
    fun entryTier(vipLevel: Int?): Int = when {
        vipLevel == null -> 0
        vipLevel >= 10 -> 2
        vipLevel >= 5 -> 1
        else -> 0
    }
}
