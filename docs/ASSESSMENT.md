# Voiza — Repository Assessment, Gap Analysis and Implementation Plan

Written against the programme brief in `PROJECT` (Vola-style audio party + integrated coin
games). Everything under *Existing* was read out of the code, not assumed; everything under
*Tests* was executed on this machine, with the counts recorded in §4.

## 1. Repository assessment (what exists today)

### Stack, as found

| Layer | Reality in this repo |
| --- | --- |
| Backend | Node + TypeScript, Express, Socket.IO, `pg` (no ORM), ioredis. `src/{config,controllers,services,routes,middleware,utils,types}` — 5,531 lines |
| Database | PostgreSQL 16. `database/schema.sql` (idempotent, re-appliable) + `seed.sql` |
| Voice | Self-hosted LiveKit SFU (`docker-compose.yml`, `livekit.yaml`); tokens minted server-side only |
| Admin | React + Vite + Tailwind, 7 pages: login, overview, users, rooms, room console, gifts, withdrawals |
| Android | Kotlin + Compose Material 3 + MVVM, hand-written DI, Retrofit/Gson, `io.socket:socket.io-client`, `livekit-android`, min 24 / target 35 |
| Realtime | Own Socket.IO server on the API origin. No third-party chat service anywhere |
| CI | `.github/workflows/ci.yml` — typecheck, build, e2e against service containers, provider contracts, unit tests, `assembleDebug`, unsigned `assembleRelease`, DTO harness |

### Data model (14 tables)

`agencies`, `users`, `otp_codes`, `admins`, `rooms`, `room_seats`, `room_participants`,
`room_bans`, `gifts`, `transactions`, `agency_hosts`, `chat_messages`,
`withdrawal_requests`, `payment_proofs`.

Money: `users.diamond_balance` (spend) and `users.r_coin_balance` (earn), both
`CHECK >= 0`; every movement is a `transactions` row with post-image balance snapshots and
`WITHDRAWAL` escrow → `RECHARGE`/`GIFT_SENT`/`ADMIN_ADJUSTMENT`/`AGENCY_COMMISSION`/`SEAT_FEE`
types. `ledger.service.ts` is the only module that touches a balance, always inside
`withTransaction` with `FOR UPDATE` row locks taken in a stable id order.
`payment_proofs` is `UNIQUE (provider, external_id)`, written in the same transaction as the
credit — a redelivered Stripe webhook credits nobody.

### Behaviour already implemented and verified

- Phone + OTP auth (mock/Twilio/Vonage over plain `fetch`), JWT, admin JWT + bootstrap phone.
- Rooms: public/private/password, room number deep join, categories, themes
  (`GET /api/rooms/themes` is the operator registry), create/close, seat take/leave/lock/mute/kick,
  hand raise, bans (room-scoped, timed or permanent), audience roster, chat with SYSTEM lines,
  listener counts, listener-count recompute, LiveKit webhook reconciliation
  (`room_finished`, `participant_left`), SFU-side `canPublish` revocation on mute/seat loss.
- Seat capacity is an administrator setting, not a constant: `system_config` key `rooms.seats`
  holds `{speakerSeats, maxSpeakerSeats}` (shipped default 15/32), `GET /api/rooms/capacity`
  publishes the resulting min/default/max to clients, `GET|PUT /api/admin/rooms/seat-policy`
  reads and writes it (PUT needs `config:manage` and self-audits), and the schema keeps a hard
  ceiling of 64 seats that no config value can exceed. No client or service hardcodes a count.
- Gifts: catalogue with price/payout/category/`min_vip_level`/`sort_order`/`sound_url`/
  `animation_url`/`effect_kind`, VIP gate enforced before the balance, quantity 1–999,
  hourly rate limit, agency commission as its own ledger row, room-wide animation events.
- Wallet: history + aggregates, simulated recharge (isolated behind `PAYMENTS_PROVIDER`),
  Stripe checkout + signature-verified idempotent webhook, withdrawal request/approve/reject
  with escrow return, admin balance adjustments with audit note.
- Realtime: `room:join/leave/chat/like/raise_hand` in, and
  `room:chat_message/gift_animated/seat_update/listener_count/user_joined/user_left/mic_toggle/hand_raise/liked/theme_changed/closed/kicked/warning/error`,
  `wallet:update`, `withdrawal:update`, `account:status` out. Likes are buffered per room and
  flushed as one counted batch per second; entry notices are deduped to one per minute.
- Effects: gift ticker vs full-screen takeover, ambient loop per room category, entry banner
  tiered by VIP, heart layer, gifter/earner ranking boards — all first-party (see `NOTICE.md`).
- Rankings: `GET /api/users/top?window=day|week|month&role=receivers|senders`.
- Notifications: socket-driven Android notifier + env-gated FCM v1 push (gift, withdrawal).
- Security: env validation with a production boot guard, scrypt password/OTP hashing, helmet,
  CORS pinning, request size limits, per-route rate limits, admin-only routes behind
  `requireAdmin`, log redaction of tokens/OTPs.

### Known weak points (before the new work)

1. **Seat capacity is capped at 12** (`rooms.seat_capacity CHECK BETWEEN 1 AND 12`,
   `room_seats.seat_index CHECK 0..11`) — the brief asks for a 15 default, admin-configurable.
   *(Closed: migration `0012_room_seat_policy.sql` plus the policy above.)*
2. **No game domain at all.** `SEAT_FEE` exists as an enum value but nothing writes it; there is
   no session, participant, event, settlement, dispute or platform-revenue model.
3. **No versioned migrations.** One idempotent `schema.sql` applied whole; nothing records which
   change reached which database.
4. **No social graph**: no follows, blocks (only room bans), reports, levels/XP, profile frames.
5. **No coin packages table** — recharge amounts are free-form integers.
6. **Commission rules are per-agency-host `commission_bps`**, not versioned, so a historical
   statement cannot be reproduced after an operator changes the rate.
7. **Android wallet still calls the simulated recharge endpoint**; Play Billing is not integrated.
8. **Deployment is compose-only**: no reverse proxy/TLS service, no backup/restore runbook.

## 2. Feature gap analysis against the brief

Legend: ✅ exists and is tested · 🟡 exists, needs extension · ❌ missing.

| Brief section | Status | What is missing concretely |
| --- | --- | --- |
| §3 Room creation/discovery | 🟡 | Pinned announcement and favorites. Done: `language`/`region`/`rules` on the room and editable, server-side search + trending/recent ordering, Quick Join, My Room, host edit/delete with the history gate, `room:profile_updated` broadcast (capacity default 15 + admin-configurable ceiling was #33) |
| §3 Seat controls | 🟡 | Ownership transfer, speaker invitation, host approval of speaker requests (today `OCCUPIED` is self-service), disconnect cleanup exists but needs an idle-seat sweeper; an open room keeps the seats it was created with (a policy change only applies to new rooms) |
| §3 LiveKit | 🟡 | Connection-quality indicator, device/Bluetooth selection, foreground service for background audio, reconnect policy surfaced to UI |
| §4 Realtime | ✅ | Game state/invitation events are the only additions needed |
| §5 Profiles, levels, VIP | 🟡 | XP/levels, follows, online status beyond `last_seen_at`, block/report, profile frames, host application workflow |
| §6 Coin economy | 🟡 | Coin packages, receipts/reversal workflow, daily/monthly spend limits, idempotency keys on money mutations |
| §6 Gifts | ✅ | — |
| §7 Games | ❌ | Everything: framework, sessions, lifecycle, three games |
| §8 Anti-cheat | ❌ | Server RNG, server timers, action validation, event log, at-most-once settlement, dispute review |
| §9 Host/agency/commission | 🟡 | Versioned commission rule sets, host dashboard, agency owner/manager accounts, precedence + "cannot allocate more than available" guard, reconciliation preview |
| §10 Admin panel | 🟡 | Game management, economy packages, commission rules, system config (feature flags, maintenance mode, rate limits, LiveKit status), richer dashboard |
| §11 Android | 🟡 | Splash/onboarding, other-user profile, follow/block/report UI, game lobby + three game screens without dropping the LiveKit call (lobby search/sort/Quick Join/My Room and the room edit screen are done) |
| §12 API/architecture | 🟡 | `games`, `game-settlement`, `commissions`, `moderation`, `audit` service modules |
| §13 Database | ❌ | Game tables + versioned migrations |
| §14 Payments/withdrawals | 🟡 | Play Billing path, refund/reversal workflow, withdrawal eligibility rules |
| §15 Security | 🟡 | Audit log table for privileged actions, dependency vulnerability gate, backup/restore procedures |
| §16 Deployment | ❌ | TLS reverse proxy, media port/TURN guidance, volumes, health checks, log rotation, monitoring, migration/rollback runbook |
| §17 Testing | 🟡 | Concurrency tests for seats/spend exist; game settlement idempotency, integration "play a full game", Android game tests are missing |

### Currency mapping decision (brief §6)

The brief's **User Coins** maps onto the existing `diamond_balance` and **Host Earnings** onto
`r_coin_balance`. Balances are *not* merged and no column is renamed: the ledger, the DTOs, the
Android client, the admin panel and 128 live checks all speak diamond/R-coin today, and a silent
rename is exactly the "documented migration" the brief tells me to avoid unless necessary.
New game money reuses those two columns, and **Game Points stay a separate, non-purchasable,
non-withdrawable counter on `game_participants.score`** so they can never leak into the wallet.
The compliance posture the brief requires is implemented as configuration: each game definition
carries `entry_fee_enabled` and `prize_enabled`, both **false** on the shipped rows, so paid
entry and redeemable winnings cannot be turned on until the operator has approved them for the
target market.

## 3. Prioritised implementation checklist

Order is the brief's phase order; each line is a working, testable deliverable, not a stub.

1. **P0 — Migration runner.** `schema_migrations` + `database/migrations/NNNN_*.sql`; adopt an
   existing database without touching data. (#16)
2. **P0 — Game schema.** Sessions, participants, events, settlements, disputes, definitions with
   versioned rules, platform revenue. (#17)
3. **P0 — Engine + settlement.** Lifecycle `WAITING → READY → IN_PROGRESS → COMPLETED`
   (+`CANCELLED`, `DISPUTED`), server RNG/timers, per-game validators, fee reservation, prize pool
   = pool − commission − explicit deductions with deterministic rounding, at-most-once settle. (#18)
4. **P1 — Games.** Tic-Tac-Toe, Quiz Battle, Ludo-style board on the same framework. (#19)
5. **P1 — API + socket.** REST catalog/config/session/action/result, `game:*` events, all
   authorised and rate-limited server-side. (#20)
6. **P1 — Tests.** Fee-once, invalid/duplicate actions, win/draw, prize maths, concurrent settle,
   contract cases in the DTO harness. (#22)
7. **P1 — Android games.** Lobby + three screens, audio preserved across navigation. (#23)
8. **P2 — Rooms/social.** ~~15 configurable seats~~ (done, #33), ~~rules + server-side
   search/trending/recent + Quick Join + My Room + edit/delete~~ (done, #34),
   pins/favorites, follows, block/report, levels/XP, host application. (#24)
9. **P2 — Admin.** Game management, economy packages, versioned commission rules with preview,
   system config, dashboard. (#21)
10. **P2 — Deployment/security.** TLS reverse proxy, media ports, volumes, backups, monitoring,
    rollback runbook, audit trail, dependency gate. (#25)
11. **P3 — Report.** Final report + API docs. (#26)

## 4. Current tests, as executed

| Suite | Command | Result on this machine |
| --- | --- | --- |
| Live end-to-end (128 checks) | `cd backend && npm run test:e2e` | **128/128 pass** — auth, wallet double-spend, seat row-lock contention, seat policy (default from `system_config`, admin rewrite + audit row, a room at the 64-seat ceiling accepted by PostgreSQL), room profile + discovery (language/region/rules validation, server-side search and sort, `mine`, `quick-join`, host-only `PATCH`, the delete gate, and the `room:profile_updated` broadcast read off a connected socket), SFU grants, socket fan-out, entry notice + dedupe, like batching, both ranking boards vs the same ledger aggregate, webhook trust, VIP gate, push token, Stripe path |
| Games engine + money (67) | `npm run test:games` | **67/67 pass** — lifecycle, pinned rule versions, fees, settlement once, timeout forfeit, disputes, the three drivers, RBAC over the rule editor |
| Business accounts (87) | `npm run test:business` | **87/87 pass** — BD/seller accounts and scopes, the nine-step recharge, one-time credit, commission versions and statements, reversals, reconciliation |
| SMS provider contract (16) | `npm run test:sms` | pass — Twilio form POST + Basic header, Vonage `200`/`status:"1"` trap, mock sends nothing |
| Payment provider contract (29) | `npm run test:payments` | pass — intent body, refused intent → 502, every signature rejection |
| Wire/DTO harness (44) | `npm run test:wire-fixtures` + `npm run test:game-wire-fixtures`, then `cd android && ./scripts/run-dto-harness.sh` | **44/44 pass** against payloads captured from the running API, including the three live game boards, the published seat policy cross-checked against a room the server created with no capacity, the discovery/`mine`/`quick-join` envelopes, the `PATCH` response, and the `room:profile_updated` broadcast |
| Android JVM (54) | `cd android && ./gradlew testDebugUnitTest` | 22 room/gift/seat/profile mappers + 11 game mappers + 10 game rules + 6 effect-queue + 5 purchase-guard, 0 failures |
| Builds | `npm run typecheck`, `npm run build`, `:app:assembleDebug`, `:app:assembleRelease`, admin `npm run build` | all green |

Nothing in this programme may weaken a test above to make a build pass; new suites are additive
and the e2e count only ever goes up.
