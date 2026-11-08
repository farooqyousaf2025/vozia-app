package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.EmptyRequestBody
import com.voiza.app.data.remote.dto.RoleApplicationEnvelope
import com.voiza.app.data.remote.dto.SubmitApplicationBody
import com.voiza.app.data.remote.dto.SupplementApplicationBody
import com.voiza.app.domain.model.ApplicationForm
import com.voiza.app.domain.model.MyApplications
import com.voiza.app.domain.model.PartnerCatalogue
import com.voiza.app.domain.model.RoleApplication
import com.voiza.app.domain.repository.RoleApplicationRepository

/**
 * Partner applications over HTTP (migration 0035).
 *
 * [submit] and [supplement] hand the answers over as the member gave them. The shapes that matter —
 * a checkbox that is a real boolean, a country that is two letters, a phone the platform can dial —
 * are decided by `normaliseForm` on the server, and what comes back is the row that was stored.
 *
 * There is no session manager here, unlike the wallet or store repositories: an application grants
 * nothing the app has to notice, and a client that re-read `users.user_type` to find out whether it
 * had become a host would be a client asserting a privilege from its own request. The screens ask
 * `/api/role-applications/roles` again, and the answer is the server's.
 */
class RoleApplicationRepositoryImpl(
    private val api: VoizaApiService,
) : RoleApplicationRepository {

    override suspend fun catalogue(): ApiResult<PartnerCatalogue> =
        apiCall { api.partnerCatalogue() }.mapSuccess { it.toDomain() }

    override suspend fun form(role: String): ApiResult<ApplicationForm> =
        apiCall { api.partnerForm(role) }.mapSuccess { it.toDomain() }

    override suspend fun mine(): ApiResult<MyApplications> =
        apiCall { api.myRoleApplications() }.mapSuccess { it.toDomain() }

    override suspend fun submit(role: String, answers: Map<String, Any?>): ApiResult<RoleApplication> =
        when (val result = apiCall { api.applyForRole(SubmitApplicationBody(role, answers)) }) {
            is ApiResult.Success -> result.data.requireRow()
            is ApiResult.Failure -> result
        }

    override suspend fun supplement(
        applicationId: String,
        answers: Map<String, Any?>,
    ): ApiResult<RoleApplication> =
        when (val result = apiCall { api.supplementApplication(applicationId, SupplementApplicationBody(answers)) }) {
            is ApiResult.Success -> result.data.requireRow()
            is ApiResult.Failure -> result
        }

    override suspend fun cancel(applicationId: String): ApiResult<RoleApplication> =
        when (val result = apiCall { api.cancelRoleApplication(applicationId, EmptyRequestBody()) }) {
            is ApiResult.Success -> result.data.requireRow()
            is ApiResult.Failure -> result
        }

    /**
     * An accepted response that carries no row is a broken contract, not an application with an
     * empty id: the screen would otherwise offer the member a "Respond" button wired to nothing.
     */
    private fun RoleApplicationEnvelope.requireRow(): ApiResult<RoleApplication> =
        application?.toDomain()?.let { ApiResult.Success(it) }
            ?: ApiResult.Failure(message = "The server accepted that but did not return the application.")

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}
