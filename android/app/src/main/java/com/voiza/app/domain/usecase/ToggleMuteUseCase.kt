package com.voiza.app.domain.usecase

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.repository.RoomRepository

/**
 * Host-side mic control for one seat: POST .../seat/:index/mute. Kept as a
 * use case because the ViewModel layers local optimistic state on top of the
 * returned seat snapshot.
 */
class ToggleMuteUseCase(
    private val roomRepository: RoomRepository,
) {
    suspend operator fun invoke(roomId: String, seatIndex: Int, muted: Boolean): ApiResult<List<Seat>> =
        roomRepository.muteSeat(roomId, seatIndex, muted)
}
