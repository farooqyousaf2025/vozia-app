# Voiza

Open-source audio party room platform — multi-user voice rooms with seats, virtual
gifting, a diamond/R-coin wallet economy, agencies with commission splits, and a
back-office admin panel.

```
vozia/
├── docker-compose.yml      postgres + redis + livekit + backend + admin panel
├── livekit.yaml            SFU tuned for low-latency audio
├── backend/                Node.js + TypeScript (Express, Socket.IO, LiveKit SDK, pg, ioredis)
│   ├── src/{config,controllers,services,routes,middleware,utils,types}
│   └── database/{schema.sql,seed.sql,migrations/}
├── admin-panel/            React + Vite + Tailwind CSS dashboard
└── android/                Native Android app (Kotlin, Jetpack Compose, Material 3, MVVM)
```

## Quick start

```bash
cp .env.example .env          # then edit the secrets
docker compose up --build     # schema + pending migrations apply themselves on boot
```

| Service       | URL / port                          |
| ----------- | ----------------------------------- |
| API           | `http://localhost:4000`             |
| Socket.IO     | `http://localhost:4000` (`/socket.io`) |
| LiveKit       | `ws://localhost:7880`, RTC `7881`, media `50000-60000/udp` |
| Admin panel   | `http://localhost:5173`             |
| PostgreSQL    | `localhost:5432`                    |
| Redis         | `localhost:6379`                    |

Demo content (agency, hosts, three live rooms) lives in `backend/database/seed.sql`.
On every boot the backend container runs `scripts/migrate.cjs`, which applies the
idempotent `schema.sql` baseline and then any file in `database/migrations/` this
database has not already recorded — so re-deploying onto a volume that has users in it
brings the schema forward instead of leaving it behind. It loads the seed as well while
`SEED_DEMO_DATA=1`, which is the compose default. Set it to `0`
for a clean stack, or apply the seed by hand later:

```bash
psql "$DATABASE_URL" -f backend/database/seed.sql
```

### Signing in

Auth is phone + OTP. With `SMS_PROVIDER=mock` (the default outside production) no text
is sent: codes are logged to the backend console, the verify request also returns them
as `devCode`, and setting `OTP_MOCK_CODE` pins every code to that value — which is what
`.env.example` does so the demo can sign in. Any other value of `SMS_PROVIDER` makes
`/request-otp` send a real SMS and drop `devCode`.

```bash
curl -s localhost:4000/api/auth/request-otp -H 'content-type: application/json' \
  -d '{"phone":"+15550000001"}'
curl -s localhost:4000/api/auth/verify-otp -H 'content-type: application/json' \
  -d '{"phone":"+15550000001","code":"123456"}'
```

Admin panel: `admin` / `voiza-admin` (from `ADMIN_USERNAME` / `ADMIN_PASSWORD`), or
the OTP bootstrap path — `POST /api/auth/verify-otp` with
`ADMIN_BOOTSTRAP_PHONE` + `ADMIN_BOOTSTRAP_OTP` returns an admin-scoped token.

## Wallet economy

| Token   | Who holds it | How it is earned                                   | How it is spent             |
| ------- | ------------ | -------------------------------------------------- | --------------------------- |
| Diamond | Listener     | `POST /api/wallet/recharge/checkout` + Stripe hook | Buying gifts                |
| R-coin  | Host         | Receiving gifts                                    | `POST /api/wallet/withdraw` |

In a `PAYMENTS_PROVIDER=simulated` stack (the default here, so the demo can top up
without a Stripe account) `POST /api/wallet/recharge` credits balance directly, and
that is the only free path. With `PAYMENTS_PROVIDER=stripe` it returns
`403 payments_provider_is_stripe`; only a signature-verified
`payment_intent.succeeded` webhook can credit a wallet, and `payment_proofs`
(`UNIQUE (provider, external_id)`, written in the same transaction as the credit) makes
a webhook redelivery a no-op rather than a second top-up. Balances then reach the
client over the private `wallet:update` event, which the Android session store folds
into the cached user — the diamond chip and wallet screen update without a reload.

Gift sends are a single SQL transaction with `SELECT ... FOR UPDATE` on both
accounts, so a balance can never go negative and a double-tap cannot double-spend.
Every movement writes a `transactions` row with post-image balances for audit.
Agency commission is written as its own ledger row (`AGENCY_COMMISSION`) so host
earnings are attributable without touching the host's balance.

Gifts also carry a **spend tier** (`gifts.min_vip_level` vs `users.vip_level`,
0–20). The ledger checks the tier *before* the balance, so a VIP-0 account buying a
tier-5 gift gets `403 vip_required` with `{required, current, giftName}` and no
money moves, rather than a top-up nudge it can never satisfy. Tiers are assigned by
an operator only (`POST /api/admin/users/:id/vip`, exposed as the VIP column in the
Users page) — there is no self-service route, which is what makes the tier mean
something.

## Notifications

Two layers, neither of which needs a third-party account to work:

* **In-app / backgrounded Android**: `VoizaNotifier` observes the room socket and
  posts a heads-up notification for a gift addressed to you, an operator warning or
  a kick, but only while the app is not foregrounded (so the room screen never
  double-reports). Android 13+ asks for `POST_NOTIFICATIONS` once at startup.
* **Server push (FCM v1)**: `backend/src/services/push.service.ts` sends a private
  gift and every withdrawal decision (approved / rejected, with the escrow returned
  on rejection). Registration is `PUT /api/auth/me/device-token`; the service is
  env-gated — with `FCM_PROJECT_ID` / `FCM_SERVICE_ACCOUNT_FILE` unset it logs a
  no-op and the gift still returns 201, so push is never on the money path.
  See `.env.example` for the three-step Firebase enablement.

## Voice architecture

* LiveKit SFU is self-hosted (container `voiza-livekit`).
* The backend mints short-lived access tokens per participant:
  **host and seated speakers get publisher rights, audience gets subscriber-only**.
* `POST /api/rooms/:id/livekit-token` re-issues a token whenever a seat changes.
* Taking, leaving or losing a seat also flips `canPublish` on the live SFU
  participant, so a client that never re-dials still gains or loses the microphone.
* A host mute flips the seat flag *and* revokes `canPublish` at the SFU, so muted
  clients cannot keep talking.
* LiveKit webhooks (`POST /api/livekit/webhook`) reconcile rooms after dropped
  phones: `room_finished` closes the room, `participant_left` vacates the seat.

## Deployment notes (VPS)

1. Set `NODE_ENV=production` (compose defaults to `development` so the demo can log in
   without an SMS gateway) and put real secrets in `.env`: `JWT_SECRET`,
   `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
   (must match the `keys:` map in `livekit.yaml`), `ADMIN_PASSWORD`, `POSTGRES_PASSWORD`,
   and pin `CORS_ORIGIN`. The backend refuses to boot in production while any of them
   still hold their development default.
2. Clear `OTP_MOCK_CODE` and set a real gateway: `SMS_PROVIDER=twilio` or `vonage`
   plus its credentials (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER`
   or `VONAGE_API_KEY`/`VONAGE_API_SECRET`) — see
   `backend/src/services/sms.service.ts`. Both call the provider over plain `fetch`,
   so no SDK or extra dependency is involved. Production refuses to boot on
   `SMS_PROVIDER=mock`, and a failed send now returns `502 sms_send_failed` instead of
   telling the user a text was sent.
3. Set `PAYMENTS_PROVIDER=stripe` with `STRIPE_SECRET_KEY` and
   `STRIPE_WEBHOOK_SECRET`, then point a Stripe webhook at
   `POST /api/payments/stripe/webhook`. Until then the stack mints diamonds through
   the simulated `POST /api/wallet/recharge`, which is why production refuses to boot
   on `PAYMENTS_PROVIDER=simulated`. Test mode (`sk_test_…`) works end to end with the
   Stripe CLI forwarding events. Note the Android wallet screen still calls the
   simulated endpoint, so a Stripe build needs that client call replaced by the
   checkout + webhook flow before it can take money.
4. WebRTC needs `50000-60000/udp` open on the host firewall. If your network blocks
   outbound UDP, clients fall back to RTC-over-TCP on `7881`; set
   `rtc.use_external_ip: true` when the VPS has a public IPv4.
5. `LIVEKIT_PUBLIC_URL` is the address phones dial (not the docker-internal one).
6. Push is off until you add a Firebase project: set `FCM_PROJECT_ID` and point
   `FCM_SERVICE_ACCOUNT_FILE` at its service-account JSON (never commit that file).
   Until then `push.service.ts` logs and returns, and Android keeps notifying from
   the socket.
7. Release APKs are signed from `android/keystore.properties` (git ignored; see
   `keystore.properties.example`). Generate the keystore once and back it up —
   losing it means losing the Play listing, not just the build. The client ships TLS
   only: the release variant's network security config forbids cleartext, so
   `VOIZA_API_BASE_URL` must be `https://` and `VOIZA_LIVEKIT_URL` must be `wss://`.

## API surface

`GET /health` · auth `POST /api/auth/{request-otp,verify-otp}`, `GET|PATCH /api/auth/me`,
`PUT /api/auth/me/device-token`
· rooms `GET|POST /api/rooms` (list accepts `search`, `category`, `language`, `region`, `sort=default|popular|trending|recent`, `limit`/`offset`),
`GET /api/rooms/{id,capacity,mine,quick-join}`, `PATCH|DELETE /api/rooms/{id}`, `POST /api/rooms/:id/{join,leave,close,hand-raise,livekit-token}`,
`POST /api/rooms/:id/seat[/:index/{leave,lock,mute,kick}]`
· gifts `GET /api/gifts`, `POST /api/gifts/send`
· wallet `GET /api/wallet`, `POST /api/wallet/{recharge,recharge/checkout,withdraw}`, `GET /api/wallet/withdrawals`
· payments `POST /api/payments/stripe/webhook` (Stripe calls this, not the app)
· users `GET /api/users/:id`, `GET /api/users/top?window=day|week|month&role=receivers|senders&limit=`
· admin `POST /api/admin/login`, `GET /api/admin/stats|users|rooms|gifts|withdrawals`,
`POST /api/admin/users/:id/vip` and the matching mutation routes.

Socket.IO events: client sends `room:join`, `room:leave`, `room:chat`, `room:like`,
`room:raise_hand`; server sends `room:chat_message`, `room:gift_animated`,
`room:seat_update`, `room:listener_count`, `room:user_joined`, `room:user_left`,
`room:mic_toggle`, `room:hand_raise`, `room:liked`, `room:theme_changed`,
`room:profile_updated`, `room:closed`, `room:kicked` and `room:warning` (private channel), `wallet:update`,
`withdrawal:update`, `account:status`, `room:error`. There is no third-party chat or
live-room service behind any of it — the Android client's ticker, takeover queue,
heart layer, entry banner and ranking sheet are its own Compose, driven by these
events and by the asset URLs this API serves from `backend/public/`.

## Room effects

`room:like { roomId, count }` is buffered per room for one second and comes back as a
single `room:liked { roomId, count, total, user }` batch, so twelve taps are one
broadcast instead of twelve and every viewer draws the same number (`total` is
server-side; Postgres keeps the durable copy on `rooms.like_count`). Gifts carry an
`effect_kind` — `TICKER` for the small ones, `FULLSCREEN` for the expensive scenes —
that only an operator can set, and each room payload names the ambient loop
(`ambientEffect`) that category wears. `GET /api/users/top` ranks either side of the
same ledger (`role=receivers` for r-coins earned, `role=senders` for diamonds spent)
and says which in `unit`. See `backend/README.md` → *Room effects are the server's
call*.

What a room looks like is the operator's call too, and it is data rather than a build
artefact: `room_themes`, `visual_effects` and `room_category_effects` (migration `0015`)
hold the themes a host may pick, the loops an AMBIENT or WELCOME slot may play and which
loop each category wears, all editable from the panel's **Decoration** screen. Every room
payload therefore carries a resolved `themeWallpaper` URL next to its `theme` slug — an
operator's art can live at `/uploads/<uuid>.png`, so a client that derived
`/themes/<slug>/wallpaper.png` from the slug would 404 on a file that exists. See
`backend/README.md` → *Room decoration is data*.

The chat emoji picker follows the same rule, one step further: a message stores the **token**
(`[smile]`) and never the picture, so `chat_messages` survives an operator retiring a code or
replacing its art. `emoji_characters` (migration `0016`, art imported from TUILiveKit and
chat-uikit-android under their MIT/Apache-2.0 licences — see `NOTICE.md`) is edited from the
panel's **Chat emoji** screen, `GET /api/emoji` publishes the rows plus the `codePattern` the
server itself scans with, and the phone compiles that pattern instead of a copy that could
drift. A code with no row stays as written text. See `backend/README.md` → *Chat emoji: the
database is the catalogue*.

Levels are data as well, and they are the one number a member cannot talk themselves into.
`rank_levels` (migration `0017`) holds 21 rungs — a floor in XP, a name, a badge URL and an
accent colour — edited from the panel's **Level ladder** screen, and `users.xp` only moves
inside the ledger write that posts a gift: 1 experience per diamond spent, 0.5 per R-coin
earned. `GET /api/ranks` publishes the ladder and every user payload carries the rung it
resolves to, so a phone paints `rank.name` and `rank.badge` and holds no threshold of its own.
The spend tier is a separate, deliberately unearned thing: `users.vip_level` is what
`gifts.min_vip_level` gates on and what sizes an entry banner, an operator assigns it, and no
amount of XP moves it. See `backend/README.md` → *The level ladder is data too*.

## Finding a room

A room carries a host-editable profile — title, description, category, `language`
(ISO 639-1, e.g. `en`), `region` (ISO 3166-1 alpha-2, e.g. `BD`) and a `rules` line
the client shows to everyone inside. The lobby never re-sorts the rows it already
has: `search`, `category`, `language`, `region` and `sort` are query parameters that
Postgres answers, `GET /api/rooms/mine` is the My Room shortcut, and
`GET /api/rooms/quick-join` is the server's pick among the public rooms the caller can
actually enter. A `PATCH /api/rooms/:id` therefore broadcasts `room:profile_updated`
with the profile as it now stands (a cleared field arrives as `null`, not as
"unchanged"), so members see the new title and rule line without leaving.
`DELETE /api/rooms/:id` is refused for any room somebody has stood in or that money
has moved through — see `backend/README.md` → *Room profile and discovery*.

## Verification

* `cd backend && npm run test:e2e` — 154 checks against a running stack (real Postgres,
  Redis, LiveKit and this API): OTP auth, ledger double-spend under concurrency, seat
  row-lock contention, the seat policy (a new room gets the administrator's default, a
  rewrite is audited, and a guest can take a seat far beyond the old hardcoded nine),
  the room profile (a malformed language or region tag and an over-long rules line are
  refused, only the host may edit, a server-side search/sort returns what Postgres
  ranked rather than what the client assumed, Quick Join hands back a joinable public
  room, and delete is refused for an active or historically-funded room), the edit
  broadcast that reaches a connected socket, SFU
  token/grant enforcement, Socket.IO fan-out, the entry notice
  and its once-a-minute dedupe, like batching (twelve taps, fewer than twelve
  broadcasts, exact sum), the two ranking boards read against the same ledger
  aggregate, webhook trust,
  the VIP spend tier (refused before the balance, unlocked by an operator raise),
  push-token registration, and the Stripe recharge path (unsigned/forged/stale hooks
  rejected, a signed success credited once, a redelivery credited nothing, an
  unreferenced payment crediting nobody). Re-runnable; it cleans up the accounts and
  gifts it creates.
* `cd backend && npm run test:sms` and `npm run test:payments` — 16 and 29 checks with
  `fetch` replaced by a recorder, so no account is needed: the exact Twilio form POST
  and Basic header, Vonage's `200`-with-`status:"1"` trap, the Stripe intent body, and
  every webhook-signature rejection. Together with the e2e suite that is 199 checks.
* `cd backend && npm run test:wire-fixtures` and `npm run test:game-wire-fixtures`,
  then `cd android && ./scripts/run-dto-harness.sh`
  replays the captured live payloads through the mobile client's own Gson DTOs — 44
  assertions covering every REST envelope, the gift/like/theme/seat/profile socket events, the
  three live game boards, the seat range the client is told to offer, and the Gson trap
  where an absent key lands as null instead of
  the declared default. A response shape change fails in seconds rather than as an NPE on
  a phone.
* `cd android && ./gradlew testDebugUnitTest` — 54 JVM tests over the DTO→domain
  mappers (unknown enums, absent keys, Gson's skipped default initialisers), the game
  boards and the client's copy of the engine's seat rules, the gift
  purchase guard, and the effect queue policy (takeover depth and eviction, ticker
  trim, entry tiers, panel paging).
* `.github/workflows/ci.yml` runs all of the above plus `assembleDebug` and an
  unsigned `assembleRelease` (R8 + resource shrinking + lint) on real service
  containers.
* `cd backend && npm run assets:generate` — regenerates the placeholder gift/avatar art
  served from `public/`; clients prefix it with the API origin.
* `cd backend && npm run demo:gifts -- +15550000010` — seeds a demo room (host avatar,
  seats, three gifts, one chat line) and prints the dev OTP, so a phone or emulator can
  log in and see populated screens immediately.

## Components

* [Backend](backend/README.md) — API, ledger, realtime, LiveKit integration
* [Admin panel](admin-panel/README.md) — moderation, virtual-store management and the media
  library operators upload gift art, sounds, room effects and rank badges through
* [Android app](android/README.md) — native Kotlin/Compose client

## License

AGPL-3.0-only. See [NOTICE.md](NOTICE.md) for the room-effect credit
(`Tencent-RTC/TUILiveKit`, MIT — behaviour only: no code, no SDK, no API calls) and
the provenance of everything served from `backend/public/`.
