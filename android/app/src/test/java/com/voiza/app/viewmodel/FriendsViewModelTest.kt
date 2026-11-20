package com.voiza.app.viewmodel

import com.voiza.app.data.remote.ApiResult
import com.voiza.app.domain.model.Conversation
import com.voiza.app.domain.model.DirectMessage
import com.voiza.app.domain.model.FriendPage
import com.voiza.app.domain.model.FriendRequest
import com.voiza.app.domain.model.FriendRequestPage
import com.voiza.app.domain.model.FriendRequestStatus
import com.voiza.app.domain.model.MessagePage
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.User
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.FriendsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The friends screen must never show a row or a bubble the server did not confirm. These tests use
 * the same hand-written-fake style as the rest of the view-model tests: no mocking framework, and
 * an unconfined Main dispatcher so a `viewModelScope.launch` has written its state before the assert.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class FriendsViewModelTest {

    private lateinit var repository: FakeFriendsRepository
    private lateinit var requestEvents: MutableSharedFlow<FriendRequest>
    private lateinit var messageEvents: MutableSharedFlow<DirectMessage>

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        repository = FakeFriendsRepository()
        requestEvents = MutableSharedFlow(extraBufferCapacity = 8)
        messageEvents = MutableSharedFlow(extraBufferCapacity = 8)
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun viewModel() = FriendsViewModel(
        friendsRepository = repository,
        authRepository = FakeAuthRepository(),
        friendEvents = requestEvents,
        messageEvents = messageEvents,
    )

    @Test
    fun `an accepted request disappears only after the server agrees`() {
        repository.acceptResult = ApiResult.Success(true)
        val vm = viewModel()
        assertEquals(1, vm.state.value.incoming.size)

        vm.acceptRequest("q1")

        assertTrue(vm.state.value.incoming.isEmpty())
        assertEquals("Friend added", vm.state.value.message)
    }

    @Test
    fun `a refused decision keeps the request and shows the server's reason`() {
        repository.acceptResult = ApiResult.Failure("Not your request to accept", httpCode = 403)
        val vm = viewModel()

        vm.acceptRequest("q1")

        assertEquals(1, vm.state.value.incoming.size)
        assertEquals("Not your request to accept", vm.state.value.error)
    }

    @Test
    fun `a refused message is not drawn as a bubble`() {
        val vm = viewModel()
        vm.openConversation(friend)
        repository.sendResult = ApiResult.Failure("You can only message friends", httpCode = 403)

        vm.onDraftChange("hello")
        vm.sendMessage()

        assertTrue(vm.state.value.messages.isEmpty())
        assertEquals("You can only message friends", vm.state.value.error)
        assertEquals("hello", vm.state.value.draft)
    }

    @Test
    fun `a delivered message from the open partner is appended once`() {
        val vm = viewModel()
        vm.openConversation(friend)

        val accepted = requestEvents.tryEmit(request) // a request event re-reads the server's list
        val first = messageEvents.tryEmit(message)
        val duplicate = messageEvents.tryEmit(message)

        assertTrue(accepted)
        assertTrue(first)
        assertTrue(duplicate)
        assertEquals(1, vm.state.value.messages.size)
        assertEquals("m1", vm.state.value.messages.first().id)
        assertTrue("a new request must be re-read from the server", repository.incomingCalls > 1)
    }

    @Test
    fun `a message from somebody else refreshes conversations instead of entering the thread`() {
        val vm = viewModel()
        vm.openConversation(friend)
        val before = repository.conversationsCalls

        messageEvents.tryEmit(message.copy(id = "m2", senderId = "other"))

        assertTrue(repository.conversationsCalls > before)
        assertTrue(vm.state.value.messages.isEmpty())
    }

    private class FakeFriendsRepository : FriendsRepository {
        var friendsResult: ApiResult<FriendPage> = ApiResult.Success(FriendPage(listOf(friend), 1, 1, 50))
        var incomingResult: ApiResult<FriendRequestPage> = ApiResult.Success(FriendRequestPage(listOf(request), 1, 1, 20))
        var outgoingResult: ApiResult<FriendRequestPage> = ApiResult.Success(FriendRequestPage(emptyList(), 0, 1, 20))
        var conversationsResult: ApiResult<List<Conversation>> = ApiResult.Success(emptyList())
        var acceptResult: ApiResult<Boolean> = ApiResult.Success(true)
        var declineResult: ApiResult<Boolean> = ApiResult.Success(true)
        var requestResult: ApiResult<FriendRequest> = ApiResult.Success(request)
        var sendResult: ApiResult<DirectMessage> = ApiResult.Success(message)

        var incomingCalls = 0
        var conversationsCalls = 0

        override suspend fun sendFriendRequest(targetUserId: String) = requestResult
        override suspend fun friends(page: Int, limit: Int) = friendsResult
        override suspend fun requests(direction: String, page: Int, limit: Int): ApiResult<FriendRequestPage> {
            if (direction == "incoming") incomingCalls++
            return if (direction == "incoming") incomingResult else outgoingResult
        }
        override suspend fun acceptRequest(requestId: String) = acceptResult
        override suspend fun declineRequest(requestId: String) = declineResult
        override suspend fun unfriend(userId: String): ApiResult<Boolean> = ApiResult.Success(false)
        override suspend fun setDoNotContact(userId: String, value: Boolean): ApiResult<Boolean> = ApiResult.Success(value)
        override suspend fun conversations(): ApiResult<List<Conversation>> {
            conversationsCalls++
            return conversationsResult
        }
        override suspend fun messages(userId: String, page: Int, limit: Int): ApiResult<MessagePage> =
            ApiResult.Success(MessagePage(emptyList(), 0, page, limit))
        override suspend fun sendMessage(userId: String, content: String) = sendResult
        override suspend fun markRead(userId: String): ApiResult<Boolean> = ApiResult.Success(true)
    }

    private class FakeAuthRepository : AuthRepository {
        override val currentUser = MutableStateFlow<User?>(user)
        override suspend fun requestOtp(phone: String): ApiResult<com.voiza.app.domain.repository.OtpChallenge> =
            ApiResult.Failure("not used")
        override suspend fun verifyOtp(phone: String, code: String, username: String?): ApiResult<User> =
            ApiResult.Failure("not used")
        override suspend fun refreshMe(): ApiResult<User> = ApiResult.Success(user)
        override suspend fun updateProfile(username: String?, avatarUrl: String?, bio: String?): ApiResult<User> =
            ApiResult.Success(user)
        override fun logout() = Unit
    }

    companion object {
        val friend = MiniUser(id = "f1", username = "Friend", avatarUrl = null)
        val request = FriendRequest(
            id = "q1",
            status = FriendRequestStatus.PENDING,
            statusLabel = "Pending",
            createdAt = "2026-11-01T00:00:00.000Z",
            respondedAt = null,
            requester = MiniUser(id = "f2", username = "Requester", avatarUrl = null),
            addressee = MiniUser(id = "me", username = "Me", avatarUrl = null),
        )
        val message = DirectMessage(
            id = "m1",
            conversationId = "c1",
            senderId = "f1",
            content = "hi",
            createdAt = "2026-11-01T00:00:00.000Z",
            readAt = null,
        )
        val user = User(
            id = "me",
            phone = "+10000000000",
            username = "Me",
            avatarUrl = null,
            bio = null,
            gender = null,
            countryCode = null,
            diamondBalance = 0,
            rCoinBalance = 0,
            totalGiftsSent = 0,
            totalGiftsReceived = 0,
            userType = "USER",
            status = "ACTIVE",
            isVerified = false,
        )
    }
}
