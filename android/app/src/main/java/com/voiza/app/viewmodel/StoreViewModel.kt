package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.OwnedStoreItem
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.domain.model.StoreItem
import com.voiza.app.domain.model.StoreItemKind
import com.voiza.app.domain.model.StoreSnapshot
import com.voiza.app.domain.model.User
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.RoomRepository
import com.voiza.app.domain.repository.StoreRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The cosmetic shop screen.
 *
 * The catalogue is the server's answer for this member, so after a purchase the list is reloaded
 * rather than patched here: the row's expiry, its "owned" flag and the wallet all moved inside that
 * transaction, and a local guess would drift the moment an operator re-prices or a rental lapses.
 * Equip and unequip are the exception — the server returns the account, the only field that
 * changes in the list is "which of this kind is worn", and the account itself is pushed into the
 * session by the repository.
 */
class StoreViewModel(
    private val storeRepository: StoreRepository = ServiceLocator.storeRepository,
    private val roomRepository: RoomRepository = ServiceLocator.roomRepository,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
) : ViewModel() {

    data class StoreUiState(
        val tab: StoreItemKind = StoreItemKind.FRAME,
        val snapshot: StoreSnapshot? = null,
        val user: User? = null,
        val loading: Boolean = false,
        val error: String? = null,
        /** The id of the row a request is running for, so only that card shows a spinner. */
        val busyId: String? = null,
        val message: String? = null,
        /**
         * Rooms the caller hosts, present only while the sheet is asking which room should wear an
         * owned theme. Null means the question is not being asked.
         */
        val themeRooms: List<RoomSummary>? = null,
        val roomsLoading: Boolean = false,
    ) {
        /** Rows of the selected catalogue, in the order the server sorted them. */
        val items: List<StoreItem> get() = snapshot?.itemsOf(tab).orEmpty()

        /** What an operator has retired from sale but this member still holds. */
        val retiredOwned: List<OwnedStoreItem>
            get() = snapshot?.owned.orEmpty().filter { it.kind == tab && !it.onSale }

        val balance: Int get() = user?.diamondBalance ?: 0

        fun canAfford(item: StoreItem): Boolean = balance >= item.priceDiamonds

        /** How many diamonds short a purchase is; zero when it is affordable. */
        fun shortfall(item: StoreItem): Int = (item.priceDiamonds - balance).coerceAtLeast(0)
    }

    private val _state = MutableStateFlow(StoreUiState())
    val state: StateFlow<StoreUiState> = _state.asStateFlow()

    init {
        load()
        viewModelScope.launch {
            authRepository.currentUser.collect { user ->
                _state.update { it.copy(user = user) }
            }
        }
    }

    fun selectTab(kind: StoreItemKind) = _state.update { it.copy(tab = kind) }

    fun load() {
        // Ownership and balances are per-account, so a guest has no catalogue to read; the
        // screen turns this into a sign-in prompt instead of a 401 from the server.
        if (authRepository.currentUser.value == null) {
            _state.update { it.copy(loading = false, error = null) }
            return
        }
        viewModelScope.launch {
            // The first load owns the spinner; a refresh after a purchase must not blank the grid.
            val firstLoad = _state.value.snapshot == null
            _state.update { it.copy(loading = firstLoad, error = null) }
            when (val result = storeRepository.catalogue()) {
                is ApiResult.Success -> _state.update {
                    it.copy(snapshot = result.data, loading = false, error = null)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, error = result.message)
                }
            }
        }
    }

    /**
     * Re-read the catalogue and the caller's own account when the screen comes back to the front.
     * A top-up paid through a seller, a purchase made on another device or a rental that lapsed all
     * move rows and the balance; both are server facts and neither is cached here.
     */
    fun refresh() {
        // The initial load already answers the first visit, and a guest has no rows to re-read.
        if (_state.value.snapshot == null) return
        viewModelScope.launch { authRepository.refreshMe() }
        load()
    }

    /**
     * Buy a row. Only the kind and the key travel; the price the server charges is the one in its
     * own catalogue at the instant the transaction runs, which may differ from the one on screen.
     */
    fun buy(item: StoreItem) {
        if (_state.value.busyId != null) return
        viewModelScope.launch {
            _state.update { it.copy(busyId = item.id, error = null) }
            when (val result = storeRepository.purchase(item.kind, item.key)) {
                is ApiResult.Success -> {
                    val bought = result.data.item ?: item
                    _state.update { it.copy(busyId = null, message = purchasedMessage(bought)) }
                    // The row now has an expiry and the wallet moved; read both from the server.
                    load()
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(busyId = null, error = result.message)
                }
            }
        }
    }

    /** Wear an owned ring or flourish. A theme is worn by a room, so the server refuses it. */
    fun wear(item: StoreItem) {
        if (!item.wearable || _state.value.busyId != null) return
        viewModelScope.launch {
            _state.update { it.copy(busyId = item.id, error = null) }
            when (val result = storeRepository.equip(item.kind, item.key)) {
                is ApiResult.Success -> _state.update { st ->
                    st.copy(busyId = null, message = "${item.name} is on.")
                        .withEquipped(item.kind, item.key)
                }
                is ApiResult.Failure -> _state.update { it.copy(busyId = null, error = result.message) }
            }
        }
    }

    fun takeOff(kind: StoreItemKind) {
        if (kind == StoreItemKind.THEME || _state.value.busyId != null) return
        viewModelScope.launch {
            _state.update { it.copy(busyId = kind.name, error = null) }
            when (val result = storeRepository.unequip(kind)) {
                is ApiResult.Success -> _state.update { st ->
                    st.copy(busyId = null, message = "Removed.").withEquipped(kind, null)
                }
                is ApiResult.Failure -> _state.update { it.copy(busyId = null, error = result.message) }
            }
        }
    }

    /**
     * A theme is worn by a room, so the shop asks which one. `GET /api/rooms/mine` is the server's
     * answer to "what may I style"; a member who hosts nothing sees that sentence instead of a list.
     */
    fun loadMyRooms() {
        if (_state.value.roomsLoading) return
        viewModelScope.launch {
            _state.update { it.copy(roomsLoading = true, error = null) }
            when (val result = roomRepository.myRooms(limit = 20)) {
                is ApiResult.Success -> _state.update {
                    it.copy(roomsLoading = false, themeRooms = result.data)
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(roomsLoading = false, error = result.message)
                }
            }
        }
    }

    /** Put an owned theme on one of the caller's rooms; the server re-checks ownership itself. */
    fun applyTheme(room: RoomSummary, item: StoreItem) {
        if (_state.value.busyId != null) return
        viewModelScope.launch {
            _state.update { it.copy(busyId = item.id, error = null) }
            when (val result = roomRepository.setTheme(room.id, item.key)) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        busyId = null,
                        themeRooms = null,
                        message = "${item.name} is now on ${result.data.title}.",
                    )
                }
                is ApiResult.Failure -> _state.update { it.copy(busyId = null, error = result.message) }
            }
        }
    }

    fun closeRoomPicker() = _state.update { it.copy(themeRooms = null) }

    fun consumeMessage() = _state.update { it.copy(message = null) }

    fun clearError() = _state.update { it.copy(error = null) }

    private fun purchasedMessage(item: StoreItem): String =
        if (item.periodDays == null) "${item.name} is yours — permanently."
        else "${item.name} is yours for ${item.periodDays} days."

    /** After a confirmed equip, exactly one row of that kind is worn — or none when [key] is null. */
    private fun StoreUiState.withEquipped(kind: StoreItemKind, key: String?): StoreUiState {
        val current = snapshot ?: return this
        return copy(
            snapshot = current.copy(
                items = current.items.map { row ->
                    if (row.kind == kind) row.copy(equipped = key != null && row.key == key) else row
                },
            ),
        )
    }
}
