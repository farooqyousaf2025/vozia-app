package com.voiza.app.data.mapper

import com.voiza.app.data.remote.dto.ChatMessageDto
import com.voiza.app.data.remote.dto.GiftDto
import com.voiza.app.data.remote.dto.LeaderEntryDto
import com.voiza.app.data.remote.dto.LeaderboardResponse
import com.voiza.app.data.remote.dto.LiveKitTokenDto
import com.voiza.app.data.remote.dto.MiniUserDto
import com.voiza.app.data.remote.dto.RoomDto
import com.voiza.app.data.remote.dto.RoomSummaryDto
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
import com.voiza.app.data.remote.dto.TransactionDto
import com.voiza.app.data.remote.dto.UserDto
import com.voiza.app.data.remote.dto.WalletResponse
import com.voiza.app.data.remote.dto.WithdrawalDto
import com.voiza.app.domain.model.DEFAULT_AMBIENT_EFFECT
import com.voiza.app.domain.model.DEFAULT_ROOM_THEME
import com.voiza.app.domain.model.ChatMessage
import com.voiza.app.domain.model.Gift
import com.voiza.app.domain.model.GiftAnimatedEvent
import com.voiza.app.domain.model.GiftEffectKind
import com.voiza.app.domain.model.HandRaiseEvent
import com.voiza.app.domain.model.Leaderboard
import com.voiza.app.domain.model.LiveKitCredentials
import com.voiza.app.domain.model.MicToggleEvent
import com.voiza.app.domain.model.MiniUser
import com.voiza.app.domain.model.MessageType
import com.voiza.app.domain.model.RankBoard
import com.voiza.app.domain.model.RankRow
import com.voiza.app.domain.model.Room
import com.voiza.app.domain.model.RoomCategory
import com.voiza.app.domain.model.RoomChatEvent
import com.voiza.app.domain.model.RoomLikeEvent
import com.voiza.app.domain.model.RoomProfileEvent
import com.voiza.app.domain.model.RoomStatus
import com.voiza.app.domain.model.RoomSummary
import com.voiza.app.domain.model.RoomType
import com.voiza.app.domain.model.Seat
import com.voiza.app.domain.model.SeatPolicy
import com.voiza.app.domain.model.SeatStatus
import com.voiza.app.domain.model.SeatUpdateEvent
import com.voiza.app.domain.model.Transaction
import com.voiza.app.domain.model.User
import com.voiza.app.domain.model.UserJoinedEvent
import com.voiza.app.domain.model.WalletSnapshot

// ---------------------------------------------------------------------------
// DTO -> domain mapping. Unknown enum wire values degrade to safe defaults
// instead of throwing, so a backend enum addition cannot crash the client.
// ---------------------------------------------------------------------------

fun MiniUserDto.toDomain(): MiniUser = MiniUser(id, username, avatarUrl, diamondBalance, vipLevel)

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

fun LeaderEntryDto.toDomain(): RankRow = RankRow(
    user = MiniUser(id = id, username = username, avatarUrl = avatarUrl),
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
