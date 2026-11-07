package com.voiza.app.domain.usecase

import com.voiza.app.domain.model.ChatMessage
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

    /**
     * Quick reactions. A tap flies the emoji more than once because one small picture crossing the
     * screen reads as nothing, and a life longer than a heart's because art needs a beat to be
     * recognised. The floor under consecutive sends exists for the server's sake: `room:reaction`
     * allows twenty per five seconds, and a client that stays under it never has a tap silently
     * swallowed by a rate limiter.
     */
    const val REACTIONS_PER_TAP = 3
    const val REACTION_STAGGER_MS = 110L
    const val REACTION_LIFE_MS = 1_400L
    const val REACTION_MAX = 24
    const val REACTION_TAP_MS = 300L

    /**
     * Emoji the strip offers, taken from the front of the picker list. That order is the operator's
     * — `GET /api/emoji` returns `emoji_characters` in the sequence they set — so the room's most
     * prominent reactions are theirs to choose, and a panel with one row simply shows one button.
     */
    const val REACTION_STRIP_MAX = 6

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
     *
     * `displayPriority` is the catalogue's say-so over that: an operator who priced a whale
     * animation above a rose means it, so a quieter gift is displaced before a louder one, and a
     * gift quieter than the whole waiting line never displaces our own.
     */
    fun enqueueTakeover(
        current: List<GiftAnimatedEvent>,
        incoming: GiftAnimatedEvent,
        myUserId: String?,
    ): List<GiftAnimatedEvent> {
        if (isDuplicateInList(current, incoming)) return current
        if (current.size < TAKEOVER_MAX) return current + incoming
        val victim = current.minWith(
            compareBy({ it.gift.displayPriority }, { if (it.sender.id == myUserId) 1 else 0 })
        )
        if (victim.sender.id == myUserId && incoming.sender.id != myUserId &&
            victim.gift.displayPriority >= incoming.gift.displayPriority
        ) {
            return current
        }
        // Removed by identity: two events for the same gift from the same sender can be
        // structurally equal, and the wrong one leaving the line would change what plays.
        val next = current.toMutableList()
        next.removeAt(current.indexOfFirst { it === victim })
        return next + incoming
    }

    /** Add a ticker row; the column always shows the most recent [TICKER_MAX]. */
    fun appendTicker(
        current: List<GiftAnimatedEvent>,
        incoming: GiftAnimatedEvent,
    ): List<GiftAnimatedEvent> {
        if (isDuplicateInList(current, incoming)) return current
        return (current + incoming).takeLast(TICKER_MAX)
    }

    /**
     * Whether this gift is already on the screen the caller is about to update.
     *
     * The id is the only key both delivery paths carry: a gift sent while the socket was down
     * arrives on `room:gift_history` with the same id the live `room:gift_animated` used, and a
     * gift sent exactly as the join happened can arrive on both. An event with no id — from a
     * backend predating the gift engine — cannot be recognised, and repeating an animation is the
     * lesser fault than losing one.
     */
    private fun isDuplicateInList(
        current: List<GiftAnimatedEvent>,
        incoming: GiftAnimatedEvent,
    ): Boolean {
        val key = incoming.eventId ?: return false
        return current.any { it.eventId == key }
    }

    /**
     * Append a chat line unless that exact message is already on screen.
     *
     * Joining a room inserts an entry notice into `chat_messages` *and* emits it,
     * so the history snapshot from `GET /api/rooms/:id` and the socket event can
     * deliver the same row. The list is keyed by message id, so a second copy is
     * not a cosmetic duplicate — it crashes the room. Ids come from the server and
     * are unique per row, which makes the id the only correct deduplication key.
     */
    fun appendChat(
        current: List<ChatMessage>,
        incoming: ChatMessage,
        limit: Int,
    ): List<ChatMessage> {
        if (current.any { it.id == incoming.id }) return current
        return (current + incoming).takeLast(limit)
    }

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
