package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

// ---------------------------------------------------------------------------
// Friends and direct messages (migration 0049).
//
// Every field is nullable because Gson builds these through Unsafe without running their
// initialisers: an absent key would otherwise leave a non-null Kotlin property null and crash
// the mapper. The mapper owns every fallback, and no amount, status or decision is computed
// here — a request's state and a conversation's unread count are the server's answers.
// ---------------------------------------------------------------------------

/** One row of `friend_requests`, with both parties already resolved by the server. */
data class FriendRequestDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("status") val status: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("respondedAt") val respondedAt: String? = null,
    @SerializedName("requester") val requester: MiniUserDto? = null,
    @SerializedName("addressee") val addressee: MiniUserDto? = null,
)

/** `POST /api/users/:id/friend-request` and socket `friend:request` share this envelope. */
data class FriendRequestEnvelope(
    @SerializedName("request") val request: FriendRequestDto? = null,
)

data class FriendRequestsEnvelope(
    @SerializedName("requests") val requests: List<FriendRequestDto>? = null,
    @SerializedName("total") val total: Int? = null,
    @SerializedName("page") val page: Int? = null,
    @SerializedName("limit") val limit: Int? = null,
)

data class FriendsEnvelope(
    @SerializedName("friends") val friends: List<MiniUserDto>? = null,
    @SerializedName("total") val total: Int? = null,
    @SerializedName("page") val page: Int? = null,
    @SerializedName("limit") val limit: Int? = null,
)

/** Accept and decline both answer with the request as it now stands and the resulting friend edge. */
data class FriendDecisionEnvelope(
    @SerializedName("request") val request: FriendRequestDto? = null,
    @SerializedName("friends") val friends: Boolean? = null,
)

data class UnfriendEnvelope(
    @SerializedName("friends") val friends: Boolean? = null,
)

/** POST sets the flag, DELETE clears it; the body is only read on POST. */
data class DoNotContactBody(
    @SerializedName("value") val value: Boolean,
)

data class DoNotContactEnvelope(
    @SerializedName("doNotContact") val doNotContact: Boolean? = null,
)

data class FriendLocationSharingBody(@SerializedName("enabled") val enabled: Boolean)
data class FriendLocationBody(@SerializedName("latitude") val latitude: Double, @SerializedName("longitude") val longitude: Double)
data class FriendLocationSharingEnvelope(@SerializedName("enabled") val enabled: Boolean? = null)
data class FriendLocationUpdateEnvelope(@SerializedName("updated") val updated: Boolean? = null)
data class FriendDistanceDto(@SerializedName("friendId") val friendId: String? = null, @SerializedName("distanceMeters") val distanceMeters: Int? = null)
data class FriendDistancesEnvelope(@SerializedName("locations") val locations: List<FriendDistanceDto>? = null)
