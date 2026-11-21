package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.ConversationDto
import com.voiza.app.data.remote.dto.DirectMessageDto
import com.voiza.app.data.remote.dto.FriendRequestDto
import com.voiza.app.data.remote.dto.FriendRequestEnvelope
import com.voiza.app.data.remote.dto.FriendRequestsEnvelope
import com.voiza.app.data.remote.dto.FriendsEnvelope
import com.voiza.app.data.remote.dto.MessagesEnvelope
import com.voiza.app.data.remote.dto.MiniUserDto
import com.voiza.app.domain.model.Conversation
import com.voiza.app.domain.model.DirectMessage
import com.voiza.app.domain.model.FriendPage
import com.voiza.app.domain.model.FriendRequest
import com.voiza.app.domain.model.FriendRequestPage
import com.voiza.app.domain.model.FriendRequestStatus
import com.voiza.app.domain.model.MessagePage
import com.voiza.app.domain.model.MiniUser

// ---------------------------------------------------------------------------
// Wire-to-domain copies for friends and DMs. A row the server did not fully describe is dropped
// from a list rather than drawn as an empty card; a single-row envelope that cannot be mapped is
// answered as a failure by the repository instead of silently becoming a blank friend.
// ---------------------------------------------------------------------------

private fun MiniUserDto?.toMiniOrNull(): MiniUser? = runCatching { this!!.toDomain() }.getOrNull()

private fun String?.orUnknown(): String = this?.trim()?.takeIf { it.isNotEmpty() } ?: "Unknown"

fun FriendRequestDto.toDomainOrNull(): FriendRequest? {
    val id = id?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val requester = requester.toMiniOrNull() ?: return null
    val addressee = addressee.toMiniOrNull() ?: return null
    val wireStatus = status
    val status = FriendRequestStatus.fromWire(wireStatus)
    return FriendRequest(
        id = id,
        status = status,
        statusLabel = status?.label ?: wireStatus.orUnknown(),
        createdAt = createdAt.orEmpty(),
        respondedAt = respondedAt,
        requester = requester,
        addressee = addressee,
    )
}

fun FriendRequestEnvelope.toDomainOrNull(): FriendRequest? = request?.toDomainOrNull()

fun FriendRequestsEnvelope.toDomain(): FriendRequestPage = FriendRequestPage(
    requests = requests.orEmpty().mapNotNull { it.toDomainOrNull() },
    total = total ?: 0,
    page = page ?: 1,
    limit = limit ?: 20,
)

fun FriendsEnvelope.toDomain(): FriendPage = FriendPage(
    friends = friends.orEmpty().mapNotNull { it.toMiniOrNull() },
    total = total ?: 0,
    page = page ?: 1,
    limit = limit ?: 50,
)

fun ConversationDto.toDomainOrNull(): Conversation? {
    val id = id?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val partner = partner.toMiniOrNull() ?: return null
    return Conversation(
        id = id,
        partner = partner,
        lastMessageAt = lastMessageAt,
        lastMessagePreview = lastMessagePreview?.takeIf { it.isNotBlank() },
        unreadCount = (unreadCount ?: 0).coerceAtLeast(0),
    )
}

fun DirectMessageDto.toDomainOrNull(): DirectMessage? {
    val id = id?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val conversationId = conversationId.orEmpty()
    val senderId = senderId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return DirectMessage(
        id = id,
        conversationId = conversationId,
        senderId = senderId,
        content = content.orEmpty(),
        createdAt = createdAt.orEmpty(),
        readAt = readAt,
    )
}

fun MessagesEnvelope.toDomain(): MessagePage = MessagePage(
    messages = messages.orEmpty().mapNotNull { it.toDomainOrNull() },
    total = total ?: 0,
    page = page ?: 1,
    limit = limit ?: 50,
)
