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
import com.voiza.app.domain.model.GiftCategoryOption
import com.voiza.app.domain.model.giftCategoryTabs
import com.voiza.app.domain.model.HeartSignal
import com.voiza.app.domain.model.Leaderboard
import com.voiza.app.domain.model.LiveKitCredentials
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.MessageType
import com.voiza.app.domain.model.PkBattle
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.ReactionSignal
import com.voiza.app.domain.model.Relationship
import com.voiza.app.domain.model.ReportReason
import com.voiza.app.domain.model.Room
import com.voiza.app.domain.model.RoomReactionEvent
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatStatus
import com.voiza.app.domain.model.SeatTakeResult
import com.voiza.app.domain.model.SpeakerRequest
import com.voiza.app.domain.model.User
import com.voiza.app.domain.model.UserJoinedEvent
import com.voiza.app.domain.repository.AuthRepository
import com.voiza.app.domain.repository.PkRepository
import com.voiza.app.domain.repository.RoomRepository
import com.voiza.app.domain.repository.SocialRepository
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
import java.util.UUID

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
    private val pkRepository: PkRepository = ServiceLocator.pkRepository,
    private val socialRepository: SocialRepository = ServiceLocator.socialRepository,
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

        /**
         * The PK battle this room is in — invited or running — as the server last sent it.
         * Null when the room is free; the banner is the only thing that reads it.
         */
        val battle: PkBattle? = null,

        /** Audience members waiting in the request-to-speak queue. */
        val handRaises: List<MiniUser> = emptyList(),

        /**
         * The host's speaker queue as the server last read it, oldest request first. Only the host
         * can ask for it — a member who calls the endpoint gets 403 — so this stays empty on every
         * other screen and the queue is not something a phone can invent.
         */
        val speakerQueue: List<SpeakerRequest> = emptyList(),
        val audienceSheetVisible: Boolean = false,

        /**
         * The member whose card is open — follow, report, block — or null when nothing is showing.
         * [MemberCard.relationship] is what the server said about them at the moment the card was
         * opened, so the rows offer the edge that exists instead of one this screen guessed.
         */
        val memberSheet: MemberCard? = null,

        /**
         * One line the room should say out loud — an invitation accepted, a request answered. Null
         * shows nothing, and it is never an error: these are things that happened, not failures.
         */
        val roomNotice: String? = null,

        /** Host's pinned-notice composer. */
        val announcementEditorVisible: Boolean = false,

        /**
         * The seat a host just pulled us onto, while their invitation waits for an answer. The
         * server seats on invite, so this is not a pending offer — it is the member's chance to say
         * no before their own microphone starts, and while it is set the mic stays unpublished.
         */
        val invitedToSeat: Int? = null,

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
         * The paid flourish somebody else's entry asked the room to play, straight from the
         * server's `room:user_joined` payload. Null when they own none, in which case their
         * banner still announces them and the room's free welcome is untouched.
         */
        val entryFlourish: String? = null,

        /**
         * Whose paid entrance cinematic the room is playing, straight from that member's
         * `room:user_joined` payload. Null when nobody wearing a ride arrived, and never invented
         * for the member who owns none: their banner says it, and they walk in quietly.
         */
        val entryRide: UserJoinedEvent? = null,

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

        /**
         * The next quick reaction for [com.voiza.app.ui.screens.room.ReactionLayer] to fly. Holds the
         * art rather than a key because an inbound `room:reaction` names the server's emoji, not ours
         * — what plays is whatever the operator had published when that tap was resolved.
         */
        val reactions: ReactionSignal = ReactionSignal(null, 0),

        val hostControlsSeat: Seat? = null,

        // Gift dialog state (catalogue + selection) — lives here so it
        // survives recomposition of the dialog composable.
        val giftCatalog: List<Gift> = emptyList(),
        /**
         * The operator-managed shelves straight from `GET /api/gifts`, in server order. Empty when
         * the response carried no `categories` array — an older server or a partial payload — which
         * is what makes [giftCategories] fall back to the catalogue's own strings.
         */
        val giftShelves: List<GiftCategoryOption> = emptyList(),
        val giftDialogVisible: Boolean = false,
        /**
         * Selected catalogue tab, held as the shelf *key* (the string a gift's `category` matches),
         * never the display label. Null means "all categories".
         */
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

        /**
         * The seat a host hands out next: the lowest one that is free, seat 0 excluded because the
         * server refuses to give the host seat away. Null when the room is full or every remaining
         * seat is locked, which is when the app offers no invitation instead of a doomed call.
         */
        val invitableSeatIndex: Int?
            get() = seats.firstOrNull { seat ->
                seat.seatIndex != 0 && seat.status == SeatStatus.EMPTY
            }?.seatIndex

        /**
         * The tab strip. Server shelves (in server order) that the loaded catalogue actually fills;
         * when none shipped, the pre-shelf fallback of one tab per distinct category string. See
         * [com.voiza.app.domain.model.giftCategoryTabs].
         */
        val giftCategories: List<GiftCategoryOption>
            get() = giftCategoryTabs(giftShelves, giftCatalog)

        val visibleGifts: List<Gift>
            get() = if (giftCategory == null) giftCatalog
            else giftCatalog.filter { it.category == giftCategory }
    }

    /**
     * One member's card, open.
     *
     * [relationship] is null until the server answers for it, and the card draws nothing but a
     * waiting line until then: follow, report and block are edges only the backend knows the state
     * of, so a card that assumed "not following" could offer to undo an edge that was never there.
     */
    data class MemberCard(
        val member: MiniUser,
        val relationship: Relationship? = null,
        val busy: Boolean = false,
        val error: String? = null,
        val reportOpen: Boolean = false,
    )

    private val _state = MutableStateFlow(PartyRoomUiState())
    val state: StateFlow<PartyRoomUiState> = _state.asStateFlow()

    /** The shared socket's own liveness, passed straight through for the header pip to show. */
    val socketConnected: StateFlow<Boolean> = socket.isConnected

    private var credentials: LiveKitCredentials? = null
    private var pendingPassword: String? = null

    /**
     * The gifts this device has already put on screen, by ledger transaction id.
     *
     * A paid gift can reach a room twice: once on the live `room:gift_animated` broadcast and once
     * in the tail `room:gift_history` hands to a socket that just joined, when the send lands
     * around the join. The id is what both carry, and it is the only thing that says "same gift".
     * Bounded because a room open for a week must not remember every animation it ever showed.
     */
    private val deliveredGiftIds = LinkedHashSet<String>()

    /**
     * The idempotency key of the Send tap whose outcome is still unknown.
     *
     * It survives a failure that had no HTTP response — the request went out and the answer did
     * not come back — so the next tap of the same intent resends that key and the server returns
     * the gift it already sold instead of selling a second one. A tap the server *refused* is not
     * unresolved: it was never bought, so the next tap rightly gets a fresh key.
     */
    private var unresolvedGiftKey: String? = null

    init {
        join()
        observeSocket()
        observeLiveKit()
        observeSocketRecovery()
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

    /**
     * A reconnect is a brand-new server-side socket, and the server drops a member's presence when
     * LiveKit reports them gone — which is exactly what a real network blip does. So the socket's
     * own re-join can be refused for a room the user never left, and only a REST join can re-claim
     * it. Silent by design: the party stays on screen while the presence is re-taken, and a failure
     * leaves the next reconnect to try again rather than blaming the user for a dropped wifi.
     */
    private fun observeSocketRecovery() {
        viewModelScope.launch {
            var wasConnected = socket.isConnected.value
            socket.isConnected.collect { connected ->
                val reconnected = connected && !wasConnected && _state.value.joined
                wasConnected = connected
                if (reconnected) reclaimPresence()
            }
        }
    }

    private suspend fun reclaimPresence() {
        when (val result = joinRoomUseCase(roomId, pendingPassword)) {
            is ApiResult.Success -> {
                val room = result.data.room
                val userId = _state.value.user?.id
                val mySeat = result.data.seats.firstOrNull { it.occupiedBy(userId) }
                credentials = result.data.livekit
                _state.update {
                    it.copy(
                        room = room,
                        seats = result.data.seats,
                        audience = result.data.audience,
                        listenerCount = room.listenerCount,
                        likeTotal = room.likeCount,
                        mySeatIndex = mySeat?.seatIndex,
                        canPublish = mySeat?.isSpeaker == true && mySeat.status == SeatStatus.OCCUPIED,
                        micMuted = mySeat?.isMuted ?: it.micMuted,
                    )
                }
                // LiveKit keeps its own session and reconnects on its own; only the publish rights
                // may have moved with the seat.
                liveKit.updatePublishRights(it_publishCan(result.data.livekit, mySeat))
            }
            is ApiResult.Failure -> Log.w(TAG, "Presence reclaim failed: ${result.message}")
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
        // The speaker queue is host-only: a member who asks for it gets 403, so this is deliberately
        // after the update above, which is what says who is hosting.
        if (userId != null && userId == room.host.id) {
            viewModelScope.launch { loadSpeakerQueue() }
        }
        // The entry flourish is the operator's choice, so it is read once per visit.
        viewModelScope.launch { loadWelcomeEffect() }
        // Same for the chat emoji: a catalogue of rows, not a list this file may hardcode.
        viewModelScope.launch { loadEmojiCatalogue() }
        // A battle may already be pending or running; the banner needs it without waiting for a gift.
        viewModelScope.launch { loadBattle() }
        val lkUrl = lk.url.ifBlank { BuildConfig.VOIZA_LIVEKIT_URL }
        liveKit.connect(lkUrl, lk.token, lk.roomName, it_publishCan(lk, mySeat))
    }

    /**
     * Whether this client may put a microphone on the room. The seat and the server's token decide
     * that, except while a seat invitation sits unanswered: an invitation the member has not agreed
     * to is not consent to broadcast, and this holds the mic back on every path that could publish
     * (connect, seat change, presence reclaim).
     */
    private fun it_publishCan(lk: LiveKitCredentials, mySeat: Seat?): Boolean =
        (lk.canPublish || mySeat?.isSpeaker == true) && _state.value.invitedToSeat == null

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
                    // Re-reading the room should not forget that we already asked: our own name in
                    // the queue is the server's answer to whether the button says "Requested".
                    handRaised = it.handRaised || detail.data.handRaises.any { u -> u.id == it.user?.id },
                )
            }
        }
    }

    /**
     * The host's speaker queue, read from the server rather than assembled from the events we
     * happened to catch. A reconnect can drop an emit, and a queue that quietly loses a member's
     * request is worse than one that loads a frame late.
     */
    private suspend fun loadSpeakerQueue() {
        val result = roomRepository.speakerRequests(roomId)
        if (result is ApiResult.Success) {
            _state.update { it.copy(speakerQueue = result.data) }
        }
    }

    /**
     * The battle this room is in, or null. A failure is silent: the banner simply is not shown,
     * and the room keeps working — a PK race is an addition to the party, not a gate on it.
     */
    private suspend fun loadBattle() {
        val result = pkRepository.battleForRoom(roomId)
        if (result is ApiResult.Success) {
            _state.update { it.copy(battle = result.data) }
        }
    }

    /** Re-read the battle after returning from the PK desk, where it may have just started. */
    fun refreshBattle() {
        viewModelScope.launch { loadBattle() }
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
                    val mine = ev.user.id == st.user?.id
                    val banner = if (mine) st.entryBanner else ev
                    // The paid flourish is the server's URL on this join; our own entry already
                    // played the room's welcome above, so it is never replayed here.
                    val flourish = if (mine) st.entryFlourish else ev.user.entryEffect ?: st.entryFlourish
                    // A ride belongs to the arrival, not to the person watching, so ours is never
                    // replayed here for the same reason our banner is not.
                    val ride = if (mine) st.entryRide else ev.user.entryRide?.let { ev } ?: st.entryRide
                    st.copy(
                        audience = audience,
                        entryBanner = banner,
                        entryFlourish = flourish,
                        entryRide = ride,
                    )
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
                if (!claimGiftEvent(ev)) return@collect
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
            socket.giftCatchUp.collect { events ->
                // The gifts this room paid for while our socket was down. They already happened,
                // so they join the ticker column — the part of the effect layer that reads as a
                // list of recent sends — instead of taking over the screen a member is watching.
                // Oldest first, because a column that scrolled newest-to-oldest would re-sort the
                // room's history upside down.
                events.asReversed().forEach { ev ->
                    if (ev.roomId == roomId && claimGiftEvent(ev)) {
                        _state.update { it.copy(giftTicker = RoomEffects.appendTicker(it.giftTicker, ev)) }
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
            socket.reactions.collect { ev -> onInboundReaction(ev) }
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
                _state.update { st ->
                    val room = st.room ?: return@update st
                    st.copy(
                        room = room.copy(
                            title = ev.title,
                            description = ev.description,
                            category = ev.category,
                            language = ev.language,
                            region = ev.region,
                            rules = ev.rules,
                            // The notice and the approval switch are the exception: a broadcast from
                            // an older server omits them, and "omitted" must not read as "cleared".
                            // A current server still sends both, and the notice has its own event.
                            announcement = ev.announcement ?: room.announcement,
                            announcementUpdatedAt = ev.announcementUpdatedAt ?: room.announcementUpdatedAt,
                            speakerApprovalRequired = ev.speakerApprovalRequired ?: room.speakerApprovalRequired,
                        ),
                    )
                }
            }
        }
        viewModelScope.launch {
            socket.announcements.collect { ev ->
                if (ev.roomId != roomId) return@collect
                // A null notice here is the host clearing it, which is why this event exists apart
                // from the profile broadcast. An operator pinning from the admin panel arrives the
                // same way, and the phone shows what the server decided without re-reading the room.
                _state.update {
                    it.copy(
                        room = it.room?.copy(
                            announcement = ev.announcement,
                            announcementUpdatedAt = ev.updatedAt,
                        ),
                    )
                }
            }
        }
        viewModelScope.launch {
            socket.seatInvites.collect { ev ->
                if (ev.roomId != roomId) return@collect
                // The server seats on invite, so this is not an offer that can be held open: what is
                // still ours to decide is whether our own microphone goes on. The prompt answers that,
                // and until it does the mic stays unpublished. The publisher token we would reconnect
                // with is the one the seat was minted with, so keep it either way.
                ev.livekit?.let { credentials = it }
                _state.update {
                    it.copy(
                        invitedToSeat = ev.seatIndex,
                        micMuted = true,
                        handRaised = false,
                        speakerQueue = it.speakerQueue.filterNot { r -> r.user?.id == it.user?.id },
                    )
                }
                liveKit.setMicrophoneEnabled(false)
            }
        }
        viewModelScope.launch {
            socket.speakerDecisions.collect { ev ->
                if (ev.roomId != roomId) return@collect
                ev.livekit?.let { credentials = it }
                _state.update {
                    it.copy(
                        handRaised = false,
                        roomNotice = if (ev.approved) {
                            "The host made you a speaker"
                        } else {
                            "The host declined your request"
                        },
                    )
                }
            }
        }
        viewModelScope.launch {
            socket.speakerQueueChanges.collect { changedRoomId ->
                // Both halves of the queue's life — a request filed, a request answered — are one
                // instruction for us: the list on screen is now the server's problem again.
                if (changedRoomId != roomId || !_state.value.isHost) return@collect
                loadSpeakerQueue()
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
        viewModelScope.launch {
            socket.pkStates.collect { battle ->
                if (battle.roomA.id != roomId && battle.roomB.id != roomId) return@collect
                _state.update { it.copy(battle = battle) }
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
        // An unanswered seat invitation holds the microphone back: the server grants the seat and the
        // right to publish in one step, so until the member answers, this client publishes nothing.
        val awaitingInvite = _state.value.invitedToSeat != null
        val canPublish =
            mySeat?.isSpeaker == true && mySeat.status == SeatStatus.OCCUPIED && !awaitingInvite
        // Seating someone closes their hand-raise request server-side.
        val seatedIds = seats.mapNotNull { it.user?.id }.toSet()
        _state.update {
            it.copy(
                seats = seats,
                audience = audience ?: it.audience,
                mySeatIndex = mySeat?.seatIndex,
                canPublish = canPublish,
                micMuted = if (awaitingInvite) true else (mySeat?.isMuted ?: it.micMuted),
                handRaises = it.handRaises.filterNot { u -> u.id in seatedIds },
                // Same reasoning as the hand raises above, for the approval queue: a request for a
                // seat that is now occupied is answered, whatever the host used to answer it.
                speakerQueue = it.speakerQueue.filterNot { r -> r.user?.id in seatedIds },
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
                is ApiResult.Success -> when (val outcome = result.data) {
                    is SeatTakeResult.Seated -> {
                        // The server mints the publisher token with the seat, so the token that a
                        // later reconnect dials with is this one, not the audience-scoped copy from
                        // the join.
                        outcome.livekit?.let { credentials = it }
                        applySeats(outcome.seats, audience = null)
                    }
                    // Approval is on: nobody was seated and no token was issued. The queue now holds
                    // us, and the host's screen is where the request goes next.
                    is SeatTakeResult.Queued -> _state.update {
                        it.copy(handRaised = true, roomNotice = "Your request is with the host")
                    }
                }
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

    /**
     * "Raise hand" for the audience. Which endpoint that is depends on the host's switch, not on
     * this client: a room that gates the microphone turns the tap into a request the host answers
     * (`POST /seat`, which answers 202), and one that does not keeps the old signal that only marks
     * us as waiting. Same button, two server-side meanings, and the server decides which one applies.
     */
    fun toggleRaiseHand() {
        val snapshot = _state.value
        if (snapshot.seated || snapshot.isHost) return
        val next = !snapshot.handRaised
        if (snapshot.room?.speakerApprovalRequired == true) {
            if (next) {
                val seatIndex = snapshot.invitableSeatIndex
                // No free seat is a real answer, not a failure to hide: asking to speak from a room
                // with every seat taken or locked has nothing to file against.
                if (seatIndex == null) {
                    _state.update { it.copy(error = "Every speaker seat is taken") }
                } else {
                    takeSeat(seatIndex)
                }
            } else {
                viewModelScope.launch {
                    when (val result = roomRepository.cancelSpeakerRequest(roomId)) {
                        is ApiResult.Success -> _state.update {
                            it.copy(handRaised = false, roomNotice = "You withdrew your request")
                        }
                        is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
                    }
                }
            }
            return
        }
        viewModelScope.launch {
            // REST is authoritative; socket emit mirrors it for the host queue.
            roomRepository.raiseHand(roomId, next)
            socket.raiseHand(roomId, next)
            _state.update { it.copy(handRaised = next) }
        }
    }

    // ---- Host controls -------------------------------------------------------------

    fun dismissHostControls() = _state.update { it.copy(hostControlsSeat = null) }

    /**
     * Seat a listener on the mic without waiting for them to ask. The server does the seating, so
     * this call only reports what it decided; the invited member learns about it on their own
     * private `room:seat_invited`, never from anything said here.
     */
    fun inviteListener(userId: String) {
        val seatIndex = _state.value.invitableSeatIndex
        if (seatIndex == null) {
            _state.update { it.copy(error = "Every speaker seat is taken") }
            return
        }
        viewModelScope.launch {
            when (val result = roomRepository.inviteToSeat(roomId, seatIndex, userId)) {
                // A seated speaker also closes any request they had in the queue, and the server's
                // seat list is what says so — this just paints it.
                is ApiResult.Success -> applySeats(result.data, audience = null)
                is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
            }
        }
    }

    /**
     * Take the seat the host offered. The invitation already seated us — the server does the seating
     * — so accepting asks nothing and only puts our own microphone back on.
     */
    fun acceptSeatInvite() {
        if (_state.value.invitedToSeat == null) return
        _state.update { it.copy(invitedToSeat = null) }
        liveKit.setMicrophoneEnabled(true)
        // Re-derived from the seats we already hold, which is how the bar and the track get in step.
        applySeats(_state.value.seats, audience = null)
    }

    /** Hand the seat back. The server's next seat list is what says it is empty again. */
    fun declineSeatInvite() {
        val seatIndex = _state.value.invitedToSeat ?: return
        _state.update { it.copy(invitedToSeat = null) }
        leaveSeat(seatIndex)
    }

    /**
     * Answer one line of the queue. Approving seats the member at the seat they asked for; the
     * publisher token that goes with it is sent to them privately by the server, not through here.
     */
    fun approveSpeakerRequest(request: SpeakerRequest) {
        viewModelScope.launch {
            when (val result = roomRepository.approveSpeakerRequest(roomId, request.id)) {
                is ApiResult.Success -> applySeats(result.data, audience = null)
                is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
            }
        }
    }

    /**
     * Decline one line. The server has no seats to return for a rejection, so the queue is re-read
     * rather than edited — the `room:speaker_request_updated` broadcast will confirm it either way.
     */
    fun rejectSpeakerRequest(request: SpeakerRequest) {
        viewModelScope.launch {
            when (val result = roomRepository.rejectSpeakerRequest(roomId, request.id)) {
                is ApiResult.Success -> _state.update {
                    it.copy(speakerQueue = it.speakerQueue.filterNot { r -> r.id == request.id })
                }
                is ApiResult.Failure -> _state.update { it.copy(error = result.message) }
            }
        }
    }

    // ---- Pinned notice ---------------------------------------------------------------

    fun openAnnouncementEditor() = _state.update { it.copy(announcementEditorVisible = true) }

    fun closeAnnouncementEditor() = _state.update { it.copy(announcementEditorVisible = false) }

    /**
     * Pin one line above the seats, or clear it with an empty [text]. The answer is the room as the
     * server now has it, and the room's other members get the same words on their own
     * `room:announcement` — this client never decides what the notice says.
     */
    fun setAnnouncement(text: String) {
        viewModelScope.launch {
            when (val result = roomRepository.setAnnouncement(roomId, text)) {
                is ApiResult.Success -> _state.update {
                    it.copy(
                        room = result.data,
                        announcementEditorVisible = false,
                        roomNotice = if (result.data.announcement.isNullOrBlank()) {
                            "Pinned notice cleared"
                        } else {
                            "Pinned notice updated"
                        },
                    )
                }
                is ApiResult.Failure -> _state.update {
                    it.copy(announcementEditorVisible = false, error = result.message)
                }
            }
        }
    }

    fun dismissRoomNotice() = _state.update { it.copy(roomNotice = null) }

    fun openAudienceList() = _state.update { it.copy(audienceSheetVisible = true) }

    fun closeAudienceList() = _state.update { it.copy(audienceSheetVisible = false) }

    // ---- Member card: follow, report, block ------------------------------------

    /**
     * Open somebody else's card. The account has to be one this room already named — a seat, the
     * roster, the queue or a line of chat — because the phone holds no directory, and a card built
     * from a bare id would have nothing to draw.
     */
    fun openMemberSheet(userId: String) {
        if (userId == _state.value.user?.id) return
        val member = findMember(userId) ?: return
        _state.update { it.copy(memberSheet = MemberCard(member = member, busy = true)) }
        viewModelScope.launch {
            when (val result = socialRepository.relationship(userId)) {
                is ApiResult.Success -> updateCard { it.copy(relationship = result.data, busy = false) }
                is ApiResult.Failure -> updateCard { it.copy(busy = false, error = result.message) }
            }
        }
    }

    fun closeMemberSheet() = _state.update { it.copy(memberSheet = null) }

    fun openReportForm() = updateCard { it.copy(reportOpen = true, error = null) }

    fun closeReportForm() = updateCard { it.copy(reportOpen = false) }

    /**
     * Follow or unfollow, whichever the server said the edge is not. The answer is the new state of
     * that one edge, so the card takes it as given; a refusal — a blocked pair, an account that is
     * gone — leaves the row exactly where it was and says why.
     */
    fun toggleFollow() {
        val card = _state.value.memberSheet ?: return
        val following = card.relationship?.following == true
        updateCard { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val result = if (following) socialRepository.unfollow(card.member.id)
            else socialRepository.follow(card.member.id)
            when (result) {
                is ApiResult.Success -> {
                    updateCard { it.copy(busy = false, relationship = it.relationship?.copy(following = result.data)) }
                    _state.update {
                        it.copy(
                            roomNotice = if (result.data) "Following ${card.member.username}"
                            else "Unfollowed ${card.member.username}",
                        )
                    }
                }
                is ApiResult.Failure -> updateCard { it.copy(busy = false, error = result.message) }
            }
        }
    }

    /**
     * Block, or undo a block this member filed.
     *
     * A block closes the card: there is nothing left to offer somebody the interaction is shut
     * against, and the list of who is blocked is not this screen's to reconstruct. Undoing one
     * re-reads the relationship instead of assuming it, because the edge that stays — theirs, not
     * yours — is only ever something the server can say.
     */
    fun toggleBlock() {
        val card = _state.value.memberSheet ?: return
        val blockedByMe = card.relationship?.blockedByMe == true
        updateCard { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val result = if (blockedByMe) socialRepository.unblock(card.member.id)
            else socialRepository.block(card.member.id, reason = null)
            when (result) {
                is ApiResult.Success -> {
                    _state.update {
                        it.copy(
                            memberSheet = if (result.data) null else it.memberSheet?.copy(busy = false),
                            roomNotice = if (result.data) "Blocked ${card.member.username}"
                            else "Unblocked ${card.member.username}",
                        )
                    }
                    if (!result.data) {
                        when (val refresh = socialRepository.relationship(card.member.id)) {
                            is ApiResult.Success -> updateCard { it.copy(relationship = refresh.data) }
                            is ApiResult.Failure -> updateCard { it.copy(error = refresh.message) }
                        }
                    }
                }
                is ApiResult.Failure -> updateCard { it.copy(busy = false, error = result.message) }
            }
        }
    }

    /**
     * File a complaint. [details] is the reporter's own words and [reason] one of the six the
     * server accepts; the room is sent along so the queue can open where it happened. Nothing here
     * is a verdict — the report lands PENDING and only an operator moves it.
     */
    fun submitReport(reason: ReportReason, details: String) {
        val card = _state.value.memberSheet ?: return
        updateCard { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            val result = socialRepository.report(card.member.id, reason, details, roomId)
            when (result) {
                is ApiResult.Success -> _state.update {
                    it.copy(memberSheet = null, roomNotice = "Report sent to the team")
                }
                // The form stays open with the note intact: a refused reason is the reporter's to
                // change, and a lost paragraph is work nobody asked them to do twice.
                is ApiResult.Failure -> updateCard { it.copy(busy = false, error = result.message) }
            }
        }
    }

    /** The member behind an id, from wherever the room has already shown them. */
    private fun findMember(userId: String): MiniUser? {
        val snapshot = _state.value
        return snapshot.seats.firstOrNull { it.user?.id == userId }?.user
            ?: snapshot.audience.firstOrNull { it.id == userId }
            ?: snapshot.handRaises.firstOrNull { it.id == userId }
            ?: snapshot.speakerQueue.firstOrNull { it.user?.id == userId }?.user
            ?: snapshot.chat.lastOrNull { it.user?.id == userId }?.user
    }

    private inline fun updateCard(transform: (MemberCard) -> MemberCard) {
        _state.update { current ->
            val card = current.memberSheet ?: return@update current
            current.copy(memberSheet = transform(card))
        }
    }

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

    fun hostCloseRoom() {        viewModelScope.launch {
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
                            giftCatalog = result.data.gifts,
                            giftShelves = result.data.categories,
                            giftDialogVisible = true,
                            selectedGift = result.data.gifts.firstOrNull(),
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
            // One key per tap, held onto only while this tap's outcome is unknown. Two deliberate
            // taps therefore get two keys, which is right — and a tap whose response was lost gets
            // its key back, so the retry is answered with the gift that was already bought.
            val idempotencyKey = unresolvedGiftKey ?: UUID.randomUUID().toString().also { unresolvedGiftKey = it }
            val result = sendGiftUseCase(
                roomId = roomId,
                receiverId = receiverId,
                gift = gift,
                quantity = snapshot.giftQuantity,
                senderDiamondBalance = snapshot.user?.diamondBalance,
                idempotencyKey = idempotencyKey,
            )
            when (result) {
                is ApiResult.Success -> {
                    unresolvedGiftKey = null
                    _state.update { it.copy(giftSending = false) }
                    authRepository.refreshMe()
                    if (result.data.replayed) {
                        // The server answered the gift this key already bought, so nothing was
                        // charged again and the room already saw the animation. Say so instead of
                        // closing the dialog as if a second gift had gone out.
                        _state.update { it.copy(giftError = "That gift was already sent — it was not bought twice.") }
                    } else {
                        closeGiftDialogSilently()
                        // The backend broadcasts room:gift_animated; if the socket echo is slow the
                        // queue still fills via the event. We do not duplicate the effect here, and
                        // we do not touch the balance: `wallet:update` and refreshMe carry the
                        // server's numbers.
                    }
                }
                is ApiResult.Failure -> {
                    // A failure with no HTTP status is one the server may have answered and the
                    // network lost. Keep the key so a retry resolves against the same purchase; a
                    // refusal the server actually sent is settled, and the next tap is a new intent.
                    if (result.httpCode != null) unresolvedGiftKey = null
                    _state.update { it.copy(giftSending = false, giftError = result.message) }
                }
            }
        }
    }

    private fun closeGiftDialogSilently() = _state.update {
        it.copy(giftDialogVisible = false, giftQuantity = 1)
    }

    /**
     * Take ownership of a gift's on-screen debut. TRUE means nobody has shown it yet; an event
     * without an id is always taken, because guessing that two undated gifts are the same one is
     * how a room loses the animation somebody paid for.
     */
    private fun claimGiftEvent(event: GiftAnimatedEvent): Boolean {
        val key = event.eventId ?: return true
        if (!deliveredGiftIds.add(key)) return false
        if (deliveredGiftIds.size > GIFT_ID_MEMORY) {
            val oldest = deliveredGiftIds.iterator()
            oldest.next()
            oldest.remove()
        }
        return true
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

    /** Called when another member's paid entry flourish has finished playing. */
    fun clearEntryFlourish() = _state.update { it.copy(entryFlourish = null) }

    /** Called when an arrival ride has played, timed out or failed to load. */
    fun clearEntryRide() = _state.update { it.copy(entryRide = null) }

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

    // ---- Reactions --------------------------------------------------------------

    /** When this device last put a reaction on the wire; 0 means never. */
    private var lastReactionNanos = 0L

    /**
     * A quick reaction from the strip. The burst plays at once — a tap that waits on a round trip
     * feels dead, and being wrong about it costs nothing, since a reaction moves no money and stores
     * no row. The send is throttled to stay inside the server's own allowance, so a held thumb
     * cannot run into a rate limit and quietly lose reactions nobody knows were dropped.
     *
     * Our own echo is ignored: the room broadcast includes the sender, and a sprite that flew twice
     * on every tap is a burst that reads as nothing but noise.
     */
    fun sendReaction(emoji: EmojiOption) {
        _state.update { it.copy(reactions = ReactionSignal(emoji, it.reactions.token + 1)) }
        val now = System.nanoTime()
        if (lastReactionNanos != 0L && now - lastReactionNanos < RoomEffects.REACTION_TAP_MS * 1_000_000L) {
            return
        }
        lastReactionNanos = now
        socket.sendReaction(roomId, emoji.key)
    }

    private fun onInboundReaction(ev: RoomReactionEvent) {
        if (ev.roomId != roomId) return
        if (ev.userId == _state.value.user?.id) return
        _state.update { it.copy(reactions = ReactionSignal(ev.emoji, it.reactions.token + 1)) }
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
        // The socket is process-wide, so it is unsubscribed rather than closed: left subscribed,
        // it keeps parsing and re-broadcasting another screen's room events forever.
        socket.leaveRoom(roomId)
        Log.d(TAG, "PartyRoomViewModel cleared for $roomId")
    }

    companion object {
        private const val TAG = "PartyRoomVM"
        const val MAX_CHAT = 120
        const val HISTORY_CHAT_LIMIT = 60
        const val MAX_GIFT_QUANTITY = 99
        /**
         * How many gift ids this device remembers. The only duplicates worth guarding are the ones
         * a join's history page can still overlap with, and that page is twelve rows — this is the
         * room's own scroll of recent gifts, plus room to spare.
         */
        private const val GIFT_ID_MEMORY = 60
    }
}
