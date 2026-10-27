package com.voiza.app.domain.usecase

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.repository.RoomRepository

/**
 * Take an empty seat (audience -> speaker). Returns the fresh seat list so the
 * caller can recompute publish rights immediately; socket `room:seat_update`
 * remains the eventual source of truth.
 */
class TakeSeatUseCase(
    private val roomRepository: RoomRepository,
) {
    suspend operator fun invoke(roomId: String, seatIndex: Int): ApiResult<List<Seat>> =
        roomRepository.takeSeat(roomId, seatIndex)
}
