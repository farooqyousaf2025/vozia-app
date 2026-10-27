import {
  AdminRow,
  BusinessAccountRow,
  ChatRow,
  CommissionEntryRow,
  CommissionRuleRow,
  CommissionSettlementRow,
  GameDefinitionRow,
  GameDisputeRow,
  GameParticipantRow,
  GameSessionRow,
  GiftRow,
  ParticipantRow,
  RechargeOrderRow,
  RechargePackageRow,
  RoomRow,
  SeatRow,
  TransactionRow,
  UserRow,
  WithdrawalRow,
} from '../types/db';
import { ambientEffectFor } from '../config/themes';

export type MiniUser = {
  id: string;
  username: string;
  avatarUrl: string | null;
  diamondBalance?: number;
  /** Only where the client needs it: drives the size of a room entry effect. */
  vipLevel?: number;
};

export type SeatDto = {
  seatIndex: number;
  status: SeatRow['status'];
  isMuted: boolean;
  isSpeaker: boolean;
  user: MiniUser | null;
};

export type RoomDto = {
  id: string;
  roomNumber: number;
  title: string;
  description: string | null;
  coverUrl: string | null;
  theme: string;
  category: RoomRow['category'];
  /** ISO 639-1 tag the host stated, or null when they never said. */
  language: string | null;
  /** ISO 3166-1 alpha-2 the room targets, or null. */
  region: string | null;
  /** Host-written house rules; the client shows them, it does not enforce them. */
  rules: string | null;
  /** Ambient Lottie loop the client plays behind this room — chosen by the server. */
  ambientEffect: string;
  type: RoomRow['type'];
  seatCapacity: number;
  status: RoomRow['status'];
  listenerCount: number;
  likeCount: number;
  totalGiftValue: number;
  host: MiniUser;
  livekitRoomName: string;
  createdAt: string;
  closedAt: string | null;
};

export type GiftDto = {
  id: string;
  name: string;
  iconUrl: string;
  animationUrl: string | null;
  soundUrl: string | null;
  diamondPrice: number;
  rCoinValue: number;
  category: string;
  /** TICKER = one row in the gift column; FULLSCREEN = takes over the room. */
  effectKind: 'TICKER' | 'FULLSCREEN';
  minVipLevel: number;
  sortOrder: number;
  isActive: boolean;
};

export type TransactionDto = {
  id: string;
  type: string;
  status: string;
  quantity: number;
  amountDiamonds: number;
  amountRCoins: number;
  giftName: string | null;
  sender: MiniUser | null;
  receiver: MiniUser | null;
  note: string | null;
  createdAt: string;
};

export type ChatMessageDto = {
  id: string;
  roomId: string;
  user: MiniUser | null;
  content: string;
  type: ChatRow['message_type'];
  createdAt: string;
};

export type UserDto = {
  id: string;
  phone: string;
  username: string;
  avatarUrl: string | null;
  bio: string | null;
  gender: string | null;
  countryCode: string | null;
  diamondBalance: number;
  rCoinBalance: number;
  totalGiftsSent: number;
  totalGiftsReceived: number;
  userType: UserRow['user_type'];
  status: UserRow['status'];
  isVerified: boolean;
  /** Spend tier compared against gifts.min_vip_level; ops-set, never self-service. */
  vipLevel: number;
  lastSeenAt: string | null;
  createdAt: string;
};

export type ParticipantDto = {
  id: string;
  roomId: string;
  seatIndex: number | null;
  role: ParticipantRow['role'];
  handRaised: boolean;
  joinedAt: string;
  user: MiniUser;
};

export type WithdrawalDto = {
  id: string;
  amountRCoins: number;
  status: WithdrawalRow['status'];
  payoutMethod: string;
  payoutDetails: Record<string, unknown>;
  createdAt: string;
  user: MiniUser;
};

export type GameDefinitionDto = {
  key: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  minPlayers: number;
  maxPlayers: number;
  allowSpectators: boolean;
  turnTimeoutSeconds: number;
  isActive: boolean;
  entryFeeEnabled: boolean;
  entryFeeDiamonds: number;
  entryFeeMin: number;
  entryFeeMax: number;
  prizeEnabled: boolean;
  commissionBps: number;
  refundPolicy: GameDefinitionRow['refund_policy'];
  dailyEntryLimit: number;
  rulesVersion: number;
  /**
   * The prize ladder as the settlement engine will read it. Rows seeded before the API
   * existed store `share_bps`; the panel is shown `shareBps` so it never edits one shape
   * and displays another.
   */
  prizeRules: Array<{ rank: number; shareBps: number }>;
  promoFreeEntry: boolean;
  promoUntil: string | null;
};

export type GameParticipantDto = {
  userId: string;
  username: string;
  avatarUrl: string | null;
  position: number;
  status: GameParticipantRow['status'];
  score: number;
  rank: number | null;
  entryFeeDiamonds: number;
  prizeDiamonds: number;
  ready: boolean;
};

export type GameSessionDto = {
  id: string;
  gameKey: string;
  roomId: string | null;
  createdBy: string;
  status: GameSessionRow['status'];
  settlementStatus: GameSessionRow['settlement_status'];
  rulesVersion: number;
  /**
   * The board minus anything a player must not see. Quiz Battle's answer keys are
   * removed by the engine before a session is ever serialized.
   */
  state: unknown;
  entryFeeDiamonds: number;
  maxPlayers: number;
  turnOwnerId: string | null;
  turnDeadlineAt: string | null;
  result: Record<string, unknown> | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  participants: GameParticipantDto[];
};

export type GameDisputeDto = {
  id: string;
  sessionId: string;
  reason: string;
  status: string;
  resolution: string | null;
  createdAt: string;
  reviewedAt: string | null;
  raisedBy: MiniUser;
};

const iso = (value: Date | string): string => new Date(value).toISOString();

export function toMiniUser(row: {
  id: string;
  username: string;
  avatar_url?: string | null;
  diamond_balance?: number;
  vip_level?: number;
}): MiniUser {
  const mini: MiniUser = { id: row.id, username: row.username, avatarUrl: row.avatar_url ?? null };
  if (row.diamond_balance !== undefined) mini.diamondBalance = row.diamond_balance;
  if (row.vip_level !== undefined) mini.vipLevel = row.vip_level;
  return mini;
}

export function toUser(row: UserRow): UserDto {
  return {
    id: row.id,
    phone: row.phone,
    username: row.username,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    gender: row.gender,
    countryCode: row.country_code,
    diamondBalance: row.diamond_balance,
    rCoinBalance: row.r_coin_balance,
    totalGiftsSent: Number(row.total_gifts_sent),
    totalGiftsReceived: Number(row.total_gifts_received),
    userType: row.user_type,
    status: row.status,
    isVerified: row.is_verified,
    vipLevel: row.vip_level,
    lastSeenAt: row.last_seen_at ? iso(row.last_seen_at) : null,
    createdAt: iso(row.created_at),
  };
}

export function toSeat(row: SeatRow): SeatDto {
  return {
    seatIndex: row.seat_index,
    status: row.status,
    isMuted: row.is_muted,
    isSpeaker: row.is_speaker,
    user:
      row.user_id && row.username
        ? { id: row.user_id, username: row.username, avatarUrl: row.avatar_url ?? null }
        : null,
  };
}

export function toRoom(row: RoomRow): RoomDto {
  return {
    id: row.id,
    roomNumber: row.room_number,
    title: row.title,
    description: row.description,
    coverUrl: row.cover_url,
    theme: row.theme,
    category: row.category,
    language: row.language ?? null,
    region: row.region ?? null,
    rules: row.rules ?? null,
    ambientEffect: ambientEffectFor(row.category),
    type: row.type,
    seatCapacity: row.seat_capacity,
    status: row.status,
    listenerCount: row.listener_count,
    likeCount: Number(row.like_count ?? 0),
    totalGiftValue: Number(row.total_gift_value),
    livekitRoomName: row.livekit_room_name,
    createdAt: iso(row.created_at),
    closedAt: row.closed_at ? iso(row.closed_at) : null,
    host: {
      // list queries alias the host columns; detail queries carry host_id only
      id: row.host_id,
      username: row.host_username ?? 'unknown',
      avatarUrl: row.host_avatar_url ?? null,
    },
  };
}

export function toGift(row: GiftRow): GiftDto {
  return {
    id: row.id,
    name: row.name,
    iconUrl: row.icon_url,
    animationUrl: row.animation_url,
    soundUrl: row.sound_url,
    diamondPrice: row.diamond_price,
    rCoinValue: row.r_coin_value,
    category: row.category,
    effectKind: row.effect_kind,
    minVipLevel: row.min_vip_level,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

export function toTransaction(row: TransactionRow): TransactionDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    quantity: row.quantity,
    amountDiamonds: row.amount_diamonds,
    amountRCoins: row.amount_r_coins,
    giftName: row.gift_name ?? null,
    sender: row.sender_id
      ? { id: row.sender_id, username: row.sender_username ?? 'unknown', avatarUrl: row.sender_avatar_url ?? null }
      : null,
    receiver: row.receiver_id
      ? {
          id: row.receiver_id,
          username: row.receiver_username ?? 'unknown',
          avatarUrl: row.receiver_avatar_url ?? null,
        }
      : null,
    note: row.note,
    createdAt: iso(row.created_at),
  };
}

export function toChatMessage(row: ChatRow): ChatMessageDto {
  return {
    id: row.id,
    roomId: row.room_id,
    user: row.user_id ? { id: row.user_id, username: row.username ?? 'unknown', avatarUrl: row.avatar_url ?? null } : null,
    content: row.content,
    type: row.message_type,
    createdAt: iso(row.created_at),
  };
}

export function toParticipant(row: ParticipantRow): ParticipantDto {
  return {
    id: row.id,
    roomId: row.room_id,
    seatIndex: row.seat_index,
    role: row.role,
    handRaised: row.hand_raised,
    joinedAt: iso(row.joined_at),
    user: { id: row.user_id, username: row.username ?? 'unknown', avatarUrl: row.avatar_url ?? null },
  };
}

export function toWithdrawal(row: WithdrawalRow): WithdrawalDto {
  return {
    id: row.id,
    amountRCoins: row.amount_r_coins,
    status: row.status,
    payoutMethod: row.payout_method,
    payoutDetails: row.payout_details,
    createdAt: iso(row.created_at),
    user: { id: row.user_id, username: row.username ?? 'unknown', avatarUrl: row.avatar_url ?? null },
  };
}

export function toGameDefinition(row: GameDefinitionRow): GameDefinitionDto {
  const ladder = Array.isArray(row.prize_rules) ? row.prize_rules : [];
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    config: row.config,
    minPlayers: row.min_players,
    maxPlayers: row.max_players,
    allowSpectators: row.allow_spectators,
    turnTimeoutSeconds: row.turn_timeout_seconds,
    isActive: row.is_active,
    entryFeeEnabled: row.entry_fee_enabled,
    entryFeeDiamonds: row.entry_fee_diamonds,
    entryFeeMin: row.entry_fee_min,
    entryFeeMax: row.entry_fee_max,
    prizeEnabled: row.prize_enabled,
    commissionBps: row.commission_bps,
    refundPolicy: row.refund_policy,
    dailyEntryLimit: row.daily_entry_limit,
    rulesVersion: row.rules_version,
    prizeRules: ladder
      .map((entry) => {
        const record = (entry ?? {}) as Record<string, unknown>;
        const rank = Number(record.rank);
        const shareBps = Number(record.shareBps ?? record.share_bps);
        return Number.isInteger(rank) && Number.isInteger(shareBps) ? { rank, shareBps } : null;
      })
      .filter((entry): entry is { rank: number; shareBps: number } => entry !== null),
    promoFreeEntry: row.promo_free_entry,
    promoUntil: row.promo_until ? iso(row.promo_until) : null,
  };
}

export function toGameParticipant(row: GameParticipantRow): GameParticipantDto {
  return {
    userId: row.user_id,
    username: row.username ?? 'unknown',
    avatarUrl: row.avatar_url ?? null,
    position: row.position,
    status: row.status,
    score: Number(row.score),
    rank: row.rank,
    entryFeeDiamonds: row.entry_fee_diamonds,
    prizeDiamonds: row.prize_diamonds,
    ready: row.ready_at !== null,
  };
}

export function toGameSession(row: GameSessionRow, participants: GameParticipantRow[], state: unknown): GameSessionDto {
  return {
    id: row.id,
    gameKey: row.game_key,
    roomId: row.room_id,
    createdBy: row.created_by,
    status: row.status,
    settlementStatus: row.settlement_status,
    rulesVersion: row.rules_version,
    state,
    entryFeeDiamonds: row.entry_fee_diamonds,
    maxPlayers: row.max_players,
    turnOwnerId: row.turn_owner_id,
    turnDeadlineAt: row.turn_deadline_at ? iso(row.turn_deadline_at) : null,
    result: row.result,
    startedAt: row.started_at ? iso(row.started_at) : null,
    endedAt: row.ended_at ? iso(row.ended_at) : null,
    createdAt: iso(row.created_at),
    participants: participants.map(toGameParticipant),
  };
}

export function toGameDispute(row: GameDisputeRow): GameDisputeDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    reason: row.reason,
    status: row.status,
    resolution: row.resolution,
    createdAt: iso(row.created_at),
    reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
    raisedBy: { id: row.raised_by, username: row.username ?? 'unknown', avatarUrl: row.avatar_url ?? null },
  };
}

export function toAdmin(row: AdminRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
  };
}

// ---------------------------------------------------------------------------
// BD / coin-seller DTOs. Currency is always minor units (cents) and always named
// alongside its code, because a statement that says "1500" without saying PKR is
// the kind of number a partner disputes.
// ---------------------------------------------------------------------------

export type BusinessAccountDto = {
  id: string;
  kind: BusinessAccountRow['kind'];
  code: string;
  displayName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  status: BusinessAccountRow['status'];
  marketCountry: string | null;
  parentId: string | null;
  parentCode: string | null;
  parentName: string | null;
  maxOrderDiamonds: number;
  dailyDiamondLimit: number;
  dailyOrderLimit: number;
  hasCredential: boolean;
  approvedAt: string | null;
  suspendedReason: string | null;
  lastLoginAt: string | null;
  createdAt: string;
};

export type CommissionRuleDto = {
  id: string;
  kind: CommissionRuleRow['kind'];
  beneficiary: CommissionRuleRow['beneficiary'];
  appliesToId: string | null;
  appliesToCode: string | null;
  rulesVersion: number;
  percentBps: number | null;
  fixedCents: number | null;
  tiers: CommissionRuleRow['tiers'];
  minOrderCents: number | null;
  maxOrderCents: number | null;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  note: string | null;
};

export type RechargeOrderDto = {
  id: string;
  reference: string;
  status: RechargeOrderRow['status'];
  sellerId: string;
  sellerCode: string;
  sellerName: string;
  bdId: string | null;
  bdCode: string | null;
  userId: string;
  username: string;
  diamonds: number;
  amountCents: number;
  feeCents: number;
  currency: string;
  paymentMethod: string;
  paymentRef: string | null;
  provider: string | null;
  evidence: Record<string, unknown>;
  rulesSnapshot: Record<string, unknown>;
  transactionId: string | null;
  decisionNote: string | null;
  reversalReason: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
};

export type CommissionEntryDto = {
  id: string;
  orderReference: string;
  beneficiary: CommissionEntryRow['beneficiary'];
  beneficiaryId: string | null;
  beneficiaryCode: string | null;
  beneficiaryName: string | null;
  kind: CommissionEntryRow['kind'];
  ruleVersion: number;
  status: CommissionEntryRow['status'];
  basisCents: number;
  amountCents: number;
  currency: string;
  reversedAt: string | null;
  reversalReason: string | null;
  settlementReference: string | null;
  settledAt: string | null;
  createdAt: string;
};

export type CommissionSettlementDto = {
  id: string;
  reference: string;
  beneficiary: CommissionSettlementRow['beneficiary'];
  beneficiaryId: string;
  currency: string;
  amountCents: number;
  entryCount: number;
  status: CommissionSettlementRow['status'];
  periodFrom: string;
  periodTo: string;
  payoutMethod: string | null;
  paidAt: string | null;
  note: string | null;
  createdAt: string;
};

const cents = (value: string | number | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));

export function toBusinessAccount(row: BusinessAccountRow): BusinessAccountDto {
  return {
    id: row.id,
    kind: row.kind,
    code: row.code,
    displayName: row.display_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    status: row.status,
    marketCountry: row.market_country,
    parentId: row.parent_id,
    parentCode: row.parent_code ?? null,
    parentName: row.parent_name ?? null,
    maxOrderDiamonds: row.max_order_diamonds,
    dailyDiamondLimit: row.daily_diamond_limit,
    dailyOrderLimit: row.daily_order_limit,
    // The hash never leaves the table; the panel only needs to know whether to offer
    // "send credentials" or "reset password".
    hasCredential: Boolean(row.password_hash),
    approvedAt: row.approved_at ? iso(row.approved_at) : null,
    suspendedReason: row.suspended_reason,
    lastLoginAt: row.last_login_at ? iso(row.last_login_at) : null,
    createdAt: iso(row.created_at),
  };
}

export function toCommissionRule(row: CommissionRuleRow): CommissionRuleDto {
  return {
    id: row.id,
    kind: row.kind,
    beneficiary: row.beneficiary,
    appliesToId: row.applies_to_id,
    appliesToCode: row.applies_to_code ?? null,
    rulesVersion: row.rules_version,
    percentBps: row.percent_bps,
    fixedCents: row.fixed_cents,
    tiers: row.tiers,
    minOrderCents: row.min_order_cents,
    maxOrderCents: row.max_order_cents,
    currency: row.currency,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: row.effective_to ? iso(row.effective_to) : null,
    isActive: row.is_active,
    note: row.note,
  };
}

export function toRechargeOrder(
  row: RechargeOrderRow & { seller_code?: string; seller_name?: string; bd_code?: string; username?: string },
): RechargeOrderDto {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    sellerId: row.seller_id,
    sellerCode: row.seller_code ?? '',
    sellerName: row.seller_name ?? 'unknown',
    bdId: row.bd_id,
    bdCode: row.bd_code ?? null,
    userId: row.user_id,
    username: row.username ?? 'unknown',
    diamonds: row.diamonds,
    amountCents: cents(row.amount_cents),
    feeCents: cents(row.fee_cents),
    currency: row.currency,
    paymentMethod: row.payment_method,
    paymentRef: row.payment_ref,
    provider: row.provider,
    evidence: row.evidence ?? {},
    rulesSnapshot: row.rules_snapshot ?? {},
    transactionId: row.transaction_id,
    decisionNote: row.decision_note,
    reversalReason: row.reversal_reason,
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    verifiedAt: row.verified_at ? iso(row.verified_at) : null,
    createdAt: iso(row.created_at),
  };
}

export function toCommissionEntry(row: CommissionEntryRow): CommissionEntryDto {
  return {
    id: row.id,
    orderReference: row.order_reference ?? '',
    beneficiary: row.beneficiary,
    beneficiaryId: row.beneficiary_id,
    beneficiaryCode: row.beneficiary_code ?? null,
    beneficiaryName: row.beneficiary_name ?? null,
    kind: row.kind,
    ruleVersion: row.rule_version,
    status: row.status,
    basisCents: cents(row.basis_cents),
    amountCents: cents(row.amount_cents),
    currency: row.currency,
    reversedAt: row.reversed_at ? iso(row.reversed_at) : null,
    reversalReason: row.reversal_reason,
    settlementReference: row.settlement_reference ?? null,
    settledAt: row.settled_at ? iso(row.settled_at) : null,
    createdAt: iso(row.created_at),
  };
}

export function toCommissionSettlement(row: CommissionSettlementRow): CommissionSettlementDto {
  return {
    id: row.id,
    reference: row.reference,
    beneficiary: row.beneficiary,
    beneficiaryId: row.beneficiary_id,
    currency: row.currency,
    amountCents: cents(row.amount_cents),
    entryCount: row.entry_count,
    status: row.status,
    periodFrom: iso(row.period_from),
    periodTo: iso(row.period_to),
    payoutMethod: row.payout_method,
    paidAt: row.paid_at ? iso(row.paid_at) : null,
    note: row.note,
    createdAt: iso(row.created_at),
  };
}
 
export type RechargePackageDto = {
  key: string;
  label: string;
  diamonds: number;
  amountCents: number;
  currency: string;
  feeBps: number;
  /** Paisa per diamond, so a seller or an admin can compare tiers without doing the math. */
  unitPriceCents: number;
  isActive: boolean;
};

export function toRechargePackage(row: RechargePackageRow): RechargePackageDto {
  return {
    key: row.key,
    label: row.label,
    diamonds: row.diamonds,
    amountCents: cents(row.amount_cents),
    currency: row.currency,
    feeBps: row.fee_bps,
    unitPriceCents: Math.floor(cents(row.amount_cents) / row.diamonds),
    isActive: row.is_active,
  };
}
