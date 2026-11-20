package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// Direct messages (`/api/dm`, migration 0049).
//
// A conversation is keyed by the friend pair on the server, so a client cannot open one with an
// arbitrary id: every route names the *other member*, and the server checks the friendship before
// it reads or writes a row. Nothing here carries a member id of the caller for the same reason.
// ---------------------------------------------------------------------------

data class ConversationDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("partner") val partner: MiniUserDto? = null,
    @SerializedName("lastMessageAt") val lastMessageAt: String? = null,
    @SerializedName("unreadCount") val unreadCount: Int? = null,
)

data class ConversationsEnvelope(
    @SerializedName("conversations") val conversations: List<ConversationDto>? = null,
)

data class DirectMessageDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("conversationId") val conversationId: String? = null,
    @SerializedName("senderId") val senderId: String? = null,
    @SerializedName("content") val content: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("readAt") val readAt: String? = null,
)

/** `POST` and socket `dm:message` share this shape: the server returns the row it stored. */
data class MessageEnvelope(
    @SerializedName("message") val message: DirectMessageDto? = null,
)

data class MessagesEnvelope(
    @SerializedName("messages") val messages: List<DirectMessageDto>? = null,
    @SerializedName("total") val total: Int? = null,
    @SerializedName("page") val page: Int? = null,
    @SerializedName("limit") val limit: Int? = null,
)

data class SendMessageBody(
    @SerializedName("content") val content: String,
)

data class MarkReadEnvelope(
    @SerializedName("read") val read: Boolean? = null,
)
