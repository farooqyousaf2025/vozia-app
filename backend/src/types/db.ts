export type UserRow = {
  id: string;
  phone: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
  gender: string | null;
  country_code: string | null;
  diamond_balance: number;
  r_coin_balance: number;
  total_gifts_sent: string | number;
  total_gifts_received: string | number;
  user_type: 'HOST' | 'USER' | 'AGENCY_ADMIN';
  status: 'ACTIVE' | 'BANNED';
  is_verified: boolean;
  vip_level: number;
  /** Lifetime experience (migration 0017). BIGINT, so `pg` hands back a string. */
  xp?: string | number;
  device_token: string | null;
  last_seen_at: Date | null;
  created_at: Date;
};

export type RoomRow = {
  id: string;
  room_number: number;
  title: string;
  description: string | null;
  cover_url: string | null;
  theme: string;
  host_id: string;
  type: 'PUBLIC' | 'PRIVATE';
  password_hash: string | null;
  seat_capacity: number;
  status: 'ACTIVE' | 'CLOSED';
  category: 'POPULAR' | 'PARTY' | 'MUSIC' | 'GAME' | 'CHAT';
  /** Normalized ISO 639-1 tag the room is spoken in; NULL = the host never said. */
  language: string | null;
  /** ISO 3166-1 alpha-2 the room targets; NULL = unstated. */
  region: string | null;
  /** Host-written house rules shown in the room; never a moderation record. */
  rules: string | null;
  livekit_room_name: string;
  listener_count: number;
  like_count?: string | number;
  total_gift_value: string | number;
  created_at: Date;
  closed_at: Date | null;
  // present only on joined queries
  host_username?: string;
  host_avatar_url?: string | null;
};

export type SeatRow = {
  id: string;
  room_id: string;
  seat_index: number;
  user_id: string | null;
  status: 'EMPTY' | 'OCCUPIED' | 'LOCKED';
  is_muted: boolean;
  is_speaker: boolean;
  username: string | null;
  avatar_url: string | null;
};

export type GiftRow = {
  id: string;
  name: string;
  icon_url: string;
  animation_url: string | null;
  sound_url: string | null;
  diamond_price: number;
  r_coin_value: number;
  category: string;
  effect_kind: 'TICKER' | 'FULLSCREEN';
  min_vip_level: number;
  sort_order: number;
  is_active: boolean;
  created_at?: Date;
  updated_at?: Date;
};

export type TransactionRow = {
  id: string;
  type: string;
  status: string;
  sender_id: string | null;
  receiver_id: string | null;
  gift_id: string | null;
  quantity: number;
  amount_diamonds: number;
  amount_r_coins: number;
  sender_diamonds_after: number | null;
  receiver_r_coins_after: number | null;
  room_id: string | null;
  agency_id: string | null;
  note: string | null;
  meta: Record<string, unknown>;
  created_at: Date;
  // joined
  gift_name?: string | null;
  gift_icon_url?: string | null;
  sender_username?: string | null;
  sender_avatar_url?: string | null;
  receiver_username?: string | null;
  receiver_avatar_url?: string | null;
};

export type ParticipantRow = {
  id: string;
  room_id: string;
  user_id: string;
  role: 'HOST' | 'SPEAKER' | 'AUDIENCE';
  seat_index: number | null;
  hand_raised: boolean;
  joined_at: Date;
  username?: string;
  avatar_url?: string | null;
};

export type ChatRow = {
  id: string;
  room_id: string;
  user_id: string | null;
  message_type: 'TEXT' | 'GIFT' | 'SYSTEM';
  content: string;
  created_at: Date;
  username?: string;
  avatar_url?: string | null;
};

export type AdminRow = {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  role: 'SUPER' | 'MODERATOR';
  created_at: Date;
};

export type WithdrawalRow = {
  id: string;
  user_id: string;
  amount_r_coins: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAID';
  payout_method: string;
  payout_details: Record<string, unknown>;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  username?: string;
  avatar_url?: string | null;
};

// ---------------------------------------------------------------------------
// Games. Every money-relevant number a game touches is read from these rows,
// never from the client.
// ---------------------------------------------------------------------------

export type GameSessionStatus = 'WAITING' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'DISPUTED';

export type GameParticipantStatus = 'REQUESTED' | 'JOINED' | 'READY' | 'PLAYING' | 'COMPLETED' | 'LEFT' | 'DISCONNECTED';

export type GameDefinitionRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  min_players: number;
  max_players: number;
  allow_spectators: boolean;
  turn_timeout_seconds: number;
  is_active: boolean;
  entry_fee_enabled: boolean;
  entry_fee_diamonds: number;
  entry_fee_min: number;
  entry_fee_max: number;
  prize_enabled: boolean;
  commission_bps: number;
  prize_rules: unknown;
  refund_policy: 'NONE' | 'CANCELLED' | 'DISPUTED' | 'ALWAYS';
  promo_free_entry: boolean;
  promo_until: Date | null;
  daily_entry_limit: number;
  anti_abuse: Record<string, unknown>;
  rules_version: number;
  created_at: Date;
  updated_at: Date;
};

/** The money rules pinned into a session row. `rules` and `game_rule_snapshots.rules` share it. */
export type PinnedGameRules = {
  entryFeeEnabled: boolean;
  entryFeeDiamonds: number;
  prizeEnabled: boolean;
  commissionBps: number;
  prizeRules: Array<{ rank: number; shareBps: number }>;
  refundPolicy: 'NONE' | 'CANCELLED' | 'DISPUTED' | 'ALWAYS';
  minPlayers: number;
  maxPlayers: number;
  turnTimeoutSeconds: number;
  dailyEntryLimit: number;
  config: Record<string, unknown>;
  rulesVersion: number;
};

export type GameSessionRow = {
  id: string;
  game_key: string;
  definition_id: string;
  room_id: string | null;
  created_by: string;
  status: GameSessionStatus;
  rules_version: number;
  rules: PinnedGameRules;
  entry_fee_diamonds: number;
  max_players: number;
  state: Record<string, unknown>;
  turn_deadline_at: Date | null;
  turn_owner_id: string | null;
  result: Record<string, unknown> | null;
  cancel_reason: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  settlement_status: 'PENDING' | 'SETTLED' | 'PARTIAL' | 'REFUNDED' | 'DISPUTED';
  created_at: Date;
  updated_at: Date;
};

export type GameParticipantRow = {
  id: string;
  session_id: string;
  user_id: string;
  position: number;
  status: GameParticipantStatus;
  score: number;
  tie_break_ms: number;
  rank: number | null;
  entry_fee_diamonds: number;
  fee_transaction_id: string | null;
  refund_transaction_id: string | null;
  prize_diamonds: number;
  joined_at: Date;
  ready_at: Date | null;
  disconnected_at: Date | null;
  last_action_at: Date | null;
  // joined
  username?: string;
  avatar_url?: string | null;
};

export type GameEventRow = {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
};

export type GameSettlementRow = {
  session_id: string;
  game_key: string;
  rules_version: number;
  player_count: number;
  gross_pool: number;
  commission: number;
  prize_pool: number;
  deductions: number;
  distributed: number;
  payouts: unknown;
  refunds: unknown;
  status: 'PENDING' | 'SETTLED' | 'PARTIAL' | 'REFUNDED' | 'DISPUTED';
  settled_at: Date;
};

export type CommissionAllocationRow = {
  id: string;
  kind: string;
  source_id: string;
  gross_amount: number;
  currency: 'diamond' | 'r_coin';
  host_user_id: string | null;
  host_share: number;
  agency_id: string | null;
  agency_share: number;
  platform_share: number;
  rules_version: number;
  rule_snapshot: Record<string, unknown>;
  status: 'CALCULATED' | 'SETTLED' | 'REVERSED';
  transaction_ids: unknown;
  created_at: Date;
};

export type GameDisputeRow = {
  id: string;
  session_id: string;
  raised_by: string;
  reason: string;
  status: 'OPEN' | 'UNDER_REVIEW' | 'UPHELD' | 'REJECTED' | 'REFUNDED';
  resolution: string | null;
  reviewed_by: string | null;
  created_at: Date;
  reviewed_at: Date | null;
  username?: string;
  avatar_url?: string | null;
};

// ---------------------------------------------------------------------------
// BD / coin-seller domain (migration 0004). `amount_cents` columns are BIGINT, so
// node-postgres hands back a string; every mapper must coerce explicitly.
// ---------------------------------------------------------------------------

export type BusinessAccountKind = 'BD_MANAGER' | 'BD_AGENT' | 'COIN_SELLER';
export type BusinessAccountStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export type BusinessAccountRow = {
  id: string;
  kind: BusinessAccountKind;
  code: string;
  display_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  password_hash: string | null;
  parent_id: string | null;
  status: BusinessAccountStatus;
  market_country: string | null;
  max_order_diamonds: number;
  daily_diamond_limit: number;
  daily_order_limit: number;
  approved_by: string | null;
  approved_at: Date | null;
  suspended_reason: string | null;
  created_by: string | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  parent_code?: string | null;
  parent_name?: string | null;
};

export type CommissionRuleKind = 'SELLER_PERCENT' | 'SELLER_FIXED' | 'SELLER_TIER' | 'BD_PERCENT' | 'BD_FIXED';
export type CommissionBeneficiary = 'SELLER' | 'BD' | 'PLATFORM' | 'PROVIDER';

export type CommissionRuleRow = {
  id: string;
  kind: CommissionRuleKind;
  beneficiary: CommissionBeneficiary;
  applies_to_id: string | null;
  rules_version: number;
  percent_bps: number | null;
  fixed_cents: number | null;
  tiers: Array<{ uptoCents: number; percentBps?: number; fixedCents?: number }> | null;
  min_order_cents: number | null;
  max_order_cents: number | null;
  currency: string;
  effective_from: Date;
  effective_to: Date | null;
  is_active: boolean;
  created_by: string | null;
  note: string | null;
  created_at: Date;
  applies_to_code?: string | null;
};

export type RechargeOrderStatus =
  | 'AWAITING_PAYMENT'
  | 'AWAITING_VERIFICATION'
  | 'CREDITED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REVERSED';

export type RechargeOrderRow = {
  id: string;
  reference: string;
  seller_id: string;
  bd_id: string | null;
  user_id: string;
  package_key: string | null;
  diamonds: number;
  amount_cents: string | number;
  currency: string;
  payment_method: string;
  payment_ref: string | null;
  provider: string | null;
  external_id: string | null;
  evidence: Record<string, unknown>;
  status: RechargeOrderStatus;
  rules_snapshot: Record<string, unknown>;
  fee_cents: string | number;
  transaction_id: string | null;
  verified_by: string | null;
  verified_at: Date | null;
  decision_note: string | null;
  reversed_at: Date | null;
  reversal_reason: string | null;
  reverses_amount_cents: string | number | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type CommissionEntryStatus = 'ACCRUED' | 'REJECTED' | 'SETTLED' | 'REVERSED';

export type CommissionEntryRow = {
  id: string;
  recharge_order_id: string;
  beneficiary: CommissionBeneficiary;
  beneficiary_id: string | null;
  kind: CommissionRuleKind;
  rule_id: string | null;
  rule_version: number;
  status: CommissionEntryStatus;
  basis_cents: string | number;
  amount_cents: string | number;
  currency: string;
  reversed_at: Date | null;
  reversal_reason: string | null;
  settled_at: Date | null;
  created_at: Date;
  settlement_reference?: string | null;
  beneficiary_code?: string | null;
  beneficiary_name?: string | null;
  order_reference?: string | null;
};

export type CommissionSettlementRow = {
  id: string;
  reference: string;
  beneficiary: CommissionBeneficiary;
  beneficiary_id: string;
  currency: string;
  amount_cents: string | number;
  entry_count: number;
  status: 'DRAFT' | 'APPROVED' | 'PAID' | 'VOID';
  period_from: Date;
  period_to: Date;
  payout_method: string | null;
  payout_details: Record<string, unknown>;
  created_by: string | null;
  approved_by: string | null;
  paid_at: Date | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
};

export type SystemConfigRow = {
  key: string;
  value: Record<string, unknown>;
  description: string | null;
  updated_by: string | null;
  updated_at: Date;
};

export type FinAccountRow = {
  code: string;
  name: string;
  kind: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  currency: string;
  normal_side: 'DEBIT' | 'CREDIT';
};
 
export type RechargePackageRow = {
  key: string;
  label: string;
  diamonds: number;
  amount_cents: string | number;
  currency: string;
  fee_bps: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

export type MediaAssetRow = {
  id: string;
  kind: string;
  file_name: string;
  stored_name: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  url: string;
  width: number | null;
  height: number | null;
  uploaded_by: string | null;
  created_at: Date;
};

export type VisualEffectRow = {
  key: string;
  kind: 'AMBIENT' | 'WELCOME';
  name: string;
  url: string;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
};

export type RoomThemeRow = {
  slug: string;
  name: string;
  /** CHAR(7) arrives padded, so read it through `trim()` wherever it is compared or rendered. */
  accent: string;
  wallpaper_url: string;
  is_default: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
};

/** `emoji_characters` (migration 0016) — one glyph the chat picker offers. */
export type EmojiRow = {
  key: string;
  label: string;
  url: string;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
};

export type RoomCategoryEffectRow = {
  category: string;
  effect_key: string;
  updated_at: Date;
};

/** `rank_levels` (migration 0017) — one rung of the earned-level ladder. */
export type RankLevelRow = {
  level: number;
  name: string;
  badge_url: string;
  /** CHAR(7) arrives padded; read it through `trim()` wherever it is compared or rendered. */
  accent: string;
  /** BIGINT, so `pg` hands back a string. */
  min_xp: string | number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};
