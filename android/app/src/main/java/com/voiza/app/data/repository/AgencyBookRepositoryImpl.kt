package com.voiza.app.data.repository

import com.voiza.app.domain.model.AgencyLiveRoom
import com.voiza.app.domain.model.AgencyRoomMember
import com.voiza.app.domain.model.AgencyRoomModerationAudit
import com.voiza.app.data.remote.dto.AgencyMuteMemberBody
import com.voiza.app.data.remote.dto.AgencyHostGoalsUpdateBody
import com.voiza.app.data.remote.dto.AgencyRoomModerationBody
import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.mapper.toAttendanceDomain
import com.voiza.app.data.mapper.toGoalsDomain
import com.voiza.app.data.mapper.toRecognitionDomain
import com.voiza.app.data.mapper.toLeaderboardDomain
import com.voiza.app.data.mapper.toHosts
import com.voiza.app.data.mapper.toPosition
import com.voiza.app.data.mapper.toSettlements
import com.voiza.app.data.mapper.toSubs
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.domain.model.AgencyHostRow
import com.voiza.app.domain.model.AgencyHostActivityReport
import com.voiza.app.domain.model.AgencyHostAttendanceReport
import com.voiza.app.domain.model.AgencyHostGoals
import com.voiza.app.domain.model.AgencyHostRecognition
import com.voiza.app.domain.model.AgencyHostLeaderboard
import com.voiza.app.domain.model.AgencyPosition
import com.voiza.app.domain.model.AgencySettlementRow
import com.voiza.app.domain.model.AgencySubRow
import com.voiza.app.domain.repository.AgencyBookRepository

/**
 * The agency's own book over HTTP (migrations 0033, 0040 and 0058).
 *
 * Read-only reports and an owner-configurable informational goal, with no financial write-back: reading a roster changes nothing, and the figures here are
 * the journal's, not a balance the app has to refresh elsewhere. A refusal is returned as the
 * server's own sentence — including the 403 a member without an agency gets from every route and the
 * one a sub-agency gets from [subAgencies] — so the screen reports what the backend said rather than
 * inventing a reason for it.
 */
class AgencyBookRepositoryImpl(
    private val api: VoizaApiService,
) : AgencyBookRepository {

    override suspend fun activeRooms(): ApiResult<List<AgencyLiveRoom>> =
        apiCall { api.agencyActiveRooms() }.mapSuccess { envelope ->
            envelope.rooms.orEmpty().mapNotNull { row ->
                val id = row.id?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                AgencyLiveRoom(id, row.title.orEmpty(), row.roomNumber.orEmpty(), row.hostUsername.orEmpty(), (row.memberCount ?: 0).coerceAtLeast(0))
            }
        }

    override suspend fun roomMembers(roomId: String): ApiResult<List<AgencyRoomMember>> =
        apiCall { api.agencyRoomMembers(roomId) }.mapSuccess { envelope ->
            envelope.members.orEmpty().mapNotNull { row ->
                val id = row.userId?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                AgencyRoomMember(id, row.username.orEmpty(), row.role.orEmpty(), row.isMuted ?: false)
            }
        }

    override suspend fun moderationHistory(roomId: String, limit: Int): ApiResult<List<AgencyRoomModerationAudit>> =
        apiCall { api.agencyRoomModerationAudit(roomId, limit.coerceIn(1, 100)) }.mapSuccess { envelope ->
            envelope.entries.orEmpty().mapNotNull { row ->
                val id = row.id?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                AgencyRoomModerationAudit(
                    id = id,
                    targetUserId = row.targetUserId.orEmpty(),
                    targetUsername = row.targetUsername?.takeIf { it.isNotBlank() } ?: row.targetUserId.orEmpty(),
                    actorUserId = row.actorUserId.orEmpty(),
                    actorUsername = row.actorUsername?.takeIf { it.isNotBlank() } ?: row.actorUserId.orEmpty(),
                    action = row.action.orEmpty(),
                    reason = row.reason,
                    createdAt = row.createdAt,
                )
            }
        }

    override suspend fun muteMember(roomId: String, userId: String, muted: Boolean): ApiResult<Unit> =
        apiCall { api.agencyMuteMember(roomId, AgencyMuteMemberBody(userId, muted)) }.mapSuccess { Unit }

    override suspend fun kickMember(roomId: String, userId: String): ApiResult<Unit> =
        apiCall { api.agencyKickMember(roomId, userId, AgencyRoomModerationBody()) }.mapSuccess { Unit }

    override suspend fun banMember(roomId: String, userId: String, minutes: Int?): ApiResult<Unit> =
        apiCall { api.agencyBanMember(roomId, userId, AgencyRoomModerationBody(reason = "Agency moderation", minutes = minutes)) }.mapSuccess { Unit }

    override suspend fun position(): ApiResult<AgencyPosition> =
        apiCall { api.agencyPosition() }.flatMapSuccess { envelope ->
            envelope.toPosition()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The answer carried no agency.")
        }

    override suspend fun hostActivity(days: Int): ApiResult<AgencyHostActivityReport> =
        apiCall { api.agencyHostActivity(if (days == 30) 30 else 7) }.flatMapSuccess { envelope ->
            envelope.toDomain()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The activity report was empty.")
        }

    override suspend fun hostAttendance(days: Int): ApiResult<AgencyHostAttendanceReport> =
        apiCall { api.agencyHostAttendance(if (days == 30) 30 else 7) }.flatMapSuccess { envelope ->
            envelope.toAttendanceDomain()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The attendance report was empty.")
        }

    override suspend fun hostGoals(): ApiResult<AgencyHostGoals> =
        apiCall { api.agencyHostGoals() }.flatMapSuccess { envelope ->
            envelope.toGoalsDomain()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The host goals report was empty.")
        }

    override suspend fun updateHostGoals(targetDays: Int): ApiResult<AgencyHostGoals> =
        apiCall { api.updateAgencyHostGoals(AgencyHostGoalsUpdateBody(targetDays.coerceIn(1, 7))) }.flatMapSuccess { envelope ->
            envelope.toGoalsDomain()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The updated host goals report was empty.")
        }

    override suspend fun hostRecognition(): ApiResult<AgencyHostRecognition> =
        apiCall { api.agencyHostRecognition() }.flatMapSuccess { envelope ->
            envelope.toRecognitionDomain()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The host recognition report was empty.")
        }

    override suspend fun hostLeaderboard(days: Int): ApiResult<AgencyHostLeaderboard> =
        apiCall { api.agencyHostLeaderboard(if (days == 30) 30 else 7) }.flatMapSuccess { envelope ->
            envelope.toLeaderboardDomain()?.let { ApiResult.Success(it) }
                ?: ApiResult.Failure("The host leaderboard was empty.")
        }

    override suspend fun hosts(limit: Int): ApiResult<List<AgencyHostRow>> =
        apiCall { api.agencyHosts(limit) }.mapSuccess { it.toHosts() }

    override suspend fun subAgencies(): ApiResult<List<AgencySubRow>> =
        apiCall { api.agencySubAgencies() }.mapSuccess { it.toSubs() }

    override suspend fun settlements(limit: Int): ApiResult<List<AgencySettlementRow>> =
        apiCall { api.agencySettlements(limit) }.mapSuccess { it.toSettlements() }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }

    /** For an envelope whose payload the server may legitimately leave out. */
    private inline fun <T, R> ApiResult<T>.flatMapSuccess(transform: (T) -> ApiResult<R>): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> transform(data)
            is ApiResult.Failure -> this
        }
}
