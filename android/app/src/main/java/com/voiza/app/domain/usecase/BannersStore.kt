package com.voiza.app.domain.usecase

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.BannerPlacement
import com.voiza.app.domain.model.PromoBanner
import com.voiza.app.domain.repository.BannerEvent
import com.voiza.app.domain.repository.BannerRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The live campaigns, read once and shared by every surface that draws one.
 *
 * This exists rather than a per-screen fetch because a cold start asks for the splash, the home
 * strip, the gift panel's card and the game desk's banner, and all four are the same question —
 * `GET /api/banners` with no `placement` answers them in one call, in the server's own order, with
 * the per-surface cap already applied. A screen that asked for its placement alone would be four
 * requests for one list, and would still not know what the other surfaces were showing.
 *
 * A failure leaves the list empty, which draws nothing. That is the right degradation: a campaign
 * the app could not load is not an error a member can act on, and an empty surface is exactly what
 * a platform with no live campaign looks like.
 */
class BannersStore(private val repository: BannerRepository) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _live = MutableStateFlow<List<PromoBanner>>(emptyList())

    /** Every live row, all four placements mixed, in the order the server sent them. */
    val live: StateFlow<List<PromoBanner>> = _live.asStateFlow()

    @Volatile
    private var loading = false

    @Volatile
    private var hasLoaded = false

    /**
     * Impression counters already sent this session, so a member who scrolls home, opens the gift
     * panel and comes back does not report the same poster three times. The server's `impressions`
     * column is advisory, and a number inflated by one person's own navigation is not worth reading.
     */
    private val countedImpressions = mutableSetOf<String>()

    /** The rows for one surface, still in the server's order. */
    fun forPlacement(placement: BannerPlacement): List<PromoBanner> =
        _live.value.filter { it.placement == placement }

    /**
     * Ask the server once per session — or until it answers, since a load that failed leaves the
     * next surface free to try again.
     *
     * Every surface calls this when it appears, and only the first of them spends a request; a
     * surface that finds nothing loaded can pull again through [refresh], which is what Home's
     * own pull-to-refresh does.
     */
    fun ensureLoaded() {
        if (loading || hasLoaded) return
        load()
    }

    /** Re-read the wall, e.g. after a pull-to-refresh. */
    fun refresh() {
        if (loading) return
        load()
    }

    private fun load() {
        loading = true
        scope.launch {
            try {
                val result = repository.live()
                if (result is ApiResult.Success) {
                    hasLoaded = true
                    _live.value = result.data
                }
            } finally {
                // Cleared even when the scope is cancelled mid-flight, so a surface that arrives
                // after a cancelled load is not blocked forever by a request that never happened.
                loading = false
            }
        }
    }

    /**
     * Report one look or one tap and never wait on it.
     *
     * The call is fire-and-forget because nothing on screen is derived from the answer: a banner the
     * count did not reach still drew, still invited, and the operator's click-through rate is the
     * server's arithmetic over the rows it did receive.
     */
    fun count(banner: PromoBanner, event: BannerEvent) {
        if (event == BannerEvent.IMPRESSION && !countedImpressions.add(banner.id)) return
        scope.launch { repository.track(banner.id, event) }
    }
}
