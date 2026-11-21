package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.RankingBoardResponse
import com.voiza.app.data.remote.dto.RankingClaimResponse
import com.voiza.app.data.remote.dto.RankingLeaderDto
import com.voiza.app.data.remote.dto.RankingRewardDto
import com.voiza.app.data.remote.dto.RankingSelfDto
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.RankingBoard
import com.voiza.app.domain.model.RankingBoardKind
import com.voiza.app.domain.model.RankingClaimResult
import com.voiza.app.domain.model.RankingLeader
import com.voiza.app.domain.model.RankingPeriod
import com.voiza.app.domain.model.RankingReward
import com.voiza.app.domain.model.RankingSelf
import com.voiza.app.domain.model.DiscoveryLeader
import com.voiza.app.domain.model.DiscoveryRanking
import com.voiza.app.domain.model.DiscoveryRankingKind
import com.voiza.app.data.remote.dto.DiscoveryRankingResponse

/**
 * The landing boards as the app consumes them. Positions, scores and reward state are copied
 * from the server's answer; nothing is re-ranked or re-priced here. An unreadable board or
 * period name reads as the host board's daily view — the one that has always existed.
 */
fun RankingLeaderDto.toDomain(): RankingLeader? {
    val userId = id ?: return null
    return RankingLeader(
        position = position ?: 0,
        user = MiniUser(id = userId, username = username ?: "", avatarUrl = avatarUrl, rank = rank.toDomain()),
        earned = earned ?: 0,
    )
}

fun RankingSelfDto.toDomain(): RankingSelf = RankingSelf(position = position, earned = earned ?: 0)

fun RankingRewardDto.toDomain(): RankingReward? {
    val key = periodKey ?: return null
    return RankingReward(
        periodKey = key,
        position = position ?: 0,
        amount = amount ?: 0,
        claimed = claimed ?: false,
        claimable = claimable ?: false,
    )
}

fun RankingBoardResponse.toDomain(): RankingBoard = RankingBoard(
    board = enumOrDefault(board ?: "host", RankingBoardKind.HOST),
    period = enumOrDefault(period ?: "day", RankingPeriod.DAY),
    settled = settled ?: false,
    windowLabel = window?.label ?: "",
    windowKey = window?.key ?: "",
    unit = unit ?: "diamond",
    leaders = leaders.orEmpty().mapNotNull { it.toDomain() },
    self = self?.toDomain(),
    reward = reward?.toDomain(),
)

fun RankingClaimResponse.toDomain(): RankingClaimResult? {
    val c = claim ?: return null
    return RankingClaimResult(
        board = enumOrDefault(c.board ?: "host", RankingBoardKind.HOST),
        periodKey = c.periodKey ?: "",
        position = c.position ?: 0,
        amount = c.amount ?: 0,
        alreadyClaimed = alreadyClaimed ?: false,
    )
}

fun DiscoveryRankingResponse.toDiscoveryDomain(): DiscoveryRanking = DiscoveryRanking(
    kind = when (kind) {
        "hosts" -> DiscoveryRankingKind.HOSTS
        "agencies" -> DiscoveryRankingKind.AGENCIES
        else -> DiscoveryRankingKind.ROOMS
    },
    region = region,
    leaders = leaders.orEmpty().mapNotNull { row ->
        val id = row.id ?: return@mapNotNull null
        DiscoveryLeader(
            position = row.position ?: 0, id = id, name = row.name ?: "", avatarUrl = row.avatarUrl,
            region = row.region, score = row.score ?: 0, activeRooms = row.activeRooms ?: 0,
            listenerCount = row.listenerCount ?: 0, activeHostCount = row.activeHostCount,
            hostName = row.hostName, hostAvatarUrl = row.hostAvatarUrl,
        )
    },
)
