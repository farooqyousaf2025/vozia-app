package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

data class AgencyAnnouncementBody(
    @SerializedName("title") val title: String,
    @SerializedName("body") val body: String,
)

data class AgencyAnnouncementDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("title") val title: String? = null,
    @SerializedName("body") val body: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("recipientCount") val recipientCount: Int? = null,
    @SerializedName("readCount") val readCount: Int? = null,
)

data class AgencyHostAnnouncementDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("title") val title: String? = null,
    @SerializedName("body") val body: String? = null,
    @SerializedName("agencyName") val agencyName: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
    @SerializedName("readAt") val readAt: String? = null,
    @SerializedName("isRead") val isRead: Boolean? = null,
)

data class AgencyAnnouncementsEnvelope(
    @SerializedName("announcements") val announcements: List<AgencyAnnouncementDto>? = null,
)
data class AgencyAnnouncementEnvelope(
    @SerializedName("announcement") val announcement: AgencyAnnouncementDto? = null,
)
data class AgencyHostAnnouncementsEnvelope(
    @SerializedName("announcements") val announcements: List<AgencyHostAnnouncementDto>? = null,
)
data class AgencyAnnouncementReadEnvelope(
    @SerializedName("announcementId") val announcementId: String? = null,
    @SerializedName("readAt") val readAt: String? = null,
)
