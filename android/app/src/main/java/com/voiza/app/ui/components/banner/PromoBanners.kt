package com.voiza.app.ui.components.banner

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.voiza.app.domain.model.BannerPlacement
import com.voiza.app.domain.model.PromoBanner
import com.voiza.app.domain.repository.BannerEvent
import com.voiza.app.domain.usecase.BannersStore
import com.voiza.app.ui.theme.OnDarkHigh
import com.voiza.app.ui.theme.OnDarkMedium
import com.voiza.app.ui.theme.OnDarkMuted
import com.voiza.app.ui.theme.VoizaOutline
import com.voiza.app.ui.theme.VoizaSurfaceHigh
import kotlinx.coroutines.delay

/**
 * The four surfaces a promotional banner is drawn on.
 *
 * Two composables cover all of them: a strip for the screens that already scroll (home, the gift
 * panel, the game desk) and a full-screen takeover for the splash, which is the only one of the four
 * that owns the device rather than borrowing a row from a list. Both draw nothing at all when the
 * server has no live campaign for that placement, which is the point of `is_active` and the window:
 * an operator switching a campaign off is supposed to change what a member sees.
 */

/** How long a still banner stays on a strip before the next one takes its slot. */
private const val STRIP_DWELL_MS = 4_000L

/** How long the splash holds a campaign before handing the app over. */
private const val SPLASH_DWELL_MS = 3_500L

/**
 * A campaign strip for one surface, in the server's own order.
 *
 * It sits above the content it belongs to rather than inside it: a home banner that scrolled away
 * with the room grid would be a campaign a member could never see twice, and a gift-panel card that
 * pushed the tiles down would move a button a tap is already aimed at.
 */
@Composable
fun PromoBannerStrip(
    placement: BannerPlacement,
    modifier: Modifier = Modifier,
    artHeight: Dp = 112.dp,
) {
    val host = rememberBannerHost() ?: return
    val banners = host.banners(placement)
    if (banners.isEmpty()) return

    // One campaign is not a carousel: no pager, no timer, no dots to rotate.
    if (banners.size == 1) {
        val only = banners.first()
        LaunchedEffect(only.id) { host.countImpression(only) }
        BannerCard(
            banner = only,
            artHeight = artHeight,
            onClick = { host.tap(only) },
            modifier = modifier.fillMaxWidth(),
        )
        return
    }

    // `key` over the list so a refresh that changes the campaigns rebuilds the pager rather than
    // leaving it pointing at rows that are no longer live.
    key(banners) {
        val pagerState = rememberPagerState(pageCount = { banners.size })
        LaunchedEffect(pagerState.currentPage) {
            val current = banners.getOrElse(pagerState.currentPage) { return@LaunchedEffect }
            host.countImpression(current)
            delay(dwellMs(current, STRIP_DWELL_MS))
            pagerState.animateScrollToPage((pagerState.currentPage + 1) % banners.size)
        }
        Column(modifier = modifier) {
            HorizontalPager(state = pagerState, modifier = Modifier.fillMaxWidth()) { index ->
                val banner = banners.getOrElse(index) { banners.first() }
                BannerCard(
                    banner = banner,
                    artHeight = artHeight,
                    onClick = { host.tap(banner) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 6.dp),
            ) {
                repeat(banners.size) { index ->
                    val selected = pagerState.currentPage == index
                    Box(
                        modifier = Modifier
                            .size(if (selected) 7.dp else 5.dp)
                            .clip(RoundedCornerShape(percent = 50))
                            .background(if (selected) OnDarkMedium else VoizaOutline),
                    )
                }
            }
        }
    }
}

/**
 * The splash campaign, over everything, at cold start.
 *
 * A SPLASH banner is the one surface that is allowed to take the screen: it is what an app in this
 * genre shows a thousand members before they choose anything, and the operator's window and switch are
 * already applied server-side, so this is the only decision left — that the takeover lasts the dwell
 * the row declared and can be skipped at any point.
 */
@Composable
fun SplashBannerOverlay() {
    val host = rememberBannerHost() ?: return
    val banners = host.banners(BannerPlacement.SPLASH)
    if (banners.isEmpty()) return

    var open by remember { mutableStateOf(true) }
    if (!open) return

    // The first row the server sent, not the biggest or the newest: `sort_order` is the operator's
    // answer to which campaign this launch belongs to.
    val banner = banners.first()
    LaunchedEffect(banner.id) {
        host.countImpression(banner)
        delay(dwellMs(banner, SPLASH_DWELL_MS))
        open = false
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xF20B0A1F)),
    ) {
        BannerCard(
            banner = banner,
            artHeight = 232.dp,
            onClick = {
                open = false
                host.tap(banner)
            },
            modifier = Modifier
                .align(Alignment.Center)
                .padding(horizontal = 22.dp),
        )
        Text(
            text = "Skip",
            color = OnDarkMuted,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .clip(RoundedCornerShape(50))
                .clickable { open = false }
                .padding(horizontal = 16.dp, vertical = 12.dp),
        )
    }
}

/**
 * One campaign: art, and the operator's own headline over it.
 *
 * The caption rides inside the art rather than under it because a banner is bought by its picture and
 * read by its line, and because a strip whose height changed with the copy would push the content
 * below it around as campaigns rotated.
 */
@Composable
private fun BannerCard(
    banner: PromoBanner,
    artHeight: Dp,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(16.dp))
            .background(VoizaSurfaceHigh)
            .clickable(onClick = onClick),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(artHeight),
        ) {
            BannerArt(banner = banner, modifier = Modifier.fillMaxSize())
            if (banner.title.isNotBlank()) {
                Column(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .fillMaxWidth()
                        .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000))))
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                ) {
                    Text(
                        text = banner.title,
                        color = OnDarkHigh,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 2,
                    )
                    val subtitle = banner.subtitle
                    if (!subtitle.isNullOrBlank()) {
                        Text(
                            text = subtitle,
                            color = OnDarkMedium,
                            fontSize = 12.sp,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}

/** What the row declared, or the surface's own default for a still campaign. */
private fun dwellMs(banner: PromoBanner, surfaceDefault: Long): Long =
    banner.durationMs.takeIf { it > 0 }?.toLong() ?: surfaceDefault

/**
 * The two things a banner surface needs from the activity that owns the nav graph.
 *
 * Bundled because every surface reads the same pair and null-handling it twice each would hide what is
 * actually going on: with no host — a tooling preview, a test — there are no campaigns to draw.
 */
@Composable
private fun rememberBannerHost(): BannerHost? {
    val store = LocalBannerStore.current ?: return null
    val navigator = LocalBannerNavigator.current ?: return null
    val live by store.live.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { store.ensureLoaded() }
    return BannerHost(store, live, navigator)
}

private class BannerHost(
    private val store: BannersStore,
    private val live: List<PromoBanner>,
    private val navigator: BannerNavigator,
) {
    fun banners(placement: BannerPlacement): List<PromoBanner> =
        live.filter { it.placement == placement }

    fun countImpression(banner: PromoBanner) = store.count(banner, BannerEvent.IMPRESSION)

    /** The tap is counted whatever the target turns out to be: the operator's question is whether a
     *  member reached for the banner, and a device with no browser does not change that answer. */
    fun tap(banner: PromoBanner) {
        store.count(banner, BannerEvent.TAP)
        navigator.open(banner.target)
    }
}
