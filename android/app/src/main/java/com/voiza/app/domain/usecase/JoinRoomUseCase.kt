package com.voiza.app.domain.usecase

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.RoomJoinResult
import com.voiza.app.domain.repository.RoomRepository

/**
 * Orchestrates joining a room: REST join first (returns seats/audience and the
 * LiveKit credentials), then the Socket.IO room:join side-effect. Keeping both
 * steps here means the ViewModel has one call to make and one error surface.
 */
class JoinRoomUseCase(
    private val roomRepository: RoomRepository,
    private val socketJoin: (roomId: String) -> Unit,
) {
    suspend operator fun invoke(roomId: String, password: String?): ApiResult<RoomJoinResult> {
        val result = roomRepository.joinRoom(roomId, password)
        if (result is ApiResult.Success) {
            socketJoin(roomId)
        }
        return result
    }
}
