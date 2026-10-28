package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.ChatMessageDto
import com.voiza.app.data.remote.dto.EmojiCatalogueDto
import com.voiza.app.data.remote.dto.FrameArtDto
import com.voiza.app.data.remote.dto.GiftDto
import com.voiza.app.data.remote.dto.LeaderEntryDto
import com.voiza.app.data.remote.dto.LeaderboardResponse
import com.voiza.app.data.remote.dto.LiveKitTokenDto
import com.voiza.app.data.remote.dto.MiniUserDto
import com.voiza.app.data.remote.dto.OwnedStoreItemDto
import com.voiza.app.data.remote.dto.RankDto
import com.voiza.app.data.remote.dto.RoomDto
import com.voiza.app.data.remote.dto.RoomSummaryDto
import com.voiza.app.data.remote.dto.RoomThemeDto
import com.voiza.app.data.remote.dto.SeatCapacityDto
import com.voiza.app.data.remote.dto.SeatDto
import com.voiza.app.data.remote.dto.SocketChatDto
import com.voiza.app.data.remote.dto.SocketGiftAnimatedDto
import com.voiza.app.data.remote.dto.SocketHandRaiseDto
import com.voiza.app.data.remote.dto.SocketLikeDto
import com.voiza.app.data.remote.dto.SocketMicToggleDto
import com.voiza.app.data.remote.dto.SocketRoomProfileDto
import com.voiza.app.data.remote.dto.SocketSeatUpdateDto
import com.voiza.app.data.remote.dto.SocketUserJoinedDto
import com.voiza.app.data.remote.dto.StoreItemDto
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
import com.voiza.app.domain.model.ChatMessage
import com.voiza.app.domain.model.EmojiCatalogue
import com.voiza.app.domain.model.EmojiOption
import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.domain.model.GiftEffectKind
import com.voiza.app.domain.model.HandRaiseEvent
import com.voiza.app.domain.model.Leaderboard
import com.voiza.app.domain.model.LiveKitCredentials
import com.voiza.app.domain.model.MicToggleEvent
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.MessageType
import com.voiza.app.domain.model.OwnedStoreItem
import com.voiza.app.domain.model.ProfileFrame
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.RankRow
import com.voiza.app.domain.model.Room
import com.voiza.app.domain.model.RoomCategory
import com.voiza.app.domain.model.RoomChatEvent
import com.voiza.app.domain.model.RoomLikeEvent
import com.voiza.app.domain.model.RoomProfileEvent
import com.voiza.app.domain.model.RoomStatus
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.domain.model.RoomThemeOption
import com.voiza.app.domain.model.RoomType
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatPolicy
import com.voiza.app.domain.model.SeatStatus
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
)

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
)

fun WithdrawalDto.toDomain() = com.voiza.app.domain.model.Withdrawal(id, amountRCoins, status, payoutMethod)

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
)

fun SocketLikeDto.toDomain(): RoomLikeEvent = RoomLikeEvent(
    roomId = roomId,
    count = count,
    total = total,
    user = user?.toDomain(),
)

fun SocketRoomProfileDto.toDomain(): RoomProfileEvent = RoomProfileEvent(
    roomId = roomId,
    title = title,
    description = description,
    category = enumOrDefault(category, RoomCategory.PARTY),
    language = language,
    region = region,
    rules = rules,
)

/** Case-insensitive enum parse with a fallback so unknown values never crash. */
internal inline fun <reified T : Enum<T>> enumOrDefault(raw: String, default: T): T =
    runCatching { enumValueOf<T>(raw.uppercase()) }.getOrDefault(default)
