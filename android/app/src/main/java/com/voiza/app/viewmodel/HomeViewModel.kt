package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.Room
import com.voiza.app.domain.model.RoomCategory
import com.voiza.app.domain.model.RoomSort
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.domain.model.SeatPolicy
import com.voiza.app.domain.model.User
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.RoomRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Home lobby: category tabs -> GET /api/rooms?category=..., user chip data,
 * and create-room submission.
 */
class HomeViewModel(
    private val roomRepository: RoomRepository = ServiceLocator.roomRepository,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
) : ViewModel() {

    data class HomeUiState(
        val category: RoomCategory = RoomCategory.POPULAR,
        val sort: RoomSort = RoomSort.DEFAULT,
        val search: String = "",
        /** True while the list is `GET /api/rooms/mine` rather than the lobby. */
        val showingMyRooms: Boolean = false,
        val rooms: List<RoomSummary> = emptyList(),
        val loading: Boolean = false,
        val refreshing: Boolean = false,
        val error: String? = null,
        val user: User? = null,
        val creatingRoom: Boolean = false,
        val createdRoomId: String? = null,
        val createError: String? = null,
        /** Null until the server answers; the form then offers no choice and the default applies. */
        val seatPolicy: SeatPolicy? = null,
        val quickJoinPending: Boolean = false,
        /** Set once the server has named a room; the screen navigates, then calls [quickJoinHandled]. */
        val quickJoinRoomId: String? = null,
        val quickJoinError: String? = null,
        /**
         * The room the edit form is about, read from `GET /api/rooms/:id` rather than reused from
         * the lobby row, so the host edits what the server holds right now.
         */
        val editingRoom: Room? = null,
        val savingRoom: Boolean = false,
        /** Set after a successful PATCH or delete; the screen navigates away, then clears it. */
        val savedRoomId: String? = null,
        val editError: String? = null,
    )

    private val _state = MutableStateFlow(HomeUiState())
    val state: StateFlow<HomeUiState> = _state.asStateFlow()

    init {
        loadRooms()
        loadSeatPolicy()
        viewModelScope.launch {
            authRepository.currentUser.collect { user ->
                _state.update { it.copy(user = user) }
            }
        }
    }

    /**
     * Seat bounds are the administrator's, so they are fetched, never shipped in a build. If the
     * call fails the create form sends no capacity at all and the server's default is used.
     */
    private fun loadSeatPolicy() {
        viewModelScope.launch {
            when (val result = roomRepository.seatPolicy()) {
                is ApiResult.Success -> if (result.data.isUsable) {
                    _state.update { it.copy(seatPolicy = result.data) }
                }
                is ApiResult.Failure -> Unit
            }
        }
    }

    fun selectCategory(category: RoomCategory) {
        if (_state.value.category == category && !_state.value.showingMyRooms) return
        // A tab is a lobby category, so it cannot stay selected while the list is `mine`.
        _state.update { it.copy(category = category, showingMyRooms = false) }
        loadRooms()
    }

    fun loadRooms() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            fetch()
        }
    }

    fun refresh() {
        viewModelScope.launch {
            _state.update { it.copy(refreshing = true) }
            fetch()
            _state.update { it.copy(refreshing = false) }
        }
    }

    private suspend fun fetch() {
        val request = _state.value
        // Both branches answer with rooms the *server* selected and ordered; this client never
        // filters or sorts the list it already has.
        val result = if (request.showingMyRooms) {
            roomRepository.myRooms(limit = 20)
        } else {
            roomRepository.listRooms(
                category = request.category.name,
                limit = 60,
                search = request.search.trim().takeIf { it.isNotEmpty() },
                sort = request.sort.apiValue,
            )
        }
        when (result) {
            is ApiResult.Success -> _state.update {
                it.copy(rooms = result.data, loading = false, error = null)
            }
            is ApiResult.Failure -> _state.update {
                it.copy(loading = false, error = result.message)
            }
        }
    }

    /**
     * Search is sent to the API rather than run on the 60 rooms already on screen: the lobby
     * must find the room that is ranked 200th, and only the server can see it.
     */
    fun setSearch(query: String) {
        if (_state.value.search == query) return
        _state.update { it.copy(search = query) }
        loadRooms()
    }

    fun selectSort(sort: RoomSort) {
        if (_state.value.sort == sort) return
        _state.update { it.copy(sort = sort) }
        loadRooms()
    }

    /** My Room: the caller's own rooms, straight from `GET /api/rooms/mine`. */
    fun toggleMyRooms() {
        _state.update { it.copy(showingMyRooms = !_state.value.showingMyRooms) }
        loadRooms()
    }

    /** Quick Join: ask the server for a room, then let the caller tap into it. */
    fun quickJoin() {
        viewModelScope.launch {
            _state.update { it.copy(quickJoinPending = true, quickJoinError = null) }
            when (val result = roomRepository.quickJoin()) {
                is ApiResult.Success -> _state.update {
                    it.copy(quickJoinPending = false, quickJoinRoomId = result.data.id)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(quickJoinPending = false, quickJoinError = result.message)
                }
            }
        }
    }

    fun quickJoinHandled() {
        _state.update { it.copy(quickJoinRoomId = null) }
    }

    // ---- Create room -----------------------------------------------------------

    fun createRoom(
        title: String,
        description: String?,
        category: RoomCategory,
        isPrivate: Boolean,
        password: String?,
        seatCapacity: Int?,
        language: String? = null,
        region: String? = null,
        rules: String? = null,
    ) {
        if (title.isBlank()) {
            _state.update { it.copy(createError = "Give your room a title") }
            return
        }
        if (isPrivate && password.isNullOrBlank()) {
            _state.update { it.copy(createError = "Private rooms need a password") }
            return
        }
        // Only a capacity the server published is worth sending; anything else and the host
        // gets the platform default rather than a number this build invented.
        val policy = _state.value.seatPolicy
        val capacity = seatCapacity?.let { chosen -> policy?.let { chosen.coerceIn(it.minSeats, it.maxSeats) } }
        viewModelScope.launch {
            _state.update { it.copy(creatingRoom = true, createError = null) }
            val result = roomRepository.createRoom(
                title = title.trim(),
                description = description?.trim()?.takeIf { it.isNotEmpty() },
                category = category.name,
                type = if (isPrivate) "PRIVATE" else "PUBLIC",
                password = password?.takeIf { isPrivate },
                seatCapacity = capacity,
                language = language?.trim()?.takeIf { it.isNotEmpty() },
                region = region?.trim()?.takeIf { it.isNotEmpty() },
                rules = rules?.trim()?.takeIf { it.isNotEmpty() },
            )
            when (result) {
                is ApiResult.Success -> _state.update {
                    it.copy(creatingRoom = false, createdRoomId = result.data.id)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(creatingRoom = false, createError = result.message)
                }
            }
        }
    }

    fun consumedCreatedRoom() = _state.update { it.copy(createdRoomId = null) }

    fun clearCreateError() = _state.update { it.copy(createError = null) }

    // ---- Edit room (host only) --------------------------------------------------

    /** Load the room the host wants to change. A non-host gets the server's refusal as text. */
    fun loadRoomForEdit(roomId: String) {
        viewModelScope.launch {
            when (val result = roomRepository.getRoom(roomId)) {
                is ApiResult.Success -> _state.update { it.copy(editingRoom = result.data.room) }
                is ApiResult.Failure -> _state.update { it.copy(editError = result.message) }
            }
        }
    }

    /**
     * PATCH the profile. Blank text is sent as an empty string, which is how the server clears a
     * field; access type, password and seat count are not editable here at all, because the
     * endpoint does not accept them.
     */
    fun saveRoom(
        roomId: String,
        title: String,
        description: String,
        category: RoomCategory,
        language: String,
        region: String,
        rules: String,
    ) {
        if (title.isBlank()) {
            _state.update { it.copy(editError = "A room needs a title") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(savingRoom = true, editError = null) }
            val result = roomRepository.updateRoom(
                roomId = roomId,
                title = title.trim(),
                description = description.trim(),
                category = category.name,
                language = language.trim(),
                region = region.trim(),
                rules = rules.trim(),
            )
            when (result) {
                is ApiResult.Success -> _state.update {
                    it.copy(savingRoom = false, editingRoom = result.data, savedRoomId = result.data.id)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(savingRoom = false, editError = result.message)
                }
            }
        }
    }

    /**
     * Delete a room the caller owns. Most rooms are refused — the server keeps any room that
     * somebody stood in or that money moved through, and that refusal is what we surface.
     */
    fun deleteRoom(roomId: String) {
        viewModelScope.launch {
            _state.update { it.copy(savingRoom = true, editError = null) }
            when (val result = roomRepository.deleteRoom(roomId)) {
                is ApiResult.Success -> _state.update {
                    it.copy(savingRoom = false, savedRoomId = roomId)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(savingRoom = false, editError = result.message)
                }
            }
        }
    }

    fun consumedSavedRoom() = _state.update { it.copy(savedRoomId = null) }
}
