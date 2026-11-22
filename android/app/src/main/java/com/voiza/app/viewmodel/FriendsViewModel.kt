package com.voiza.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.Conversation
import com.voiza.app.domain.model.DirectMessage
import com.voiza.app.domain.model.FriendDistance
import com.voiza.app.domain.model.FriendRequest
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.User
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.FriendsRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The three lists served by `/api/friends`, `/api/friends/requests` and `/api/dm`. */
enum class FriendsTab { FRIENDS, REQUESTS, MESSAGES }

/**
 * Friends, requests and one-to-one messages.
 *
 * Nothing here decides whether a friendship or a message is allowed: the server answers 409 for a
 * duplicate request and 403 for a non-friend, a block or a do-not-contact flag, and those words are
 * shown as they arrived. Likewise a conversation's unread count is re-read from the server after a
 * `dm:message` — never incremented here — because the count is a query result, not a local tally.
 */
class FriendsViewModel(
    private val friendsRepository: FriendsRepository = ServiceLocator.friendsRepository,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
    private val friendEvents: SharedFlow<FriendRequest> = ServiceLocator.socketClient.friendRequests,
    private val messageEvents: SharedFlow<DirectMessage> = ServiceLocator.socketClient.directMessages,
) : ViewModel() {

    data class FriendsUiState(
        val tab: FriendsTab = FriendsTab.FRIENDS,
        val user: User? = null,
        val friends: List<MiniUser> = emptyList(),
        val locationSharingEnabled: Boolean = false,
        val friendDistances: Map<String, Int?> = emptyMap(),
        val incoming: List<FriendRequest> = emptyList(),
        val outgoing: List<FriendRequest> = emptyList(),
        val conversations: List<Conversation> = emptyList(),
        val openPartner: MiniUser? = null,
        val messages: List<DirectMessage> = emptyList(),
        val loadingMessages: Boolean = false,
        val draft: String = "",
        val loading: Boolean = false,
        val busy: Boolean = false,
        val error: String? = null,
        val message: String? = null,
    ) {
        val isGuest: Boolean get() = user == null && !loading
    }

    private val _state = MutableStateFlow(FriendsUiState())
    val state: StateFlow<FriendsUiState> = _state.asStateFlow()
    private var conversationRequestVersion = 0L

    init {
        load()
        viewModelScope.launch {
            authRepository.currentUser.collect { user -> _state.update { it.copy(user = user) } }
        }
        viewModelScope.launch {
            friendEvents.collect {
                // A request is an insert into the server's pending list. Re-reading that list is
                // safer than appending: a decision made on another device may have removed a row.
                refreshRequests()
            }
        }
        viewModelScope.launch {
            messageEvents.collect { message ->
                val openId = _state.value.openPartner?.id
                if (openId != null && message.senderId == openId) {
                    _state.update { state ->
                        if (state.messages.any { it.id == message.id }) state
                        else state.copy(messages = state.messages + message)
                    }
                } else {
                    refreshConversations()
                }
            }
        }
    }

    /** Read all three lists. A failed section keeps its previous rows and contributes the error. */
    fun load() {
        if (authRepository.currentUser.value == null) {
            _state.update { it.copy(loading = false) }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            var error: String? = null
            when (val result = friendsRepository.friends()) {
                is ApiResult.Success -> _state.update { it.copy(friends = result.data.friends) }
                is ApiResult.Failure -> error = result.message
            }
            when (val result = friendsRepository.requests("incoming")) {
                is ApiResult.Success -> _state.update { it.copy(incoming = result.data.requests) }
                is ApiResult.Failure -> error = error ?: result.message
            }
            when (val result = friendsRepository.requests("outgoing")) {
                is ApiResult.Success -> _state.update { it.copy(outgoing = result.data.requests) }
                is ApiResult.Failure -> error = error ?: result.message
            }
            when (val sharing = friendsRepository.locationSharingEnabled()) { is ApiResult.Success -> _state.update { it.copy(locationSharingEnabled = sharing.data) }; is ApiResult.Failure -> Unit }
            refreshFriendDistances()
            refreshConversationsIntoError(error)
        }
    }

    fun setLocationSharing(enabled: Boolean) {
        viewModelScope.launch {
            when (val result = friendsRepository.setLocationSharing(enabled)) {
                is ApiResult.Success -> { _state.update { it.copy(locationSharingEnabled = result.data, friendDistances = if (enabled) it.friendDistances else emptyMap()) }; if (enabled) refreshFriendDistances() }
                is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
            }
        }
    }
    fun updateLocation(latitude: Double, longitude: Double) {
        if (!_state.value.locationSharingEnabled) return
        viewModelScope.launch { if (friendsRepository.updateLocation(latitude, longitude) is ApiResult.Success) refreshFriendDistances() }
    }
    private suspend fun refreshFriendDistances() {
        when (val result = friendsRepository.friendDistances()) {
            is ApiResult.Success -> _state.update { it.copy(friendDistances = result.data.associate { d -> d.friendId to d.distanceMeters }) }
            is ApiResult.Failure -> Unit
        }
    }

    fun selectTab(tab: FriendsTab) {
        if (tab == FriendsTab.MESSAGES) {
            _state.update { it.copy(tab = tab, error = null) }
            return
        }
        // Leaving Messages closes the selected thread; coming back opens the list, not stale chat.
        conversationRequestVersion++
        _state.update {
            it.copy(
                tab = tab,
                openPartner = null,
                messages = emptyList(),
                loadingMessages = false,
                draft = "",
                error = null,
            )
        }
    }

    fun sendFriendRequest(targetUserId: String) {
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null, message = null) }
            when (val result = friendsRepository.sendFriendRequest(targetUserId)) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        busy = false,
                        outgoing = listOf(result.data) + it.outgoing.filter { r -> r.id != result.data.id },
                        message = "Friend request sent",
                    )
                }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.message) }
            }
        }
    }

    fun acceptRequest(requestId: String) = decideRequest(requestId, accept = true)

    fun declineRequest(requestId: String) = decideRequest(requestId, accept = false)

    private fun decideRequest(requestId: String, accept: Boolean) {
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null, message = null) }
            val result = if (accept) friendsRepository.acceptRequest(requestId)
            else friendsRepository.declineRequest(requestId)
            when (result) {
                is ApiResult.Success -> {
                    if (accept) refreshFriends()
                    _state.update {
                        it.copy(
                            busy = false,
                            incoming = it.incoming.filter { r -> r.id != requestId },
                            message = if (accept) "Friend added" else "Friend request declined",
                        )
                    }
                }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.message) }
            }
        }
    }

    fun unfriend(userId: String) {
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null, message = null) }
            when (val result = friendsRepository.unfriend(userId)) {
                is ApiResult.Success -> {
                    val close = _state.value.openPartner?.id == userId
                    if (close) conversationRequestVersion++
                    _state.update {
                        it.copy(
                            busy = false,
                            friends = it.friends.filter { f -> f.id != userId },
                            openPartner = if (close) null else it.openPartner,
                            messages = if (close) emptyList() else it.messages,
                            loadingMessages = if (close) false else it.loadingMessages,
                            draft = if (close) "" else it.draft,
                            message = "Friend removed",
                        )
                    }
                    refreshConversations()
                }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.message) }
            }
        }
    }

    fun setDoNotContact(userId: String, value: Boolean) {
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null, message = null) }
            when (val result = friendsRepository.setDoNotContact(userId, value)) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        busy = false,
                        message = if (value) "This member can no longer contact you" else "Contact allowed again",
                    )
                }
                is ApiResult.Failure -> _state.update { it.copy(busy = false, error = result.message) }
            }
        }
    }

    /** Read a friend's messages and ask the server to mark their side read. */
    fun openConversation(partner: MiniUser) {
        val requestVersion = ++conversationRequestVersion
        _state.update {
            it.copy(
                tab = FriendsTab.MESSAGES,
                openPartner = partner,
                messages = emptyList(),
                loadingMessages = true,
                draft = "",
                error = null,
            )
        }
        viewModelScope.launch {
            when (val result = friendsRepository.messages(partner.id)) {
                is ApiResult.Success -> _state.update {
                    if (requestVersion == conversationRequestVersion && it.openPartner?.id == partner.id) {
                        it.copy(messages = result.data.messages, loadingMessages = false)
                    } else it
                }
                is ApiResult.Failure -> _state.update {
                    if (requestVersion == conversationRequestVersion && it.openPartner?.id == partner.id) {
                        it.copy(error = result.message, loadingMessages = false)
                    } else it
                }
            }
            friendsRepository.markRead(partner.id)
            refreshConversations()
        }
    }

    /** Resolve a notification deep link against the server's conversation list before opening it. */
    fun openConversationById(partnerId: String) {
        if (partnerId.isBlank()) return
        val requestVersion = ++conversationRequestVersion
        _state.update {
            it.copy(
                tab = FriendsTab.MESSAGES,
                openPartner = null,
                messages = emptyList(),
                loadingMessages = true,
                draft = "",
                error = null,
            )
        }
        viewModelScope.launch {
            when (val result = friendsRepository.conversations()) {
                is ApiResult.Success -> {
                    if (requestVersion != conversationRequestVersion) return@launch
                    val partner = result.data.firstOrNull { it.partner.id == partnerId }?.partner
                    _state.update { it.copy(conversations = result.data, loadingMessages = false) }
                    if (partner == null) {
                        _state.update { it.copy(error = "Conversation not found") }
                    } else {
                        openConversation(partner)
                    }
                }
                is ApiResult.Failure -> {
                    if (requestVersion == conversationRequestVersion) {
                        _state.update { it.copy(loadingMessages = false, error = result.message) }
                    }
                }
            }
        }
    }

    /** Return from a direct-message thread to the conversation list without leaving Friends. */
    fun closeConversation() {
        conversationRequestVersion++
        _state.update {
            it.copy(
                openPartner = null,
                messages = emptyList(),
                loadingMessages = false,
                draft = "",
                error = null,
            )
        }
    }

    fun onDraftChange(value: String) = _state.update { it.copy(draft = value) }

    fun sendMessage() {
        val partner = _state.value.openPartner ?: return
        val text = _state.value.draft.trim()
        if (text.isEmpty() || _state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null, message = null) }
            when (val result = friendsRepository.sendMessage(partner.id, text)) {
                is ApiResult.Success -> _state.update {
                    if (it.openPartner?.id != partner.id) {
                        it.copy(busy = false)
                    } else {
                        val sent = result.data
                        val already = it.messages.any { m -> m.id == sent.id }
                        it.copy(
                            busy = false,
                            draft = "",
                            messages = if (already) it.messages else it.messages + sent,
                        )
                    }
                }
                is ApiResult.Failure -> _state.update {
                    if (it.openPartner?.id == partner.id) it.copy(busy = false, error = result.message)
                    else it.copy(busy = false)
                }
            }
            refreshConversations()
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }

    fun consumeMessage() = _state.update { it.copy(message = null) }

    private fun refreshFriends() {
        viewModelScope.launch {
            when (val result = friendsRepository.friends()) {
                is ApiResult.Success -> _state.update { it.copy(friends = result.data.friends) }
                is ApiResult.Failure -> Unit
            }
        }
    }

    private fun refreshRequests() {
        viewModelScope.launch {
            when (val result = friendsRepository.requests("incoming")) {
                is ApiResult.Success -> _state.update { it.copy(incoming = result.data.requests) }
                is ApiResult.Failure -> Unit
            }
            when (val result = friendsRepository.requests("outgoing")) {
                is ApiResult.Success -> _state.update { it.copy(outgoing = result.data.requests) }
                is ApiResult.Failure -> Unit
            }
        }
    }

    private fun refreshConversations() {
        // Carry the current error forward: a conversation re-read must not erase a failure the
        // user still needs to see (a refused message, for example).
        viewModelScope.launch { refreshConversationsIntoError(_state.value.error) }
    }

    private suspend fun refreshConversationsIntoError(previousError: String?) {
        when (val result = friendsRepository.conversations()) {
            is ApiResult.Success -> _state.update {
                it.copy(conversations = result.data, loading = false, error = previousError)
            }
            is ApiResult.Failure -> _state.update {
                it.copy(loading = false, error = previousError ?: result.message)
            }
        }
    }
}
