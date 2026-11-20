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
