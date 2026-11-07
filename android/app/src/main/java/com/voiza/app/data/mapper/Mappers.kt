package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.BannerDto
import com.voiza.app.data.remote.dto.BannersResponse
import com.voiza.app.data.remote.dto.ChatMessageDto
import com.voiza.app.data.remote.dto.EmojiCatalogueDto
import com.voiza.app.data.remote.dto.FrameArtDto
import com.voiza.app.data.remote.dto.GiftBoxOutcomeDto
import com.voiza.app.data.remote.dto.GiftCategoryDto
import com.voiza.app.data.remote.dto.GiftDto
import com.voiza.app.data.remote.dto.GiftsResponse
import com.voiza.app.data.remote.dto.LeaderEntryDto
import com.voiza.app.data.remote.dto.LuckyPrizeDto
import com.voiza.app.data.remote.dto.LuckyRollDto
import com.voiza.app.data.remote.dto.LeaderboardResponse
import com.voiza.app.data.remote.dto.LiveKitTokenDto
import com.voiza.app.data.remote.dto.MiniUserDto
import com.voiza.app.data.remote.dto.OwnedStoreItemDto
import com.voiza.app.data.remote.dto.RankDto
import com.voiza.app.data.remote.dto.RelationshipDto
import com.voiza.app.data.remote.dto.RideArtDto
import com.voiza.app.data.remote.dto.RoomDto
import com.voiza.app.data.remote.dto.RoomGiftEventDto
import com.voiza.app.data.remote.dto.RoomSummaryDto
import com.voiza.app.data.remote.dto.RoomThemeDto
import com.voiza.app.data.remote.dto.SeatCapacityDto
import com.voiza.app.data.remote.dto.SeatDto
import com.voiza.app.data.remote.dto.SpeakerRequestDto
import com.voiza.app.data.remote.dto.SocketAnnouncementDto
import com.voiza.app.data.remote.dto.SocketChatDto
import com.voiza.app.data.remote.dto.SocketGiftAnimatedDto
import com.voiza.app.data.remote.dto.SocketGiftHistoryDto
import com.voiza.app.data.remote.dto.SocketHandRaiseDto
import com.voiza.app.data.remote.dto.SocketLikeDto
import com.voiza.app.data.remote.dto.SocketMicToggleDto
import com.voiza.app.data.remote.dto.SocketReactionDto
import com.voiza.app.data.remote.dto.SocketRoomProfileDto
import com.voiza.app.data.remote.dto.SocketSeatInvitedDto
import com.voiza.app.data.remote.dto.SocketSeatUpdateDto
import com.voiza.app.data.remote.dto.SocketSpeakerDecisionDto
import com.voiza.app.data.remote.dto.SocketUserJoinedDto
import com.voiza.app.data.remote.dto.StoreItemDto
import com.voiza.app.data.remote.dto.TakeSeatResponse
import com.voiza.app.data.remote.dto.StorePurchaseResponse
import com.voiza.app.data.remote.dto.StoreResponse
import com.voiza.app.data.remote.dto.ThemeCatalogueDto
import com.voiza.app.data.remote.dto.TransactionDto
import com.voiza.app.data.remote.dto.UserDto
import com.voiza.app.data.remote.dto.WalletResponse
import com.voiza.app.data.remote.dto.WithdrawalDto
import com.voiza.app.domain.model.DEFAULT_AMBIENT_EFFECT
import com.voiza.app.domain.model.DEFAULT_ROOM_THEME
import com.voiza.app.domain.model.FALLBACK_EMOJI_CODE_PATTERN
import com.voiza.app.domain.model.BannerFormat
import com.voiza.app.domain.model.BannerPlacement
import com.voiza.app.domain.model.BannerScreen
import com.voiza.app.domain.model.BannerTarget
import com.voiza.app.domain.model.ChatMessage
import com.voiza.app.domain.model.EmojiCatalogue
import com.voiza.app.domain.model.EmojiOption
import com.voiza.app.domain.model.EntryRide
import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.domain.model.GiftAnimationFormat
import com.voiza.app.domain.model.GiftBoxOutcome
import com.voiza.app.domain.model.GiftCatalogue
import com.voiza.app.domain.model.GiftCategoryOption
import com.voiza.app.domain.model.giftCategoryFallbackLabel
import com.voiza.app.domain.model.GiftEffectKind
import com.voiza.app.domain.model.HandRaiseEvent
import com.voiza.app.domain.model.Leaderboard
import com.voiza.app.domain.model.LiveKitCredentials
import com.voiza.app.domain.model.MicToggleEvent
import com.voiza.app.domain.model.LuckyPrize
import com.voiza.app.domain.model.LuckyRoll
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.MessageType
import com.voiza.app.domain.model.OwnedStoreItem
import com.voiza.app.domain.model.ProfileFrame
import com.voiza.app.domain.model.PromoBanner
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.RankRow
import com.voiza.app.domain.model.Relationship
import com.voiza.app.domain.model.Room
import com.voiza.app.domain.model.RoomCategory
import com.voiza.app.domain.model.RoomChatEvent
import com.voiza.app.domain.model.RoomLikeEvent
import com.voiza.app.domain.model.RoomProfileEvent
import com.voiza.app.domain.model.RoomReactionEvent
import com.voiza.app.domain.model.RoomAnnouncementEvent
import com.voiza.app.domain.model.RoomStatus
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.domain.model.RoomThemeOption
import com.voiza.app.domain.model.RoomType
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatPolicy
import com.voiza.app.domain.model.SeatInviteEvent
import com.voiza.app.domain.model.SeatStatus
import com.voiza.app.domain.model.SeatTakeResult
import com.voiza.app.domain.model.SpeakerDecisionEvent
import com.voiza.app.domain.model.SpeakerRequest
import com.voiza.app.domain.model.SpeakerRequestStatus
import com.voiza.app.domain.model.SeatUpdateEvent
import com.voiza.app.domain.model.StoreItem
import com.voiza.app.domain.model.StoreItemKind
import com.voiza.app.domain.model.StorePurchase
import com.voiza.app.domain.model.StoreSnapshot
import com.voiza.app.domain.model.ThemeCatalogue
import com.voiza.app.domain.model.Transaction
import com.voiza.app.domain.model.User
import com.voiza.app.domain.model.UserJoinedEvent
import com.voiza.app.domain.model.UserRank
import com.voiza.app.domain.model.WalletSnapshot

// ---------------------------------------------------------------------------
// DTO -> domain mapping. Unknown enum wire values degrade to safe defaults
// instead of throwing, so a backend enum addition cannot crash the client.
// ---------------------------------------------------------------------------

/**
 * The rung the server resolved for this member. A rung with no name is dropped rather than
 * invented: the labels are operator-edited text, so a fallback would put words in their mouth.
 */
fun RankDto?.toDomain(): UserRank? {
    val rung = this ?: return null
    val name = rung.name?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return UserRank(level = rung.level, name = name, badge = rung.badge, accent = rung.accent)
}

fun MiniUserDto.toDomain(): MiniUser = MiniUser(
    id = id,
    username = username,
    avatarUrl = avatarUrl,
    diamondBalance = diamondBalance,
    vipLevel = vipLevel,
    rank = rank.toDomain(),
    profileFrame = profileFrame.toDomain(),
    // A blank URL would make Coil request the API origin itself; an absent one means "no flourish".
    entryEffect = entryEffect?.takeIf { it.isNotBlank() },
    entryRide = entryRide.toDomain(),
)

/**
 * A ring the server resolved for a member. It is dropped unless both the key and the art are
 * present: a ring with no file cannot be drawn, and one with no key cannot be equipped — either
 * way the avatar simply stays bare instead of the app inventing art.
 */
fun FrameArtDto?.toDomain(): ProfileFrame? {
    val frame = this ?: return null
    val key = frame.key?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val art = frame.art?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val name = frame.name?.trim()?.takeIf { it.isNotEmpty() } ?: key
    return ProfileFrame(key = key, name = name, art = art, accent = frame.accent)
}

/**
 * The ride a member arrives with. Dropped unless both the key and the file are there: without a URL
 * there is nothing for a renderer to open, and the room simply shows an arrival with no cinematic —
 * there is no free ride this client is allowed to invent in its place.
 *
 * `url`/`format` here, `art`/`animationFormat` on the shop row: this function reads the account
 * shape only, and the two must never be cross-wired.
 */
fun RideArtDto?.toDomain(): EntryRide? {
    val ride = this ?: return null
    val key = ride.key?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val url = ride.url?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val name = ride.name?.trim()?.takeIf { it.isNotEmpty() } ?: key
    return EntryRide(
        key = key,
        name = name,
        url = url,
        // An absent or unknown container reads as Lottie, the renderer every build of this app
        // has had; a format the sniffer named is passed through untouched so the overlay can route.
        format = enumOrDefault(ride.format?.trim()?.uppercase() ?: "LOTTIE", GiftAnimationFormat.LOTTIE),
        // Gson leaves the key null when the server omits it; 0 from the server stays 0, because 0
        // means "the clip's own length" and is the operator's answer, not a gap to fill here.
        durationMs = ride.durationMs ?: 0,
    )
}

fun UserDto.toDomain(): User = User(
    id = id,
    phone = phone,
    username = username,
    avatarUrl = avatarUrl,
    bio = bio,
    gender = gender,
    countryCode = countryCode,
    diamondBalance = diamondBalance,
    rCoinBalance = rCoinBalance,
    totalGiftsSent = totalGiftsSent,
    totalGiftsReceived = totalGiftsReceived,
    userType = userType,
    status = status,
    isVerified = isVerified,
    vipLevel = vipLevel,
    xp = xp,
    rank = rank.toDomain(),
    profileFrame = profileFrame.toDomain(),
    entryEffect = entryEffect?.takeIf { it.isNotBlank() },
    entryRide = entryRide.toDomain(),
)

fun SeatDto.toDomain(): Seat = Seat(
    seatIndex = seatIndex,
    status = enumOrDefault(status, SeatStatus.EMPTY),
    isMuted = isMuted,
    isSpeaker = isSpeaker,
    user = user?.toDomain(),
)

fun RoomSummaryDto.toDomain(): RoomSummary = RoomSummary(
    id = id,
    roomNumber = roomNumber,
    title = title,
    description = description,
    coverUrl = coverUrl,
    theme = theme ?: DEFAULT_ROOM_THEME,
    category = enumOrDefault(category, RoomCategory.PARTY),
    language = language,
    region = region,
    rules = rules,
    type = enumOrDefault(type, RoomType.PUBLIC),
    seatCapacity = seatCapacity,
    status = enumOrDefault(status, RoomStatus.ACTIVE),
    listenerCount = listenerCount,
    likeCount = likeCount ?: 0,
    totalGiftValue = totalGiftValue,
    host = host.toDomain(),
)

fun RoomDto.toDomain(): Room = Room(
    id = id,
    roomNumber = roomNumber,
    title = title,
    description = description,
    coverUrl = coverUrl,
    theme = theme ?: DEFAULT_ROOM_THEME,
    category = enumOrDefault(category, RoomCategory.PARTY),
    language = language,
    region = region,
    rules = rules,
    announcement = announcement,
    announcementUpdatedAt = announcementUpdatedAt,
    // Absent on a backend that predates the approval switch, which is the mode that has always
    // seated a member on tap — so a missing key is "off", not a guess about the host's setting.
    speakerApprovalRequired = speakerApprovalRequired == true,
    ambientEffect = ambientEffect ?: DEFAULT_AMBIENT_EFFECT,
    themeWallpaper = themeWallpaper,
    type = enumOrDefault(type, RoomType.PUBLIC),
    seatCapacity = seatCapacity,
    status = enumOrDefault(status, RoomStatus.ACTIVE),
    listenerCount = listenerCount,
    likeCount = likeCount ?: 0,
    totalGiftValue = totalGiftValue,
    host = host.toDomain(),
    // orEmpty(): the wire `room` object has no seats key; callers that need the
    // grid get it from the envelope (RoomDetailResponse / JoinRoomResponse).
    seats = seats.orEmpty().map { it.toDomain() },
)

fun LiveKitTokenDto.toDomain(): LiveKitCredentials =
    LiveKitCredentials(url, token, roomName, identity, canPublish)

fun RoomThemeDto.toDomain(): RoomThemeOption = RoomThemeOption(
    slug = slug,
    name = name,
    accent = accent,
    wallpaper = wallpaper,
)

/**
 * `GET /api/rooms/themes` -> domain. `welcome` is passed through as-is, null included: an operator
 * who removed every entry flourish means the room plays nothing, and this client has no opinion of
 * its own about which file that should be.
 */
fun ThemeCatalogueDto.toDomain(): ThemeCatalogue = ThemeCatalogue(
    themes = themes.map { it.toDomain() },
    defaultTheme = defaultTheme?.takeIf { it.isNotBlank() } ?: DEFAULT_ROOM_THEME,
    welcome = welcome,
)

/**
 * `GET /api/emoji` -> domain.
 *
 * A row with no key or no art is dropped rather than guessed at: the picker would show an empty
 * tile and no message could ever match it. `code` is only derived from the key when the server
 * omitted it — the token itself is the server's, because that is what sent messages contain.
 */
fun EmojiCatalogueDto.toDomain(): EmojiCatalogue = EmojiCatalogue(
    emojis = emojis.orEmpty().mapNotNull { option ->
        val key = option.key
        val url = option.url
        if (key.isNullOrBlank() || url.isNullOrBlank()) return@mapNotNull null
        EmojiOption(
            key = key,
            label = option.label?.takeIf { it.isNotBlank() } ?: key,
            code = option.code?.takeIf { it.isNotBlank() } ?: "[$key]",
            url = url,
        )
    },
    codePattern = usableEmojiPattern(codePattern),
)

/** A pattern the server cannot compile would crash every chat bubble, so an unusable one is discarded. */
private fun usableEmojiPattern(candidate: String?): String {
    if (candidate.isNullOrBlank()) return FALLBACK_EMOJI_CODE_PATTERN
    return if (runCatching { Regex(candidate) }.isSuccess) candidate else FALLBACK_EMOJI_CODE_PATTERN
}

fun SeatCapacityDto.toDomain(): SeatPolicy =
    SeatPolicy(minSeats = min, defaultSeats = defaultCapacity, maxSeats = max)

fun ChatMessageDto.toDomain(): ChatMessage = ChatMessage(
    id = id,
    user = user?.toDomain(),
    content = content,
    type = enumOrDefault(type, MessageType.TEXT),
    createdAt = createdAt,
)

fun GiftDto.toDomain(): Gift = Gift(
    id = id,
    name = name,
    iconUrl = iconUrl,
    animationUrl = animationUrl,
    soundUrl = soundUrl,
    diamondPrice = diamondPrice,
    rCoinValue = rCoinValue,
    category = category,
    minVipLevel = minVipLevel,
    sortOrder = sortOrder ?: 0,
    // An absent or unknown tier reads as the quiet one: a gift nobody has ruled
    // on must not blind the whole room.
    effectKind = enumOrDefault(effectKind ?: "TICKER", GiftEffectKind.TICKER),
    // The playback fields arrived with migration 0023. A row from before it, or a response from an
    // older backend, has none of them: Lottie is the renderer that has always existed, and a
    // lifetime of 0 leaves the overlay to its own clock rather than inventing one here.
    animationFormat = enumOrDefault(animationFormat ?: "LOTTIE", GiftAnimationFormat.LOTTIE),
    durationMs = durationMs ?: 0,
    displayPriority = displayPriority ?: 0,
    comboEnabled = comboEnabled ?: false,
    comboWindowMs = comboWindowMs ?: 5_000,
    // A key the server never sent reads as "not a box" rather than as a box with no prizes, which is
    // the difference between an ordinary gift and a broken one on screen.
    isLuckyBox = isLuckyBox ?: false,
    boxOutcomes = boxOutcomes?.map { it.toDomain() }.orEmpty(),
    receiverShareBps = receiverShareBps,
)

fun GiftBoxOutcomeDto.toDomain(): GiftBoxOutcome = GiftBoxOutcome(
    label = label,
    multiplierBps = multiplierBps,
    chanceBps = chanceBps,
)

/**
 * The draw the ledger wrote, as the event carried it.
 *
 * Null rather than an empty roll when the key is absent: every renderer that shows a prize is
 * therefore asking "did the server draw one", and a gift from a backend without boxes draws no
 * number that nobody paid for.
 */
fun LuckyRollDto?.toDomain(): LuckyRoll? {
    val roll = this ?: return null
    return LuckyRoll(
        prizes = roll.outcomes?.map { it.toDomain() }.orEmpty(),
        headline = roll.headline?.toDomain(),
        // Absent money reads as zero, never as a guess: the credit the room sees is `totalRCoins`
        // on the event itself, which the server took from the same row as this object.
        grossRCoins = roll.grossRCoins ?: 0L,
        receiverRCoins = roll.receiverRCoins ?: 0L,
        platformTaxRCoins = roll.platformTaxRCoins ?: 0L,
        receiverShareBps = roll.receiverShareBps ?: 0,
    )
}

fun LuckyPrizeDto.toDomain(): LuckyPrize = LuckyPrize(
    label = label,
    multiplierBps = multiplierBps,
    chanceBps = chanceBps ?: 0,
    count = count ?: 0,
)

/**
 * `GET /api/gifts` -> domain.
 *
 * [GiftsResponse.categories] is the operator's shelf list and is absent on an older server (Gson's
 * Unsafe allocator leaves it null rather than the Kotlin default), so it reads as an empty list here
 * and the tab strip falls back to the catalogue's own category strings.
 */
fun GiftsResponse.toDomain(): GiftCatalogue = GiftCatalogue(
    gifts = gifts.map { it.toDomain() },
    categories = categories.orEmpty().mapNotNull { it.toDomain() },
)

/**
 * One shelf row. A shelf with no key cannot match any gift or label a tab, so it is dropped; a
 * missing name falls back to the key cosmetically, which is what an unnamed shelf would read as.
 */
fun GiftCategoryDto.toDomain(): GiftCategoryOption? {
    val shelfKey = key?.takeIf { it.isNotBlank() } ?: return null
    return GiftCategoryOption(
        key = shelfKey,
        name = name?.takeIf { it.isNotBlank() } ?: giftCategoryFallbackLabel(shelfKey),
        sortOrder = sortOrder ?: 0,
    )
}

fun TransactionDto.toDomain(): Transaction = Transaction(
    id = id,
    type = type,
    amountDiamonds = amountDiamonds,
    amountRCoins = amountRCoins,
    giftName = giftName,
    sender = sender?.toDomain(),
    receiver = receiver?.toDomain(),
    createdAt = createdAt,
)

fun WalletResponse.toDomain(): WalletSnapshot = WalletSnapshot(
    user = user.toDomain(),
    transactions = transactions.map { it.toDomain() },
    stats = com.voiza.app.domain.model.WalletStats(
        diamondsSpent = stats.diamondsSpent,
        rCoinsEarned = stats.rCoinsEarned,
        giftsSent = stats.giftsSent,
    ),
    withdrawalPolicy = withdrawalPolicy?.let {
        com.voiza.app.domain.model.WithdrawalPolicy(minRCoins = it.minRCoins, feeBps = it.feeBps)
    },
)

fun WithdrawalDto.toDomain() = com.voiza.app.domain.model.Withdrawal(
    id = id,
    amountRCoins = amountRCoins,
    feeRCoins = feeRCoins,
    netRCoins = netRCoins,
    status = status,
    payoutMethod = payoutMethod,
)

/**
 * One shop row. A row is dropped unless its kind is one this build knows, and unless it has the
 * four strings every card needs to draw and to buy it: key, name and art. A newer backend selling
 * a fourth catalogue should make the shop show less, not crash it.
 */
fun StoreItemDto.toDomainOrNull(): StoreItem? {
    val parsedKind = kind?.let { raw ->
        StoreItemKind.entries.firstOrNull { it.name == raw.trim().uppercase() }
    } ?: return null
    val itemKey = key?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val itemName = name?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val itemArt = art?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return StoreItem(
        kind = parsedKind,
        key = itemKey,
        name = itemName,
        art = itemArt,
        accent = accent,
        priceDiamonds = priceDiamonds,
        periodDays = periodDays,
        owned = owned,
        expiresAt = expiresAt?.takeIf { it.isNotBlank() },
        equipped = equipped,
        // Nullable-DTO rule: Gson leaves an absent key null, so the fallback lives here.
        minVipLevel = minVipLevel ?: 0,
        recommended = recommended ?: false,
        // Sent on RIDE rows and on nothing else. The schema's own default is LOTTIE, so an absent
        // or unrecognised container degrades to the one renderer every build has shipped rather
        // than making the row undrawable; a named SVGA/MP4 must survive intact, since a device
        // that opens those with the Lottie player shows a still frame instead of an error.
        animationFormat = enumOrDefault(
            animationFormat?.trim()?.uppercase() ?: "LOTTIE",
            GiftAnimationFormat.LOTTIE,
        ),
        // 0 from the server is "play the clip for its own length" and stays 0; only a key the
        // response never carried becomes 0 here, which is the same answer an older catalogue gives.
        durationMs = durationMs ?: 0,
    )
}

fun OwnedStoreItemDto.toDomainOrNull(): OwnedStoreItem? {
    val parsedKind = kind?.let { raw ->
        StoreItemKind.entries.firstOrNull { it.name == raw.trim().uppercase() }
    } ?: return null
    val itemKey = key?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return OwnedStoreItem(
        kind = parsedKind,
        key = itemKey,
        name = name?.trim()?.takeIf { it.isNotEmpty() } ?: itemKey,
        art = art?.trim().orEmpty(),
        onSale = onSale,
        expiresAt = expiresAt?.takeIf { it.isNotBlank() },
        acquiredVia = acquiredVia?.trim()?.takeIf { it.isNotEmpty() } ?: "PURCHASE",
    )
}

fun StoreResponse.toDomain(): StoreSnapshot = StoreSnapshot(
    items = items.orEmpty().mapNotNull { it.toDomainOrNull() },
    owned = owned.orEmpty().mapNotNull { it.toDomainOrNull() },
)

/**
 * `POST /api/store/purchase` (201): the ledger wrote the debit, so [user] is the wallet after it.
 * [item] may fail to map — the money already moved — and the caller then reloads the shop rather
 * than pretending the row is unknown. [user] is nullable only for a malformed envelope, so a
 * response that names no wallet still lets the purchase be reported instead of throwing.
 */
fun StorePurchaseResponse.toDomain(): StorePurchase = StorePurchase(
    item = item?.toDomainOrNull(),
    user = wallet?.toDomain(),
)

fun LeaderEntryDto.toDomain(): RankRow = RankRow(
    user = MiniUser(id = id, username = username, avatarUrl = avatarUrl, rank = rank.toDomain()),
    earned = earned ?: 0,
)

fun LeaderboardResponse.toDomain(): Leaderboard = Leaderboard(
    window = window ?: "week",
    // An unreadable board name reads as the host board: it is the one that has
    // always existed, and it never shows a spender's name to the room.
    board = enumOrDefault(role ?: "receivers", RankBoard.RECEIVERS),
    rows = leaders.orEmpty().map { it.toDomain() },
)

// Socket event mappers -------------------------------------------------------

fun SocketChatDto.toDomain(): RoomChatEvent = RoomChatEvent(
    roomId = roomId,
    message = ChatMessage(id, user?.toDomain(), content, enumOrDefault(type, MessageType.TEXT), createdAt),
)

fun SocketSeatUpdateDto.toDomain(): SeatUpdateEvent = SeatUpdateEvent(
    roomId = roomId,
    seats = seats.map { it.toDomain() },
    audience = audience.map { it.toDomain() },
)

fun SocketUserJoinedDto.toDomain(): UserJoinedEvent =
    UserJoinedEvent(roomId = roomId, user = user.toDomain())

/** `user` is nullable because Gson leaves an absent key null; drop malformed emits. */
fun SocketHandRaiseDto.toDomainOrNull(): HandRaiseEvent? =
    user?.toDomain()?.let { HandRaiseEvent(roomId = roomId, raised = raised, user = it) }

fun SocketMicToggleDto.toDomain(): MicToggleEvent =
    MicToggleEvent(roomId = roomId, seatIndex = seatIndex, muted = muted)

fun SocketGiftAnimatedDto.toDomain(): GiftAnimatedEvent = GiftAnimatedEvent(
    roomId = roomId,
    gift = gift.toDomain(),
    sender = sender.toDomain(),
    receiver = receiver.toDomain(),
    quantity = quantity,
    animationUrl = animationUrl,
    totalDiamonds = totalDiamonds,
    totalRCoins = totalRCoins,
    seatIndex = seatIndex,
    eventId = eventId,
    comboId = comboId,
    comboCount = comboCount ?: 1,
    lucky = lucky.toDomain(),
)

/**
 * The tail `room:gift_history` hands a device that missed gifts while its socket was down. Rows
 * arrive newest-first, and a catch-up is not a replay of the room's party: these gifts already
 * happened, so they go to the ticker column, which is the part of the effect layer that is a list
 * of recent sends rather than a screen the next gift takes over.
 */
fun SocketGiftHistoryDto.toDomain(): List<GiftAnimatedEvent> =
    gifts.map { it.toDomain(roomId) }

fun RoomGiftEventDto.toDomain(roomId: String): GiftAnimatedEvent = GiftAnimatedEvent(
    roomId = roomId,
    gift = gift.toDomain(),
    sender = sender.toDomain(),
    receiver = receiver.toDomain(),
    quantity = quantity,
    animationUrl = gift.animationUrl,
    totalDiamonds = totalDiamonds,
    totalRCoins = totalRCoins,
    seatIndex = seatIndex,
    eventId = eventId,
    // A window that has already closed is not counted onto; the row is history, not a live combo.
    comboId = null,
    comboCount = 1,
    // The roll is history too, and it is the same object the ledger row kept, so a device that
    // reconnects mid-party reports the prize that was actually paid rather than the odds.
    lucky = lucky.toDomain(),
)

fun SocketLikeDto.toDomain(): RoomLikeEvent = RoomLikeEvent(
    roomId = roomId,
    count = count,
    total = total,
    user = user?.toDomain(),
)

/**
 * A reaction is only drawable with its art attached, and Gson leaves every absent key null
 * regardless of the defaults written here — so an emit missing the room, the sender or the picture
 * is dropped rather than flown as an empty box.
 */
fun SocketReactionDto.toDomainOrNull(): RoomReactionEvent? {
    val room = roomId ?: return null
    val who = userId ?: return null
    val emojiKey = key ?: return null
    val imageUrl = url ?: return null
    return RoomReactionEvent(
        roomId = room,
        userId = who,
        emoji = EmojiOption(
            key = emojiKey,
            label = label ?: emojiKey,
            code = code ?: "[$emojiKey]",
            url = imageUrl,
        ),
    )
}

fun SocketRoomProfileDto.toDomain(): RoomProfileEvent = RoomProfileEvent(
    roomId = roomId,
    title = title,
    description = description,
    category = enumOrDefault(category, RoomCategory.PARTY),
    language = language,
    region = region,
    rules = rules,
    announcement = announcement,
    announcementUpdatedAt = announcementUpdatedAt,
    speakerApprovalRequired = speakerApprovalRequired,
)

/**
 * `room:announcement`. A null text is the notice having been cleared, so this event owns the field
 * on screen: `room:profile_updated` cannot tell a cleared notice from an old server that never
 * mentioned one, and this one never has to.
 */
fun SocketAnnouncementDto.toDomain(): RoomAnnouncementEvent =
    RoomAnnouncementEvent(roomId = roomId, announcement = announcement, updatedAt = updatedAt)

// ---------------------------------------------------------------------------
// Speaker approval queue
//
// `room:speaker_request` and `room:speaker_request_updated` carry the request that moved, but the
// queue is the server's list in the server's order, so the app reads those two as "re-fetch"
// instead of editing a copy it may already be behind on — see
// [com.voiza.app.data.socket.VoizaSocketClient.speakerQueueChanges].
// ---------------------------------------------------------------------------

fun SpeakerRequestDto.toDomain(): SpeakerRequest = SpeakerRequest(
    id = id,
    roomId = roomId,
    seatIndex = seatIndex,
    status = enumOrDefault(status, SpeakerRequestStatus.PENDING),
    createdAt = createdAt,
    user = user?.toDomain(),
)

/**
 * `POST /api/rooms/:id/seat`, which has two answers. Only a body the server marked `requested` is
 * read as a queue entry: an approval-enabled room seats nobody, mints no token and leaves the seat
 * list alone, so treating its 202 like the other seat routes would push an empty grid on screen.
 */
fun TakeSeatResponse.toDomain(): SeatTakeResult = when {
    requested == true -> SeatTakeResult.Queued(request?.toDomain())
    else -> SeatTakeResult.Seated(seats.orEmpty().map { it.toDomain() }, livekit?.toDomain())
}

/** `seatIndex` is a top-level key on the event; the request inside it repeats it. */
fun SocketSeatInvitedDto.toDomain(): SeatInviteEvent =
    SeatInviteEvent(roomId = roomId, seatIndex = seatIndex, livekit = livekit?.toDomain())

/**
 * `room:speaker_decision`. An approval that named no seat falls back to the request's own seat,
 * which is the one the host just gave them.
 */
fun SocketSpeakerDecisionDto.toDomain(): SpeakerDecisionEvent = SpeakerDecisionEvent(
    roomId = roomId,
    status = enumOrDefault(status, SpeakerRequestStatus.PENDING),
    seatIndex = seatIndex ?: request?.seatIndex,
    livekit = livekit?.toDomain(),
)

// ---------------------------------------------------------------------------
// Promotional banners
// ---------------------------------------------------------------------------

/**
 * A campaign row, or null when this device can neither draw it nor count it.
 *
 * The two fields that get a row dropped are `id` (every impression and tap is addressed by it, so a
 * banner that cannot be counted is a banner the operator cannot believe) and `placement` (rendering
 * a row on a surface the operator never filed it under would be an approval the platform never
 * granted). A format the app has never seen falls back to a still image rather than hiding the
 * campaign, which is the same call the gift engine makes for an unknown animation format.
 */
fun BannerDto.toDomainOrNull(): PromoBanner? {
    val bannerId = id?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val art = url?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val surface = placement?.trim()?.uppercase()?.let { raw ->
        runCatching { enumValueOf<BannerPlacement>(raw) }.getOrNull()
    } ?: return null
    return PromoBanner(
        id = bannerId,
        key = key.orEmpty(),
        placement = surface,
        title = title?.trim().orEmpty(),
        subtitle = subtitle?.trim()?.takeIf { it.isNotEmpty() },
        url = art,
        format = enumOrDefault(format ?: "PNG", BannerFormat.PNG),
        durationMs = durationMs ?: 0,
        target = bannerTarget(ctaType, ctaValue),
    )
}

fun BannersResponse.toDomain(): List<PromoBanner> = banners.orEmpty().mapNotNull { it.toDomainOrNull() }

/**
 * The verb and its value, joined.
 *
 * Each branch re-checks the shape the database already enforces on `banners.cta_value`, because a
 * server that has moved on could hand this client a value it has no route for — and the answer to
 * "where does this banner go" must never be a guess.
 */
private fun bannerTarget(ctaType: String?, ctaValue: String?): BannerTarget =
    when (ctaType?.trim()?.uppercase()) {
        "INTERNAL" -> runCatching { enumValueOf<BannerScreen>(ctaValue.orEmpty().trim().uppercase()) }
            .getOrNull()
            ?.let(BannerTarget::Internal)
            ?: BannerTarget.None
        "ROOM" -> ctaValue?.trim()?.takeIf { it.isNotEmpty() }?.let(BannerTarget::Room) ?: BannerTarget.None
        "URL" -> ctaValue?.trim()?.takeIf { it.startsWith("https://") }?.let(BannerTarget::Link)
            ?: BannerTarget.None
        else -> BannerTarget.None
    }

/** Case-insensitive enum parse with a fallback so unknown values never crash. */
internal inline fun <reified T : Enum<T>> enumOrDefault(raw: String, default: T): T =
    runCatching { enumValueOf<T>(raw.uppercase()) }.getOrDefault(default)

// ---------------------------------------------------------------------------
// Social moderation.
// ---------------------------------------------------------------------------

/**
 * The caller's edges to one member. Every flag reads false when the server did not send it:
 * "not following" and "not blocked" are the safe answers, and a card that guessed the other way
 * would offer to undo an edge that was never there.
 *
 * [Relationship.interactionBlocked] is taken from the wire rather than recomputed from the two
 * block flags — which interactions a block closes is the backend's rule.
 */
fun RelationshipDto.toDomain(): Relationship = Relationship(
    following = following == true,
    blockedByMe = blockedByMe == true,
    blockedByThem = blockedByThem == true,
    interactionBlocked = interactionBlocked == true,
)
