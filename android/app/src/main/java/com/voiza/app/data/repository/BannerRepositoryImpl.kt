package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.SessionManager
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.BannerTrackBody
import com.voiza.app.domain.model.BannerPlacement
import com.voiza.app.domain.model.PromoBanner
import com.voiza.app.domain.repository.BannerEvent
import com.voiza.app.domain.repository.BannerRepository

/**
 * The two banner calls, with nothing else on them.
 *
 * There is no cache here on purpose: a campaign starts and ends on the server's clock, so the right
 * place to hold a copy is one that knows when it was read. That is `BannersStore`'s job; this class
 * stays the thin wire it is.
 */
class BannerRepositoryImpl(
    private val api: VoizaApiService,
    private val sessionManager: SessionManager,
) : BannerRepository {

    override suspend fun live(placement: BannerPlacement?): ApiResult<List<PromoBanner>> =
        apiCall { api.banners(placement?.name) }.mapSuccess { it.toDomain() }

    override suspend fun track(bannerId: String, event: BannerEvent): ApiResult<Boolean> {
        // `POST /api/banners/track` is behind a session, so asking signed-out would be a 401 the
        // member never sees. Skipping the round trip is the same answer with fewer bytes.
        if (!sessionManager.hasSession) return ApiResult.Success(false)
        return apiCall { api.trackBanner(BannerTrackBody(bannerId, event.name)) }.mapSuccess { true }
    }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}
