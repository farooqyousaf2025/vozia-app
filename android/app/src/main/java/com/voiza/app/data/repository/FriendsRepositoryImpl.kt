package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.mapper.toDomainOrNull
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.DoNotContactBody
import com.voiza.app.data.remote.dto.SendMessageBody
import com.voiza.app.domain.model.Conversation
import com.voiza.app.domain.model.DirectMessage
import com.voiza.app.domain.model.FriendPage
import com.voiza.app.domain.model.FriendRequest
import com.voiza.app.domain.model.FriendRequestPage
import com.voiza.app.domain.model.MessagePage
import com.voiza.app.domain.repository.FriendsRepository

/**
 * Friends and DMs over HTTP.
 *
 * No method sends a price, a status, a count or a friendship edge: it names the other member and
 * the server decides whether the relationship allows the call. A refusal is passed back as the
 * server's message so the screen can show "you are not friends" or "this member asked not to be
 * contacted" rather than a generic failure.
 */
class FriendsRepositoryImpl(
    private val api: VoizaApiService,
) : FriendsRepository {

    override suspend fun sendFriendRequest(targetUserId: String): ApiResult<FriendRequest> =
        apiCall { api.sendFriendRequest(targetUserId) }.mapSingle { it.request?.toDomainOrNull() }

    override suspend fun friends(page: Int, limit: Int): ApiResult<FriendPage> =
        apiCall { api.friends(page, limit) }.mapSuccess { it.toDomain() }

    override suspend fun requests(direction: String, page: Int, limit: Int): ApiResult<FriendRequestPage> =
        apiCall { api.friendRequests(direction, page, limit) }.mapSuccess { it.toDomain() }

    override suspend fun acceptRequest(requestId: String): ApiResult<Boolean> =
        apiCall { api.acceptFriendRequest(requestId) }.mapSuccess { it.friends == true }

    override suspend fun declineRequest(requestId: String): ApiResult<Boolean> =
        apiCall { api.declineFriendRequest(requestId) }.mapSuccess { it.request != null }

    override suspend fun unfriend(userId: String): ApiResult<Boolean> =
        apiCall { api.unfriend(userId) }.mapSuccess { it.friends == false }

    override suspend fun setDoNotContact(userId: String, value: Boolean): ApiResult<Boolean> =
        apiCall { api.setDoNotContact(userId, DoNotContactBody(value)) }
            .mapSuccess { it.doNotContact == value }

    override suspend fun conversations(): ApiResult<List<Conversation>> =
        apiCall { api.conversations() }.mapSuccess { envelope ->
            envelope.conversations.orEmpty().mapNotNull { it.toDomainOrNull() }
        }

    override suspend fun messages(userId: String, page: Int, limit: Int): ApiResult<MessagePage> =
        apiCall { api.messages(userId, page, limit) }.mapSuccess { it.toDomain() }

    override suspend fun sendMessage(userId: String, content: String): ApiResult<DirectMessage> =
        apiCall { api.sendMessage(userId, SendMessageBody(content)) }.mapSingle { it.message?.toDomainOrNull() }

    override suspend fun markRead(userId: String): ApiResult<Boolean> =
        apiCall { api.markRead(userId) }.mapSuccess { it.read == true }

    /** A single-row envelope that cannot be mapped is a failure, never a blank card on screen. */
    private inline fun <T, R : Any> ApiResult<T>.mapSingle(transform: (T) -> R?): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> transform(data)?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The server's answer was incomplete. Please try again.")
            is ApiResult.Failure -> this
        }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}
