package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.SessionManager
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.StoreItemBody
import com.voiza.app.domain.model.StoreItemKind
import com.voiza.app.domain.model.StorePurchase
import com.voiza.app.domain.model.StoreSnapshot
import com.voiza.app.domain.model.User
import com.voiza.app.domain.repository.StoreRepository

/**
 * The shop over HTTP. Purchase, equip and unequip all return the account as it now stands, and
 * that copy is pushed into [SessionManager] so every screen (home header, wallet, profile) shows
 * the new balance or ring without a second request.
 */
class StoreRepositoryImpl(
    private val api: VoizaApiService,
    private val sessionManager: SessionManager,
) : StoreRepository {

    override suspend fun catalogue(): ApiResult<StoreSnapshot> =
        apiCall { api.store() }.mapSuccess { it.toDomain() }

    override suspend fun purchase(kind: StoreItemKind, key: String): ApiResult<StorePurchase> =
        apiCall { api.purchaseItem(StoreItemBody(kind.name, key)) }.mapSuccess { response ->
            response.wallet?.let(sessionManager::updateUser)
            response.toDomain()
        }

    override suspend fun equip(kind: StoreItemKind, key: String): ApiResult<User> =
        apiCall { api.equipItem(StoreItemBody(kind.name, key)) }.mapSuccess { response ->
            sessionManager.updateUser(response.user)
            response.user.toDomain()
        }

    override suspend fun unequip(kind: StoreItemKind): ApiResult<User> =
        apiCall { api.unequipItem(StoreItemBody(kind.name)) }.mapSuccess { response ->
            sessionManager.updateUser(response.user)
            response.user.toDomain()
        }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}
