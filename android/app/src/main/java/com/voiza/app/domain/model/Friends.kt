package com.voiza.app.domain.model

// ---------------------------------------------------------------------------
// Friends and DMs (migration 0049). These mirror the server's DTOs; nothing here
// recomputes a friendship, a request limit or an unread count. The two-request cap and the
// do-not-contact rule are enforced by the backend, and a 403 is shown to the member as the
// server's own sentence rather than pre-empted by a client guess.
// ---------------------------------------------------------------------------

/**
 * A request's row state. Kept a nullable field on [FriendRequest] so a state added by a newer
 * backend is shown as its raw wire word rather than collapsing into "Pending".
 */
enum class FriendRequestStatus(val wire: String, val label: String) {
    PENDING("PENDING", "Pending"),
    ACCEPTED("ACCEPTED", "Accepted"),
    DECLINED("DECLINED", "Declined"),
    ;

    companion object {
        fun fromWire(value: String?): FriendRequestStatus? =
            entries.firstOrNull { it.wire.equals(value?.trim(), ignoreCase = true) }
    }
}

data class FriendRequest(
    val id: String,
    val status: FriendRequestStatus?,
    /** The server's word when this build has no enum value for it. */
    val statusLabel: String,
    val createdAt: String,
    val respondedAt: String?,
    val requester: MiniUser,
    val addressee: MiniUser,
) {
    /** Which side of the edge this request is on, relative to the signed-in member. */
    fun isIncoming(myId: String): Boolean = addressee.id == myId

    /** The member at the other end — the one a row's avatar and name belong to. */
    fun otherParty(myId: String): MiniUser = if (isIncoming(myId)) requester else addressee
}

data class FriendRequestPage(
    val requests: List<FriendRequest>,
    val total: Int,
    val page: Int,
    val limit: Int,
)

data class FriendPage(
    val friends: List<MiniUser>,
    val total: Int,
    val page: Int,
    val limit: Int,
)

/** One-to-one conversation. Its id belongs to the server; the route names [partner] instead. */
data class Conversation(
    val id: String,
    val partner: MiniUser,
    val lastMessageAt: String?,
    /** The server's count of the partner's unread rows, never a local tally. */
    val unreadCount: Int,
)

data class DirectMessage(
    val id: String,
    val conversationId: String,
    val senderId: String,
    val content: String,
    val createdAt: String,
    val readAt: String?,
)

data class MessagePage(
    val messages: List<DirectMessage>,
    val total: Int,
    val page: Int,
    val limit: Int,
)

/** Server-computed distance only; precise coordinates are never returned. */
data class FriendDistance(val friendId: String, val distanceMeters: Int?)
