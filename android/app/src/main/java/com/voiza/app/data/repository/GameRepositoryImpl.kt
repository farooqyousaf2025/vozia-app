package com.voiza.app.data.repository

import com.voiza.app.data.mapper.toDomain
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.remote.VoizaApiService
import com.voiza.app.data.remote.apiCall
import com.voiza.app.data.remote.dto.CreateGameBody
import com.voiza.app.data.remote.dto.GameActionBody
import com.voiza.app.data.remote.dto.GameReasonBody
import com.voiza.app.domain.model.GameHistoryRow
import com.voiza.app.domain.model.GameSession
import com.voiza.app.domain.repository.GameLobbyBundle
import com.voiza.app.domain.repository.GameRepository

/**
 * Talks to `/api/games`. REST only: a move goes out as a POST so its rejection comes
 * back as the server's own message ("That square is already played") instead of a
 * silent socket drop. Board changes from other players arrive over `game:update`,
 * which the socket client exposes and the ViewModels fold into state.
 */
class GameRepositoryImpl(
    private val api: VoizaApiService,
) : GameRepository {

    override suspend fun lobby(roomId: String): ApiResult<GameLobbyBundle> =
        apiCall { api.gameCatalog(roomId) }.mapSuccess { resp ->
            GameLobbyBundle(
                games = resp.games.map { it.toDomain() },
                sessions = resp.sessions.orEmpty().map { it.toDomain() },
            )
        }

    override suspend fun session(sessionId: String): ApiResult<GameSession> =
        apiCall { api.gameSession(sessionId) }.mapSuccess { it.session.toDomain() }

    override suspend fun history(limit: Int): ApiResult<List<GameHistoryRow>> =
        apiCall { api.gameHistory(limit) }.mapSuccess { resp -> resp.games.map { it.toDomain() } }

    override suspend fun create(gameKey: String, roomId: String): ApiResult<GameSession> =
        apiCall { api.createGame(CreateGameBody(gameKey, roomId)) }.mapSuccess { it.session.toDomain() }

    override suspend fun join(sessionId: String): ApiResult<GameSession> =
        apiCall { api.joinGame(sessionId) }.mapSuccess { it.session.toDomain() }

    override suspend fun setReady(sessionId: String): ApiResult<GameSession> =
        apiCall { api.readyGame(sessionId) }.mapSuccess { it.session.toDomain() }

    override suspend fun start(sessionId: String): ApiResult<GameSession> =
        apiCall { api.startGame(sessionId) }.mapSuccess { it.session.toDomain() }

    override suspend fun action(
        sessionId: String,
        type: String,
        payload: Map<String, Any?>,
    ): ApiResult<GameSession> =
        apiCall { api.gameAction(sessionId, GameActionBody(type, payload)) }
            .mapSuccess { it.session.toDomain() }

    override suspend fun leave(sessionId: String): ApiResult<GameSession> =
        apiCall { api.leaveGame(sessionId) }.mapSuccess { it.session.toDomain() }

    override suspend fun cancel(sessionId: String, reason: String): ApiResult<GameSession> =
        apiCall { api.cancelGame(sessionId, GameReasonBody(reason)) }.mapSuccess { it.session.toDomain() }

    override suspend fun dispute(sessionId: String, reason: String): ApiResult<Boolean> =
        apiCall { api.disputeGame(sessionId, GameReasonBody(reason)) }.mapSuccess { it.dispute.id.isNotBlank() }

    private inline fun <T, R> ApiResult<T>.mapSuccess(transform: (T) -> R): ApiResult<R> =
        when (this) {
            is ApiResult.Success -> ApiResult.Success(transform(data))
            is ApiResult.Failure -> this
        }
}
