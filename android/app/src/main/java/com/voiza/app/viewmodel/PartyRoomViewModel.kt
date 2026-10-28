package com.voiza.app.viewmodel

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voiza.app.BuildConfig
import com.voiza.app.data.livekit.LiveKitRoomManager
import com.voiza.app.data.livekit.LkConnectionState
import com.voiza.app.data.remote.ApiResult
import com.voiza.app.data.socket.VoizaSocketClient
import com.voiza.app.di.ServiceLocator
import com.voiza.app.domain.model.ChatMessage
import com.voiza.app.domain.model.EmojiOption
import com.voiza.app.domain.model.FALLBACK_EMOJI_CODE_PATTERN
import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.domain.model.HeartSignal
import com.voiza.app.domain.model.Leaderboard
import com.voiza.app.domain.model.LiveKitCredentials
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.MessageType
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.Room
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatStatus
import com.voiza.app.domain.model.User
import com.voiza.app.domain.model.UserJoinedEvent
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.RoomRepository
import com.voiza.app.domain.usecase.JoinRoomUseCase
import com.voiza.app.domain.usecase.RoomEffects
import com.voiza.app.domain.usecase.SendGiftUseCase
import com.voiza.app.domain.usecase.TakeSeatUseCase
import com.voiza.app.domain.usecase.ToggleMuteUseCase
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The room screen brain: REST join -> LiveKit connect -> socket fan-in.
 *
 * Source-of-truth rules:
 *  - Seats/audience arrive from the join response, every REST seat mutation's
 *    response body, and `room:seat_update` events (idempotent full snapshots).
 *  - Publishing rights follow the seat list: canPublish == I hold a seat with
 *    isSpeaker. Right changes call LiveKitRoomManager.updatePublishRights(),
 *    never a full reconnect.
 *  - Gift effects queue so overlapping sends play in order, split by the tier
 *    the operator set on the gift: small gifts scroll the ticker column, big ones
 *    take over the screen one at a time.
 *  - Likes are counted by the server. Taps here only report intent, batched.
 */
class PartyRoomViewModel(
    val roomId: String,
    private val roomRepository: RoomRepository = ServiceLocator.roomRepository,
    private val authRepository: AuthRepository = ServiceLocator.authRepository,
    private val joinRoomUseCase: JoinRoomUseCase = ServiceLocator.joinRoomUseCase,
    private val takeSeatUseCase: TakeSeatUseCase = ServiceLocator.takeSeatUseCase,
    private val sendGiftUseCase: SendGiftUseCase = ServiceLocator.sendGiftUseCase,
    private val toggleMuteUseCase: ToggleMuteUseCase = ServiceLocator.toggleMuteUseCase,
    private val socket: VoizaSocketClient = ServiceLocator.socketClient,
    private val liveKit: LiveKitRoomManager = ServiceLocator.liveKitRoomManager,
) : ViewModel() {

    // ---- UI state -------------------------------------------------------------

    data class PartyRoomUiState(
        val loading: Boolean = true,
        val error: String? = null,
        val needsPassword: Boolean = false,
        val joined: Boolean = false,
        val roomClosed: Boolean = false,
        val kicked: Boolean = false,
        /** Text of the latest operator warning, or null when nothing is pending. */
        val operatorWarning: String? = null,

        val room: Room? = null,
        val seats: List<Seat> = emptyList(),
        val audience: List<MiniUser> = emptyList(),
        val chat: List<ChatMessage> = emptyList(),
        val listenerCount: Int = 0,

        /** Audience members waiting in the request-to-speak queue. */
        val handRaises: List<MiniUser> = emptyList(),
        val audienceSheetVisible: Boolean = false,

        val user: User? = null,
        val mySeatIndex: Int? = null,
        val isHost: Boolean = false,
        val canPublish: Boolean = false,
        val micMuted: Boolean = false,
        val handRaised: Boolean = false,
        val livekitState: LkConnectionState = LkConnectionState.DISCONNECTED,

        /** LiveKit identity -> audio level, resolved to seats by the UI. */
        val speakingLevels: Map<String, Double> = emptyMap(),

        /**
         * Full-screen gift line: strictly one at a time, at most
         * [RoomEffects.TAKEOVER_MAX] waiting.
         */
        val giftQueue: List<GiftAnimatedEvent> = emptyList(),
        /** Small gifts scroll past in the column beside the seats instead. */
        val giftTicker: List<GiftAnimatedEvent> = emptyList(),
        /** Whose entry is currently announced, or null when nothing is showing. */
        val entryBanner: UserJoinedEvent? = null,

        /**
         * Lottie URL for the flourish played once per visit, read from `GET /api/rooms/themes`.
         * Null until that arrives — and stays null if the operator retired every welcome effect,
         * because this file has no path of its own to fall back on.
         */
        val welcomeEffect: String? = null,

        /**
         * Chat emoji from `GET /api/emoji`, in the picker order the operator set. Empty until that
         * arrives, and empty forever if the panel has no rows — then the picker shows nothing and a
         * typed `[code]` stays the plain text it always was.
         */
        val emojis: List<EmojiOption> = emptyList(),

        /**
         * The expression the server publishes for finding codes inside a message. Used as-is
         * rather than reimplemented here, so a change to what a valid code looks like is one
         * operator-side decision and not a client release.
         */
        val emojiCodePattern: String = FALLBACK_EMOJI_CODE_PATTERN,

        /** Room likes as the server counts them, plus the next heart request. */
        val likeTotal: Long = 0,
        val hearts: HeartSignal = HeartSignal(0, 0),

        val hostControlsSeat: Seat? = null,

        // Gift dialog state (catalogue + selection) — lives here so it
        // survives recomposition of the dialog composable.
        val giftCatalog: List<Gift> = emptyList(),
        val giftDialogVisible: Boolean = false,
        /** Selected catalogue tab; null means "all categories". */
        val giftCategory: String? = null,
        val selectedGift: Gift? = null,
        val selectedReceiverId: String? = null,
        val giftQuantity: Int = 1,
        val giftSending: Boolean = false,
        val giftError: String? = null,

        // Ranking sheet state (GET /api/users/top, opened from the gift panel).
        val rankingVisible: Boolean = false,
        val rankingWindow: String = "week",
        val rankingBoard: RankBoard = RankBoard.SENDERS,
        val ranking: Leaderboard? = null,
        val rankingLoading: Boolean = false,
        val rankingError: String? = null,
    ) {
        val seated: Boolean get() = mySeatIndex != null
        val totalCost: Int
            get() = (selectedGift?.diamondPrice ?: 0) * giftQuantity
        val canAfford: Boolean
            get() = (user?.diamondBalance ?: 0) >= totalCost
        /**
         * Gifts carry a spend tier (gifts.min_vip_level). The server rejects the send
         * with `vip_required`, so the sheet gates first to avoid a doomed request.
         */
        fun vipLocked(gift: Gift): Boolean = gift.minVipLevel > (user?.vipLevel ?: 0)
        val selectedGiftLocked: Boolean
            get() = selectedGift?.let { vipLocked(it) } ?: false
        val seatedUsers: List<MiniUser>
            get() = seats.mapNotNull { it.user }

        /** Catalogue categories in first-appearance order (the tab strip). */
        val giftCategories: List<String>
            get() = giftCatalog.map { it.category }.distinct()

        val visibleGifts: List<Gift>
            get() = if (giftCategory == null) giftCatalog
            else giftCatalog.filter { it.category == giftCategory }
    }

    private val _state = MutableStateFlow(PartyRoomUiState())
    val state: StateFlow<PartyRoomUiState> = _state.asStateFlow()

    private var credentials: LiveKitCredentials? = null
    private var pendingPassword: String? = null

    init {
        join()
        observeSocket()
        observeLiveKit()
        viewModelScope.launch {
            authRepository.currentUser.collect { user ->
                _state.update { it.copy(user = user) }
            }
        }
    }

    // ---- Entry / auth wiring ----------------------------------------------------

    /**
     * Mic runtime-permission result from the screen layer. Publishing stays
     * blocked until granted; no LiveKit reconnect happens either way.
     */
    fun onMicPermissionResult(granted: Boolean) {
        liveKit.setMicPermissionGranted(granted)
        if (!granted) {
            _state.update { it.copy(micMuted = true) }
        }
    }

    private fun join() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            val result = joinRoomUseCase(roomId, pendingPassword)
            when (result) {
                is ApiResult.Success -> onJoined(result.data.room, result.data.seats, result.data.audience, result.data.livekit)
                is ApiResult.Failure -> {
                    // 403-style private-room prompt: backend rejects join with
                    // a password error message; surface the password dialog.
                    val needsPassword = result.httpCode == 401 || result.httpCode == 403 ||
                        result.message.contains("password", ignoreCase = true)
                    _state.update {
                        it.copy(
                            loading = false,
                            error = if (needsPassword) null else result.message,
                            needsPassword = needsPassword,
                        )
                    }
                }
            }
        }
    }

    fun submitRoomPassword(password: String) {
        pendingPassword = password
        viewModelScope.launch {
            _state.update { it.copy(needsPassword = false, loading = true) }
            val result = joinRoomUseCase(roomId, password)
            when (result) {
                is ApiResult.Success -> onJoined(result.data.room, result.data.seats, result.data.audience, result.data.livekit)
                is ApiResult.Failure -> _state.update {
                    it.copy(loading = false, error = result.message, needsPassword = true)
                }
            }
        }
    }

    private fun onJoined(
        room: Room,
        seats: List<Seat>,
        audience: List<MiniUser>,
        lk: LiveKitCredentials,
    ) {
        credentials = lk
        val userId = _state.value.user?.id
        val mySeat = seats.firstOrNull { it.occupiedBy(userId) }
        _state.update {
            it.copy(
                loading = false,
                joined = true,
                error = null,
                room = room,
                seats = seats,
                audience = audience,
                chat = it.chat,
                listenerCount = room.listenerCount,
                likeTotal = room.likeCount,
                mySeatIndex = mySeat?.seatIndex,
                isHost = userId != null && userId == room.host.id,
                canPublish = mySeat?.isSpeaker == true && mySeat.status == SeatStatus.OCCUPIED,
                micMuted = mySeat?.isMuted ?: true,
            )
        }
        // Static chat history from the snapshot endpoint (join omits chat).
        viewModelScope.launch { loadChatHistory() }
        // The entry flourish is the operator's choice, so it is read once per visit.
        viewModelScope.launch { loadWelcomeEffect() }
        // Same for the chat emoji: a catalogue of rows, not a list this file may hardcode.
        viewModelScope.launch { loadEmojiCatalogue() }
        val lkUrl = lk.url.ifBlank { BuildConfig.VOIZA_LIVEKIT_URL }
        liveKit.connect(lkUrl, lk.token, lk.roomName, it_publishCan(lk, mySeat))
    }

    private fun it_publishCan(lk: LiveKitCredentials, mySeat: Seat?): Boolean =
        lk.canPublish || (mySeat?.isSpeaker == true)

    /**
     * The entry flourish, asked of the catalogue an operator maintains in the database. Failure
     * leaves it null and the room plays nothing on entry: a missing flourish is not worth an error
     * banner over a party someone just walked into.
     */
    private suspend fun loadWelcomeEffect() {
        val result = roomRepository.themeCatalogue()
        if (result is ApiResult.Success) {
            _state.update { it.copy(welcomeEffect = result.data.welcome) }
        }
    }

    /**
     * The picker catalogue. Like the flourish, a failure is silent: chat still works, it simply
     * has no art to offer and no codes to draw.
     */
    private suspend fun loadEmojiCatalogue() {
        val result = roomRepository.emojiCatalogue()
        if (result is ApiResult.Success) {
            _state.update {
                it.copy(emojis = result.data.emojis, emojiCodePattern = result.data.codePattern)
            }
        }
    }

    /** Static snapshot from the detail endpoint (join omits chat and the queue). */
    private suspend fun loadChatHistory() {
        val detail = roomRepository.getRoom(roomId)
        if (detail is ApiResult.Success) {
            _state.update {
                it.copy(
                    chat = detail.data.chat.takeLast(HISTORY_CHAT_LIMIT),
                    handRaises = detail.data.handRaises,
                )
            }
        }
    }

    // ---- Socket + LiveKit observation --------------------------------------------

    private fun observeSocket() {
        viewModelScope.launch {
            socket.chatMessages.collect { ev ->
                if (ev.roomId != roomId) return@collect
                _state.update { it.copy(chat = RoomEffects.appendChat(it.chat, ev.message, MAX_CHAT)) }
            }
        }
        viewModelScope.launch {
            socket.seatUpdates.collect { ev ->
                if (ev.roomId != roomId) return@collect
                applySeats(ev.seats, ev.audience)
            }
        }
        viewModelScope.launch {
            socket.listenerCounts.collect { ev ->
                if (ev.roomId != roomId) return@collect
                _state.update { it.copy(listenerCount = ev.count) }
            }
        }
        viewModelScope.launch {
            socket.userJoined.collect { ev ->
                if (ev.roomId != roomId) return@collect
                _state.update { st ->
                    val audience =
                        if (st.audience.any { u -> u.id == ev.user.id }) st.audience
                        else st.audience + ev.user
                    // Announcing us to ourselves would be a banner that says
                    // "you are here" every time we reconnect.
                    val banner = if (ev.user.id == st.user?.id) st.entryBanner else ev
                    st.copy(audience = audience, entryBanner = banner)
                }
            }
        }
        viewModelScope.launch {
            socket.userLeft.collect { ev ->
                if (ev.roomId != roomId) return@collect
                _state.update {
                    it.copy(
                        audience = it.audience.filterNot { u -> u.id == ev.userId },
                        handRaises = it.handRaises.filterNot { u -> u.id == ev.userId },
                        entryBanner = it.entryBanner.takeUnless { b -> b?.user?.id == ev.userId },
                    )
                }
            }
        }
        viewModelScope.launch {
            socket.handRaises.collect { ev ->
                if (ev.roomId != roomId) return@collect
                _state.update {
                    val without = it.handRaises.filterNot { u -> u.id == ev.user.id }
                    it.copy(handRaises = if (ev.raised) without + ev.user else without)
                }
            }
        }
        viewModelScope.launch {
            socket.micToggles.collect { ev ->
                if (ev.roomId != roomId) return@collect
                _state.update {
                    it.copy(
                        seats = it.seats.map { seat ->
                            if (seat.seatIndex == ev.seatIndex) seat.copy(isMuted = ev.muted) else seat
                        }
                    )
                }
            }
        }
        viewModelScope.launch {
            socket.giftAnimated.collect { ev ->
                if (ev.roomId != roomId) return@collect
                // A rose should not blind the room and a castle should not be a
                // footnote: the tier is on the gift row, not guessed from the art.
                _state.update { st ->
                    if (ev.gift.isTakeover) {
                        st.copy(giftQueue = RoomEffects.enqueueTakeover(st.giftQueue, ev, st.user?.id))
                    } else {
                        st.copy(giftTicker = RoomEffects.appendTicker(st.giftTicker, ev))
                    }
                }
            }
        }
        viewModelScope.launch {
            socket.likes.collect { ev ->
                if (ev.roomId != roomId) return@collect
                // One batched event can carry twelve taps; it reads as a puff of
                // hearts, and the number shown is the server's running total.
                _state.update {
                    it.copy(
                        likeTotal = ev.total,
                        hearts = HeartSignal(RoomEffects.HEARTS_PER_EVENT, it.hearts.token + 1),
                    )
                }
            }
        }
        viewModelScope.launch {
            socket.roomClosed.collect { ev ->
                if (ev.roomId != roomId) return@collect
                _state.update { it.copy(roomClosed = true) }
            }
        }
        viewModelScope.launch {
            socket.themeChanges.collect { ev ->
                if (ev.roomId != roomId) return@collect
                _state.update { state ->
                    val room = state.room ?: return@update state
                    // The server names the wallpaper with the slug. An older broadcast carried only
                    // the slug, so the wallpaper already on screen is kept rather than blanked.
                    state.copy(room = room.copy(theme = ev.theme, themeWallpaper = ev.wallpaper ?: room.themeWallpaper))
                }
            }
        }
        viewModelScope.launch {
            socket.profileUpdates.collect { ev ->
                if (ev.roomId != roomId) return@collect
                // The server sends the profile as it now stands, so an empty rule line arrives as
                // null and clears what was on screen.
                _state.update {
                    it.copy(
                        room = it.room?.copy(
                            title = ev.title,
                            description = ev.description,
                            category = ev.category,
                            language = ev.language,
                            region = ev.region,
                            rules = ev.rules,
                        ),
                    )
                }
            }
        }
        viewModelScope.launch {
            socket.kickedFrom.collect { kickedRoomId ->
                if (kickedRoomId != roomId) return@collect
                _state.update { it.copy(kicked = true) }
            }
        }
        viewModelScope.launch {
            socket.hostWarnings.collect { ev ->
                if (ev.roomId != roomId) return@collect
                _state.update { it.copy(operatorWarning = ev.message) }
            }
        }
    }

    private fun observeLiveKit() {
        viewModelScope.launch {
            liveKit.connectionState.collect { st ->
                _state.update { it.copy(livekitState = st) }
            }
        }
        viewModelScope.launch {
            liveKit.speakingLevels.collect { levels ->
                _state.update { it.copy(speakingLevels = levels) }
            }
        }
    }

    /** Full-seat snapshot: update list, recompute own seat + publish rights. */
    private fun applySeats(seats: List<Seat>, audience: List<MiniUser>?) {
        val userId = _state.value.user?.id
        val mySeat = seats.firstOrNull { it.occupiedBy(userId) }
        val canPublish = mySeat?.isSpeaker == true && mySeat.status == SeatStatus.OCCUPIED
        // Seating someone closes their hand-raise request server-side.
        val seatedIds = seats.mapNotNull { it.user?.id }.toSet()
        _state.update {
            it.copy(
                seats = seats,
                audience = audience ?: it.audience,
                mySeatIndex = mySeat?.seatIndex,
                canPublish = canPublish,
                micMuted = mySeat?.isMuted ?: it.micMuted,
                handRaises = it.handRaises.filterNot { u -> u.id in seatedIds },
            )
        }
        // Rights-only change: never reconnect the LiveKit room here.
        liveKit.updatePublishRights(canPublish)
    }

    // ---- Seat interactions ---------------------------------------------------------

    fun onSeatTapped(seat: Seat) {
        val snapshot = _state.value
        when {
            // My own seat: step down back to audience.
            seat.occupiedBy(snapshot.user?.id) -> leaveSeat(seat.seatIndex)

            seat.status == SeatStatus.LOCKED -> {
                // Only the host gets the controls sheet on a locked seat.
                if (snapshot.isHost) _state.update { it.copy(hostControlsSeat = seat) }
            }

            seat.status == SeatStatus.EMPTY -> {
                // Host or audience: take the empty seat (audience "request"
                // goes through the same endpoint; the backend may gate it).
                takeSeat(seat.seatIndex)
            }

            // Someone else's occupied seat: hosts get controls, audience no-op.
            snapshot.isHost -> _state.update { it.copy(hostControlsSeat = seat) }
        }
    }

    fun takeSeat(seatIndex: Int) {
        viewModelScope.launch {
            when (val result = takeSeatUseCase(roomId, seatIndex)) {
                is ApiResult.Success -> applySeats(result.data, audience = null)
                is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
            }
        }
    }

    fun leaveSeat(seatIndex: Int) {
        viewModelScope.launch {
            when (val result = roomRepository.leaveSeat(roomId, seatIndex)) {
                is ApiResult.Success -> applySeats(result.data, audience = null)
                is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
            }
        }
    }

    // ---- Mic / hand -------------------------------------------------------------

    /**
     * Bottom-bar mic button. Self-mute is a pure LiveKit local action (soft
     * mute keeps the track); host-imposed mute arrives via seats and updates
     * [PartyRoomUiState.micMuted] separately.
     */
    fun toggleOwnMic() {
        val snapshot = _state.value
        if (!snapshot.canPublish) return
        val newMuted = !snapshot.micMuted
        _state.update { it.copy(micMuted = newMuted) }
        liveKit.setMicrophoneEnabled(!newMuted)
    }

    fun toggleRaiseHand() {
        val snapshot = _state.value
        if (snapshot.seated || snapshot.isHost) return
        val next = !snapshot.handRaised
        viewModelScope.launch {
            // REST is authoritative; socket emit mirrors it for the host queue.
            roomRepository.raiseHand(roomId, next)
            socket.raiseHand(roomId, next)
            _state.update { it.copy(handRaised = next) }
        }
    }

    // ---- Host controls -------------------------------------------------------------

    fun dismissHostControls() = _state.update { it.copy(hostControlsSeat = null) }

    fun openAudienceList() = _state.update { it.copy(audienceSheetVisible = true) }

    fun closeAudienceList() = _state.update { it.copy(audienceSheetVisible = false) }

    fun hostToggleLock(seat: Seat, locked: Boolean) {
        viewModelScope.launch {
            val result = roomRepository.lockSeat(roomId, seat.seatIndex, locked)
            when (result) {
                is ApiResult.Success -> applySeats(result.data, audience = null)
                is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
            }
        }
    }

    fun hostToggleMute(seat: Seat, muted: Boolean) {
        viewModelScope.launch {
            val result = toggleMuteUseCase(roomId, seat.seatIndex, muted)
            when (result) {
                is ApiResult.Success -> applySeats(result.data, audience = null)
                is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
            }
        }
    }

    fun hostKick(seat: Seat) {
        viewModelScope.launch {
            val result = roomRepository.kickFromSeat(roomId, seat.seatIndex)
            when (result) {
                is ApiResult.Success -> applySeats(result.data, audience = null)
                is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
            }
        }
    }

    fun hostCloseRoom() {
        viewModelScope.launch {
            roomRepository.closeRoom(roomId)
            _state.update { it.copy(roomClosed = true) }
        }
    }

    // ---- Chat ------------------------------------------------------------------------

    fun sendChat(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        socket.sendChat(roomId, trimmed)
        // Server echoes room:chat_message back to us; nothing optimistic here.
    }

    // ---- Gift dialog -------------------------------------------------------------------

    fun openGiftDialog() {
        viewModelScope.launch {
            if (_state.value.giftCatalog.isEmpty()) {
                when (val result = ServiceLocator.giftRepository.getGifts()) {
                    is ApiResult.Success -> _state.update {
                        it.copy(
                            giftCatalog = result.data,
                            giftDialogVisible = true,
                            selectedGift = result.data.firstOrNull(),
                            giftError = null,
                        )
                    }
                    is ApiResult.Failure -> _state.update {
                        it.copy(error = result.message, giftDialogVisible = true, giftError = result.message)
                    }
                }
            } else {
                _state.update {
                    it.copy(
                        giftDialogVisible = true,
                        giftError = null,
                        selectedGift = it.selectedGift ?: it.giftCatalog.firstOrNull(),
                    )
                }
            }
            // Default target: host seat (seat 0) if seated, else host user id.
            _state.update { st ->
                val hostSeat = st.seats.firstOrNull { it.seatIndex == 0 }?.user
                val receiver = hostSeat?.id ?: st.room?.host?.id
                st.copy(selectedReceiverId = st.selectedReceiverId ?: receiver)
            }
        }
    }

    fun closeGiftDialog() = _state.update {
        it.copy(giftDialogVisible = false, giftQuantity = 1, giftError = null)
    }

    fun selectGift(gift: Gift) = _state.update {
        it.copy(selectedGift = gift, giftError = null)
    }

    /**
     * Panel tile tap. The first tap on a gift selects it, the second one on the
     * same tile sends it — one gesture to browse, two to spend, and no way to buy
     * by accident while scrolling the catalogue.
     */
    fun tapGiftTile(gift: Gift) {
        if (_state.value.selectedGift?.id == gift.id) sendSelectedGift() else selectGift(gift)
    }

    /** Null selects the "All" tab. */
    fun setGiftCategory(category: String?) = _state.update { it.copy(giftCategory = category) }

    fun selectReceiver(userId: String) = _state.update { it.copy(selectedReceiverId = userId) }

    fun setGiftQuantity(quantity: Int) {
        val snapshot = _state.value
        val gift = snapshot.selectedGift ?: return
        val maxByBalance = if (gift.diamondPrice > 0) {
            ((snapshot.user?.diamondBalance ?: 0) / gift.diamondPrice).coerceAtLeast(1)
        } else {
            MAX_GIFT_QUANTITY
        }
        _state.update { it.copy(giftQuantity = quantity.coerceIn(1, minOf(MAX_GIFT_QUANTITY, maxByBalance))) }
    }

    fun sendSelectedGift() {
        val snapshot = _state.value
        val gift = snapshot.selectedGift
        val receiverId = snapshot.selectedReceiverId
        if (gift == null || receiverId == null) {
            _state.update { it.copy(giftError = "Pick a gift and a receiver") }
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(giftSending = true, giftError = null) }
            val result = sendGiftUseCase(
                roomId = roomId,
                receiverId = receiverId,
                gift = gift,
                quantity = snapshot.giftQuantity,
                senderDiamondBalance = snapshot.user?.diamondBalance,
            )
            when (result) {
                is ApiResult.Success -> {
                    closeGiftDialogSilently()
                    _state.update { it.copy(giftSending = false) }
                    authRepository.refreshMe()
                    // The backend broadcasts room:gift_animated; if the socket
                    // echo is slow the queue still fills via the event. We do
                    // not duplicate the effect optimistically here.
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(giftSending = false, giftError = result.message)
                }
            }
        }
    }

    private fun closeGiftDialogSilently() = _state.update {
        it.copy(giftDialogVisible = false, giftQuantity = 1)
    }

    /** Called by the overlay when one animation finished: pop the queue head. */
    fun onGiftEffectFinished(event: GiftAnimatedEvent) {
        _state.update { it.copy(giftQueue = it.giftQueue.filterNot { e -> e === event }) }
    }

    /** Called by a ticker row when its slot expires. */
    fun onTickerFinished(event: GiftAnimatedEvent) {
        _state.update { it.copy(giftTicker = it.giftTicker.filterNot { e -> e === event }) }
    }

    /** Called by the entry banner after it has been on screen long enough. */
    fun clearEntryBanner() = _state.update { it.copy(entryBanner = null) }

    // ---- Ranking sheet -------------------------------------------------------------

    fun openRanking() {
        // The gift sheet is an AlertDialog, which lives in its own window: the
        // ranking bottom sheet would not reliably stack above it, so opening one
        // closes the other.
        _state.update { it.copy(rankingVisible = true, giftDialogVisible = false) }
        loadRanking()
    }

    fun closeRanking() = _state.update { it.copy(rankingVisible = false) }

    fun setRankingWindow(window: String) {
        if (window == _state.value.rankingWindow) return
        _state.update { it.copy(rankingWindow = window) }
        loadRanking()
    }

    fun setRankingBoard(board: RankBoard) {
        if (board == _state.value.rankingBoard) return
        _state.update { it.copy(rankingBoard = board) }
        loadRanking()
    }

    /** The server ranks from the ledger, so the sheet always shows what it returns. */
    private fun loadRanking() {
        val snapshot = _state.value
        viewModelScope.launch {
            _state.update { it.copy(rankingLoading = true, rankingError = null) }
            when (val result = ServiceLocator.giftRepository
                .getLeaderboard(snapshot.rankingWindow, snapshot.rankingBoard)) {
                is ApiResult.Success -> _state.update { it.copy(ranking = result.data, rankingLoading = false) }
                is ApiResult.Failure -> _state.update {
                    it.copy(rankingLoading = false, rankingError = result.message)
                }
            }
        }
    }

    // ---- Likes --------------------------------------------------------------------

    /** Taps counted locally since the last `room:like`; flushed per window. */
    private var pendingLikes = 0
    private var likeFlush: Job? = null

    /**
     * The heart button. A tap animates locally and joins the running count; the
     * count is reported once per [RoomEffects.LIKE_FLUSH_MS] window, so a hundred
     * fast taps are one event on the wire. The total the room displays is the
     * server's, which is the only number that can be trusted.
     */
    fun onLikeTapped() {
        _state.update { it.copy(hearts = HeartSignal(1, it.hearts.token + 1)) }
        pendingLikes += 1
        if (pendingLikes >= RoomEffects.LIKE_MAX_REPORT) {
            flushLikes()
            return
        }
        if (likeFlush?.isActive != true) {
            likeFlush = viewModelScope.launch {
                delay(RoomEffects.LIKE_FLUSH_MS)
                flushLikes()
            }
        }
    }

    private fun flushLikes() {
        likeFlush?.cancel()
        likeFlush = null
        val count = pendingLikes.coerceAtMost(RoomEffects.LIKE_MAX_REPORT)
        pendingLikes = 0
        if (count > 0) socket.sendLike(roomId, count)
    }

    // ---- Exit -------------------------------------------------------------------------

    fun leaveRoom() {
        // An unreported handful of taps is not worth a `room:like` aimed at a room
        // we are no longer in.
        likeFlush?.cancel()
        likeFlush = null
        pendingLikes = 0
        socket.leaveRoom(roomId)
        viewModelScope.launch {
            runCatching { roomRepository.leaveRoom(roomId) }
        }
        liveKit.disconnect()
    }

    fun dismissWarning() {
        _state.update { it.copy(operatorWarning = null) }
    }

    fun clearError() = _state.update { it.copy(error = null) }

    override fun onCleared() {
        super.onCleared()
        // Defensive: if the user navigated away without the leave button.
        liveKit.disconnect()
        Log.d(TAG, "PartyRoomViewModel cleared for $roomId")
    }

    companion object {
        private const val TAG = "PartyRoomVM"
        const val MAX_CHAT = 120
        const val HISTORY_CHAT_LIMIT = 60
        const val MAX_GIFT_QUANTITY = 99
    }
}
