package com.voiza.app.domain.usecase

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.BannerFormat
import com.voiza.app.domain.model.BannerPlacement
import com.voiza.app.domain.model.BannerTarget
import com.voiza.app.domain.model.PromoBanner
import com.voiza.app.domain.repository.BannerEvent
import com.voiza.app.domain.repository.BannerRepository
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The four banner surfaces ask the same question, so the store that answers it is the difference
 * between one request per session and four — and the reason a member who cannot reach the API sees
 * an empty wall rather than an error dialog.
 *
 * `UnconfinedTestDispatcher` as Main is what lets these assertions read the state a launch already
 * wrote: [BannersStore] builds its scope on `Dispatchers.Main.immediate` and every fake below
 * answers without suspending, so a launch runs to completion where it was started.
 */
class BannersStoreTest {

    private class FakeBannerRepository : BannerRepository {
        var response: ApiResult<List<PromoBanner>> = ApiResult.Success(emptyList())

        /** Held open by a test that wants to observe the store *while* a load is in flight. */
        var gate: CompletableDeferred<Unit>? = null

        var liveCalls = 0
        val tracks = mutableListOf<Pair<String, BannerEvent>>()

        override suspend fun live(placement: BannerPlacement?): ApiResult<List<PromoBanner>> {
            liveCalls++
            gate?.await()
            return response
        }

        override suspend fun track(bannerId: String, event: BannerEvent): ApiResult<Boolean> {
            tracks += bannerId to event
            return ApiResult.Success(true)
        }
    }

    private val mainDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() = Dispatchers.setMain(mainDispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun banner(id: String, placement: BannerPlacement) = PromoBanner(
        id = id,
        key = id,
        placement = placement,
        title = "Title $id",
        subtitle = null,
        url = "/banners/$id.png",
        format = BannerFormat.PNG,
        durationMs = 0,
        target = BannerTarget.None,
    )

    @Test
    fun `every surface asking for the wall costs one request`() = runTest {
        val repository = FakeBannerRepository()
        val store = BannersStore(repository)

        store.ensureLoaded()
        store.ensureLoaded()
        store.ensureLoaded()
        store.ensureLoaded()

        assertEquals(1, repository.liveCalls)
    }

    @Test
    fun `one request answers all four placements in the server's order`() = runTest {
        val rows = listOf(
            banner("h1", BannerPlacement.HOME),
            banner("s1", BannerPlacement.SPLASH),
            banner("h2", BannerPlacement.HOME),
            banner("g1", BannerPlacement.GIFT),
        )
        val repository = FakeBannerRepository().apply { response = ApiResult.Success(rows) }
        val store = BannersStore(repository)
        store.ensureLoaded()

        // The strip draws what the server ranked, not what a client-side sort would prefer.
        assertEquals(listOf("h1", "h2"), store.forPlacement(BannerPlacement.HOME).map { it.id })
        assertEquals(listOf("s1"), store.forPlacement(BannerPlacement.SPLASH).map { it.id })
        assertEquals(listOf("g1"), store.forPlacement(BannerPlacement.GIFT).map { it.id })
        assertTrue(store.forPlacement(BannerPlacement.GAME).isEmpty())
        assertEquals(rows, store.live.value)
    }

    @Test
    fun `a load in flight is not a second load`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val repository = FakeBannerRepository().apply { this.gate = gate }
        val store = BannersStore(repository)

        store.ensureLoaded()
        // The first surface is still waiting on the network; three more arrive.
        store.ensureLoaded()
        store.ensureLoaded()
        assertEquals(1, repository.liveCalls)

        gate.complete(Unit)
        assertEquals(1, repository.liveCalls)
        store.ensureLoaded()
        assertEquals(1, repository.liveCalls)
    }

    @Test
    fun `a failure leaves the wall empty and the next surface may ask again`() = runTest {
        val repository = FakeBannerRepository().apply {
            response = ApiResult.Failure("Network unavailable. Check your connection.")
        }
        val store = BannersStore(repository)

        store.ensureLoaded()
        assertTrue(store.live.value.isEmpty())
        assertEquals(1, repository.liveCalls)

        // Nothing was cached from the failure, so the retry is allowed — and this time it lands.
        repository.response = ApiResult.Success(listOf(banner("h1", BannerPlacement.HOME)))
        store.ensureLoaded()
        assertEquals(2, repository.liveCalls)
        assertEquals(listOf("h1"), store.forPlacement(BannerPlacement.HOME).map { it.id })
    }

    @Test
    fun `refresh re-reads even after a good load, and a refresh during a load is dropped`() = runTest {
        val repository = FakeBannerRepository().apply {
            response = ApiResult.Success(listOf(banner("old", BannerPlacement.HOME)))
        }
        val store = BannersStore(repository)
        store.ensureLoaded()
        repository.response = ApiResult.Success(listOf(banner("new", BannerPlacement.HOME)))

        store.refresh()
        assertEquals(listOf("new"), store.forPlacement(BannerPlacement.HOME).map { it.id })
        assertEquals(2, repository.liveCalls)

        val gate = CompletableDeferred<Unit>()
        repository.gate = gate
        store.refresh()
        store.refresh()
        assertEquals(3, repository.liveCalls)
        gate.complete(Unit)
    }

    @Test
    fun `an impression is counted once per banner but a tap every time`() = runTest {
        val repository = FakeBannerRepository()
        val store = BannersStore(repository)
        val first = banner("h1", BannerPlacement.HOME)
        val second = banner("h2", BannerPlacement.HOME)

        // The same poster seen on home, then again after a scroll back, is one look.
        store.count(first, BannerEvent.IMPRESSION)
        store.count(first, BannerEvent.IMPRESSION)
        store.count(second, BannerEvent.IMPRESSION)
        store.count(first, BannerEvent.TAP)
        store.count(first, BannerEvent.TAP)

        assertEquals(
            listOf(
                "h1" to BannerEvent.IMPRESSION,
                "h2" to BannerEvent.IMPRESSION,
                "h1" to BannerEvent.TAP,
                "h1" to BannerEvent.TAP,
            ),
            repository.tracks,
        )
    }
}
