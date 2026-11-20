package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

data class AgencyLiveRoomDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("title") val title: String? = null,
    @SerializedName("roomNumber") val roomNumber: String? = null,
    @SerializedName("hostUsername") val hostUsername: String? = null,
    @SerializedName("memberCount") val memberCount: Int? = null,
)
data class AgencyLiveRoomsEnvelope(
    @SerializedName("rooms") val rooms: List<AgencyLiveRoomDto>? = null,
)

data class AgencyRoomMemberDto(
    @SerializedName("userId") val userId: String? = null,
    @SerializedName("username") val username: String? = null,
    @SerializedName("role") val role: String? = null,
    @SerializedName("isMuted") val isMuted: Boolean? = null,
)
data class AgencyRoomMembersEnvelope(
    @SerializedName("members") val members: List<AgencyRoomMemberDto>? = null,
)
data class AgencyMuteMemberBody(
    @SerializedName("userId") val userId: String,
    @SerializedName("muted") val muted: Boolean,
)
data class AgencyRoomModerationBody(
    @SerializedName("reason") val reason: String? = null,
    @SerializedName("minutes") val minutes: Int? = null,
)
data class AgencyRoomModerationActionEnvelope(
    @SerializedName("wasPresent") val wasPresent: Boolean? = null,
    @SerializedName("removed") val removed: Boolean? = null,
    @SerializedName("expiresAt") val expiresAt: String? = null,
)
