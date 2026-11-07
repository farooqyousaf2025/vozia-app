package com.voiza.app.domain.usecase

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.SeatTakeResult
import com.voiza.app.domain.repository.RoomRepository

/**
 * Take an empty seat (audience -> speaker). A room that gates the microphone answers with a queued
 * request instead of a seat, so this returns whichever the server chose; the caller cannot assume
 * it was seated, because assuming that is how a member ends up believing they hold the mic.
 * Socket `room:seat_update` remains the eventual source of truth for the seat list.
 */
class TakeSeatUseCase(
    private val roomRepository: RoomRepository,
) {
    suspend operator fun invoke(roomId: String, seatIndex: Int): ApiResult<SeatTakeResult> =
        roomRepository.takeSeat(roomId, seatIndex)
}
