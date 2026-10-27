package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.CreateRoomBody
import com.voiza.app.data.remote.dto.HandRaiseBody
import com.voiza.app.data.remote.dto.JoinRoomBody
import com.voiza.app.data.remote.dto.SeatMuteBody
import com.voiza.app.data.remote.dto.SeatStatusBody
import com.voiza.app.data.remote.dto.UpdateRoomBody
import com.voiza.app.data.socket.VoizaSocketClient
import com.voiza.app.domain.model.LiveKitCredentials
import com.voiza.app.domain.model.Room
import com.voiza.app.domain.repository.RoomDetailBundle
import com.voiza.app.domain.model.RoomJoinResult
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatPolicy
import com.voiza.app.domain.repository.RoomRepository

class RoomRepositoryImpl(
    private val api: VoizaApiService,
    private val socket: VoizaSocketClient,
) : RoomRepository {

    override suspend fun listRooms(
        category: String?,
        limit: Int?,
        search: String?,
        sort: String?,
        language: String?,
        region: String?,
    ): ApiResult<List<RoomSummary>> =
        apiCall { api.rooms(category, limit, search, sort, language, region) }
            .mapSuccess { it.rooms.map { dto -> dto.toDomain() } }

    override suspend fun seatPolicy(): ApiResult<SeatPolicy> =
        apiCall { api.roomCapacity() }.mapSuccess { it.seatCapacity.toDomain() }

    override suspend fun quickJoin(): ApiResult<Room> =
        apiCall { api.roomQuickJoin() }.mapSuccess { it.room.toDomain() }

    override suspend fun myRooms(limit: Int?): ApiResult<List<RoomSummary>> =
        apiCall { api.myRooms(limit) }.mapSuccess { it.rooms.map { dto -> dto.toDomain() } }

    override suspend fun createRoom(
        title: String,
        description: String?,
        category: String?,
        type: String?,
        password: String?,
        seatCapacity: Int?,
        language: String?,
        region: String?,
        rules: String?,
    ): ApiResult<Room> =
        apiCall {
            api.createRoom(
                CreateRoomBody(
                    title = title,
                    description = description,
                    category = category,
                    type = type,
                    password = password,
                    seatCapacity = seatCapacity,
                    language = language,
                    region = region,
                    rules = rules,
                )
            )
        }.mapSuccess { it.room.toDomain() }

    override suspend fun updateRoom(
        roomId: String,
        title: String?,
        description: String?,
        category: String?,
        coverUrl: String?,
        language: String?,
        region: String?,
        rules: String?,
    ): ApiResult<Room> =
        apiCall {
            api.updateRoom(
                roomId,
                UpdateRoomBody(
                    title = title,
                    description = description,
                    category = category,
                    coverUrl = coverUrl,
                    language = language,
                    region = region,
                    rules = rules,
                )
            )
        }.mapSuccess { it.room.toDomain() }

    override suspend fun deleteRoom(roomId: String): ApiResult<Boolean> =
        apiCall { api.deleteRoom(roomId) }.mapSuccess { true }

    override suspend fun getRoom(roomId: String): ApiResult<RoomDetailBundle> =
        apiCall { api.room(roomId) }.mapSuccess { resp ->
            RoomDetailBundle(
                room = resp.room.toDomain(),
                seats = resp.seats.map { it.toDomain() },
                audience = resp.audience.map { it.toDomain() },
                chat = resp.chat.map { it.toDomain() },
                handRaises = resp.handRaises.orEmpty().mapNotNull { it.user?.toDomain() },
            )
        }

    override suspend fun joinRoom(roomId: String, password: String?): ApiResult<RoomJoinResult> =
        apiCall { api.joinRoom(roomId, JoinRoomBody(password)) }.mapSuccess { resp ->
            RoomJoinResult(
                room = resp.room.toDomain(),
                seats = resp.seats.map { it.toDomain() },
                audience = resp.audience.map { it.toDomain() },
                livekit = resp.livekit.toDomain(),
            )
        }

    override suspend fun leaveRoom(roomId: String): ApiResult<Boolean> =
        apiCall { api.leaveRoom(roomId) }.mapSuccess { it.ok }

    override suspend fun takeSeat(roomId: String, seatIndex: Int): ApiResult<List<Seat>> =
        apiCall { api.takeSeat(roomId, mapOf("seatIndex" to seatIndex)) }
            .mapSuccess { resp -> resp.seats.map { it.toDomain() } }

    override suspend fun leaveSeat(roomId: String, seatIndex: Int): ApiResult<List<Seat>> =
        apiCall { api.leaveSeat(roomId, seatIndex) }
            .mapSuccess { resp -> resp.seats.map { it.toDomain() } }

    override suspend fun lockSeat(roomId: String, seatIndex: Int, locked: Boolean): ApiResult<List<Seat>> =
        apiCall { api.lockSeat(roomId, seatIndex, SeatStatusBody(locked)) }
            .mapSuccess { resp -> resp.seats.map { it.toDomain() } }

    override suspend fun muteSeat(roomId: String, seatIndex: Int, muted: Boolean): ApiResult<List<Seat>> =
        apiCall { api.muteSeat(roomId, seatIndex, SeatMuteBody(muted)) }
            .mapSuccess { resp -> resp.seats.map { it.toDomain() } }

    override suspend fun kickFromSeat(roomId: String, seatIndex: Int): ApiResult<List<Seat>> =
        apiCall { api.kickFromSeat(roomId, seatIndex) }
            .mapSuccess { resp -> resp.seats.map { it.toDomain() } }

    override suspend fun raiseHand(roomId: String, raise: Boolean): ApiResult<Boolean> =
        apiCall { api.handRaise(roomId, HandRaiseBody(raise)) }.mapSuccess { it.raised }

    override suspend fun closeRoom(roomId: String): ApiResult<Boolean> =
        apiCall { api.closeRoom(roomId) }.mapSuccess { it.ok }

    override suspend fun fetchLiveKitToken(roomId: String): ApiResult<LiveKitCredentials> =
        apiCall { api.livekitToken(roomId) }.mapSuccess { it.toDomain() }

    /** Chat goes over Socket.IO, not REST (see contract). */
    override suspend fun sendChat(roomId: String, message: String) {
        socket.sendChat(roomId, message)
    }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}
