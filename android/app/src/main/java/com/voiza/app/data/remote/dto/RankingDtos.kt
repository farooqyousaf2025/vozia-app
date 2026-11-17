package com.voiza.app.data.remote.dto

import com.google.gson.annotations.SerializedName

/**
 * `/api/rankings` — the landing boards. Every field is nullable-by-DTO rule: Gson runs with
 * Unsafe, so an absent key takes the JVM zero value rather than these defaults; the mapper owns
 * the fallbacks. An older backend that omits `settled` reads as the live view.
 */
data class RankingWindowDto(
    @SerializedName("key") val key: String? = null,
    @SerializedName("label") val label: String? = null,
    @SerializedName("from") val from: String? = null,
    @SerializedName("to") val to: String? = null,
)

data class RankingLeaderDto(
    @SerializedName("position") val position: Int? = null,
    @SerializedName("id") val id: String? = null,
    @SerializedName("username") val username: String? = null,
    @SerializedName("avatarUrl") val avatarUrl: String? = null,
    @SerializedName("userType") val userType: String? = null,
    @SerializedName("isVerified") val isVerified: Boolean? = null,
    @SerializedName("rank") val rank: RankDto? = null,
    @SerializedName("earned") val earned: Long? = null,
)

data class RankingSelfDto(
    @SerializedName("position") val position: Int? = null,
    @SerializedName("earned") val earned: Long? = null,
)

data class RankingRewardDto(
    @SerializedName("periodKey") val periodKey: String? = null,
    @SerializedName("position") val position: Int? = null,
    @SerializedName("amount") val amount: Int? = null,
    @SerializedName("claimed") val claimed: Boolean? = null,
    @SerializedName("claimable") val claimable: Boolean? = null,
)

data class RankingBoardResponse(
    @SerializedName("board") val board: String? = null,
    @SerializedName("period") val period: String? = null,
    @SerializedName("settled") val settled: Boolean? = null,
    @SerializedName("window") val window: RankingWindowDto? = null,
    @SerializedName("unit") val unit: String? = null,
    @SerializedName("leaders") val leaders: List<RankingLeaderDto>? = null,
    @SerializedName("self") val self: RankingSelfDto? = null,
    @SerializedName("reward") val reward: RankingRewardDto? = null,
)

data class RankingClaimBody(
    @SerializedName("board") val board: String,
    @SerializedName("period") val period: String,
)

data class RankingClaimDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("board") val board: String? = null,
    @SerializedName("periodKey") val periodKey: String? = null,
    @SerializedName("position") val position: Int? = null,
    @SerializedName("amount") val amount: Int? = null,
    @SerializedName("grantId") val grantId: String? = null,
    @SerializedName("createdAt") val createdAt: String? = null,
)

data class RankingClaimResponse(
    @SerializedName("claim") val claim: RankingClaimDto? = null,
    @SerializedName("grant") val grant: RankingGrantDto? = null,
    @SerializedName("alreadyClaimed") val alreadyClaimed: Boolean? = null,
)

/** The minted reward grant. Only what the receipt screen shows; the wallet owns the balance. */
data class RankingGrantDto(
    @SerializedName("id") val id: String? = null,
    @SerializedName("amount") val amount: Int? = null,
    @SerializedName("remaining") val remaining: Int? = null,
    @SerializedName("expiresAt") val expiresAt: String? = null,
)