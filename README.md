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

A cash-out is a three-step decision, not one: `PENDING → APPROVED → PAID`, with
`REJECTED` reachable from either open step. The gross R-coins leave
`users.r_coin_balance` when the host *asks* (escrow) and the `transactions` row
stays PENDING until money actually moves, so accepting a request never reports a
payout that has not happened. `POST /api/admin/withdrawals/:id/pay` requires a
payout reference, flips the ledger row to COMPLETED, and journals the fee — set at
request time from the `accounts.withdrawal` dial (`{minRCoins, feeBps}`) and stored
on the row so a later dial change cannot reprice a decision the host already saw.
`GET /api/wallet` publishes that same dial as `withdrawalPolicy`, and the Android
withdrawal sheet quotes it before the host submits (minimum, fee, and an `≈` net)
then reads back the `feeRCoins` / `netRCoins` the server booked afterwards — the
estimate is always labelled approximate, and only the returned row is a receipt.
The payout itself has no cash leg: there is no bank account or FX rate in this
stack, so the net stays in COIN_LIABILITY and `payout_reference` is the evidence.
See `backend/README.md` → *The withdrawal pipeline (migration 0032)*.

An agency's share of a gift is booked rather than remembered. A send to a host on a
roster writes the `AGENCY_COMMISSION` ledger row *and* a journal entry — DEBIT
COMMISSION_EXPENSE / CREDIT `AGENCY:<uuid>`, priced at the coin face value live at
send time — so what the platform owes a roster is a balance, not a percentage somebody
typed in once. The rate resolves per send in three levels (this host's override, then
this agency's rate, then the `accounts.agency.defaultCommissionBps` dial), and a `NULL`
at any level means inherit rather than zero. Clearing it is a batch: raising one claims
the accruals inside a half-open period, `UNIQUE (entry_id)` makes claiming one twice
impossible at the schema level, `DRAFT → APPROVED → PAID` requires an operator other than
the one who raised it, and only Pay writes the DEBIT `AGENCY:<id>` / CREDIT
PROVIDER_COLLECTIONS entry — approval changes no balance, and a void puts every accrual
back on the table. The panel's Agencies screen is the only route to any of it and never
takes an amount: a payout records a reference for a transfer that already happened
outside this stack. See `backend/README.md` → *An agency's share is booked, then settled
(migration 0033)*.

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
  on rejection, and paid, which names the payout reference). Registration is
  `PUT /api/auth/me/device-token`; the service is
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
   A release build now fails at Gradle configuration time if either is missing, rather
   than quietly shipping the `10.0.2.2` emulator default that reaches nothing from a
   phone (`-PVOIZA_API_BASE_URL=… -PVOIZA_LIVEKIT_URL=…`).
8. The admin panel's `nginx.conf` serves 443 and redirects 80, so it needs a real
   certificate mounted at `/etc/nginx/tls/` and will not start without one. It also
   proxies `/socket.io/` with the `Upgrade` headers the ops console needs — keep that
   block if the file is rewritten. See `admin-panel/README.md`.

## API surface

`GET /health` · auth `POST /api/auth/{request-otp,verify-otp}`, `GET|PATCH /api/auth/me`,
`PUT /api/auth/me/device-token`
· rooms `GET|POST /api/rooms` (list accepts `search`, `category`, `language`, `region`, `sort=default|popular|trending|recent`, `limit`/`offset`),
`GET /api/rooms/{id,capacity,mine,quick-join}`, `PATCH|DELETE /api/rooms/{id}`, `POST /api/rooms/:id/{join,leave,close,hand-raise,livekit-token}`,
`POST /api/rooms/:id/seat[/:index/{leave,lock,mute,kick}]`
· gifts `GET /api/gifts`, `POST /api/gifts/send` (optional `idempotencyKey`),
`GET /api/gifts/history`, `GET /api/rooms/:id/gifts`
· wallet `GET /api/wallet`, `POST /api/wallet/{recharge,recharge/checkout,withdraw}`, `GET /api/wallet/withdrawals`
· banners `GET /api/banners?placement=SPLASH|HOME|GIFT|GAME` (public; omit `placement` for all four at once),
`POST /api/banners/track` (a signed-in member counting one impression or tap)
· payments `POST /api/payments/stripe/webhook` (Stripe calls this, not the app)
· users `GET /api/users/:id`, `GET /api/users/top?window=day|week|month&role=receivers|senders&limit=`,
`GET /api/users/:id/{followers,following,relationship}`, `POST|DELETE /api/users/:id/{follow,block}`,
`POST /api/users/:id/report`, `GET /api/users/blocked`
· room community `GET|POST|DELETE /api/rooms/:id/favorite`, `GET /api/rooms/favorites`,
`POST /api/rooms/:id/announcement`,
`POST /api/rooms/:id/{transfer,seat/:index/invite}`,
`GET /api/rooms/:id/speaker-requests`, `POST /api/rooms/:id/speaker-requests/{cancel,:requestId/approve,:requestId/reject}`
· admin `POST /api/admin/login`, `GET /api/admin/stats|users|rooms|gifts|withdrawals|reports`,
`GET /api/admin/users/:id/social`, `POST /api/admin/reports/:id/review`,
`POST /api/admin/withdrawals/:id/{review,pay}`, `PUT /api/admin/config/accounts.withdrawal`,
`GET /api/admin/agencies` + `/api/admin/agencies/:id`, `PUT /api/admin/agencies/{:id/rate,:id/hosts/:userId/rate}`,
`POST /api/admin/agencies/:id/settlements` and `/api/admin/agencies/settlements/:id/{approve,pay,void}`,
`POST /api/admin/users/:id/vip` and the matching mutation routes.

Socket.IO events: client sends `room:join`, `room:leave`, `room:chat`, `room:like`,
`room:reaction`, `room:raise_hand`; server sends `room:chat_message`, `room:gift_animated`,
`room:gift_history` (the last gifts this room paid for while the socket was down, addressed to the
socket that just joined), `room:seat_update`, `room:listener_count`, `room:user_joined`, `room:user_left`,
`room:mic_toggle`, `room:hand_raise`, `room:liked`, `room:reaction`, `room:theme_changed`,
`room:profile_updated`, `room:closed`, `room:kicked` and `room:warning` (private channel), `wallet:update`,
`withdrawal:update`, `account:status`, `room:error`, plus the community events
`room:announcement`, `room:speaker_request`, `room:speaker_request_updated`,
`room:speaker_decision`, `room:seat_invited`, `room:ownership_transferred`,
`user:followed` and `user:blocked`. There is no third-party chat or
live-room service behind any of it — the Android client's ticker, takeover queue,
heart layer, entry banner and ranking sheet are its own Compose, driven by these
events and by the asset URLs this API serves from `backend/public/`.

## Gift engine

A gift is bought by the backend and only *drawn* by the client. `POST /api/gifts/send` debits
diamonds and credits r-coins in one SQL transaction, prices from `gifts.diamond_price` rather than
whatever the app says, and answers the same `transaction` it created; the app never subtracts a
balance and never sends a price, a balance, an earning or a commission. `gift_requests` holds the
per-tap `idempotencyKey`, so a retry of a request whose response was lost is answered with the gift
already bought instead of a second one (`replayed: true`, nothing re-broadcast). A `roomId` on the
send has to name a room both halves of the pair are standing in (see *Room scoping* in
`backend/README.md`); a gift sent from a profile or a DM simply omits it.

The catalogue row carries the animation with it: `animation_format` (`LOTTIE`/`SVGA`/`MP4`, sniffed
from the uploaded bytes — never from a file name), `duration_ms`, `display_priority` and the combo
window. Android routes on those fields in `ui/screens/room/gifts/` — Lottie through the existing
lottie-compose player, MP4 through the platform `MediaPlayer`, the generated burst when a gift has
no file at all. SVGA is drawn by a reader this build carries itself, in
`ui/screens/room/gifts/svga/`: `SvgaWire` is the protobuf wire format (varints, tags, length-delimited
runs, unknown fields skipped whole so a newer exporter's file still opens), `SvgaParser` sniffs the
container — a zlib stream, a ZIP holding `data.pb`/`movie.binary`, or a 1.x `movie.spec` — and
`SvgaPlayer` ticks the decoded movie onto a `Canvas`, decoding each bitmap once and recycling them on
dispose. No dependency was added, and nothing about the format was guessed from memory: the field
numbers were cross-checked against SVGAPlayer-Android's generated adapters and SVGAPlayer-iOS's
`Svga.pbobjc.h`. What is deliberately not drawn: `clipPath` masks, vector `shapes`, matte stencils
(painting one would smear a mask over the gift) and any audio inside the file — the room hears the
catalogue's `soundUrl`, as it does for an MP4 gift. Combos and the takeover/ticker choice are counted
and decided server-side; the device only draws the numbers it was given, deduplicated on the
transaction id the event carries as `eventId`.

A **lucky gift box** (migration `0027`) is one catalogue row whose credit the server draws instead of
multiplying. The sender always pays `diamond_price × quantity`; the pool is `r_coin_value × quantity`,
and each unit rolls one weighted prize from `gift_box_outcomes` (`label`, `multiplier_bps`, `weight`),
floored per unit before anything is summed. The receiver banks `floor(gross × receiver_share_bps /
10000)` and the platform keeps the remainder — one residual, never a second dial. Everything else
about the send is unchanged: XP, quests, commission and `rooms.total_gift_value` all read the same
`totalRCoins`, the transaction stays `GIFT_SENT`, and the roll is written into the receipt's `meta`,
so a reconnect replay answers the gift it already bought rather than drawing again. The odds a phone
prints (`chanceBps`) come from the same table the draw walks, and the write refuses a box whose
expected payout exceeds the pool it sells for (`lucky_box_payout_unbounded`) — so an operator cannot
build a machine that pays out more than it takes in, and a device never computes an earning.

A **ride** (migration `0026`) is the full-screen cinematic the room watches while a member arrives.
It is bought and worn like a frame or a flourish — store kind `RIDE`, the *Arrivals* tab of the
phone's shop — and resolved server-side by `wornRide()`, which honours the copy's expiry and returns
null for "walks in quietly"; there is no free ride to fall back on. The result ships as the
`entryRide` object on the account (`GET /api/auth/me`), on a public profile (`GET /api/users/:id`)
and on the `MiniUser` inside `room:user_joined`, which is what the room plays it from. The fields are
`url`/`format`/`durationMs` because the renderer and the hold are the row's own answer, not something
a file extension gets to decide, and rides share the gift engine's format routing — an SVGA, Lottie
or MP4 arrival draws through the same `RideArtLayer` in the room (`ui/screens/room/EntryRideOverlay.kt`)
that the shop plays it from in the *Arrivals* preview, so neither can promise a rendering the other
does not deliver. What an operator maintains lives on the panel's **Decoration** screen, under
*Entrance rides*.

Two more decisions stopped being client-side. A gift's shelf is a row: `gift_categories` (migration
`0025`) holds the `key` every gift and every historical transaction refers to plus the `name` and order
the tab strip prints, `GET /api/gifts` answers `{ gifts, categories }`, and a shelf a gift still sits
on cannot be deleted (`category_in_use`) rather than silently re-filing it. And the store asks for a
rank: `min_vip_level` on a frame, theme, flourish or ride is compared against the buyer's account
inside the same locks that read the balance, so a locked cosmetic answers `403 vip_required` with
`required`/`current` before it ever mentions a top-up — while the shop list ships the gate as a field
instead of hiding the row, and putting an owned copy on stays open to any rank, because `min_vip_level`
is a price to pay and not a licence to hold. `recommended` only decides what the grid shows first.
What a catalogue is worth is data too —
`GET /api/admin/gifts/analytics?days=` (1–365, default 30) reads the same `GIFT_SENT`/`COMPLETED` rows
the ledger wrote and answers totals plus the top 100 gifts by diamonds, with `unattributedDiamonds`
kept separate so a total that does not match the rows is visible instead of quietly rounded.

What the app shows *before* a member chooses anything is data too: `banners` (migration `0028`) holds
operator-run art for four fixed surfaces — splash, home, gift panel, game desk — as a file plus a
renderer plus a tap target stored as a verb (`NONE`/`INTERNAL`/`ROOM`/`URL`) rather than a route the
phone has to guess, and `GET /api/banners` hands a device only what is live this second, dropping a
banner whose target room has since closed instead of shipping a broken navigation. An operator retires
a campaign by switching it off, not by deleting it, because the impressions and taps beside the row are
the only answer to "did that work". The panel screen is **Banners**.

See `backend/README.md` → *The gift engine (migration 0023)*, and `npm run test:gift:e2e` (66 live
checks) for what is asserted about it.

## Room effects

`room:like { roomId, count }` is buffered per room for one second and comes back as a
single `room:liked { roomId, count, total, user }` batch, so twelve taps are one
broadcast instead of twelve and every viewer draws the same number (`total` is
server-side; Postgres keeps the durable copy on `rooms.like_count`).
`room:reaction { roomId, key }` is the same idea for emoji: the server resolves the key against the operator's
`emoji_characters` rows, refuses one it never published, allows twenty per member per five seconds,
and broadcasts the art it found (`{ roomId, userId, key, code, url, label }`) — a device sends a
name and cannot choose what another room animates. Nothing is stored behind it. Gifts carry an
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

## Social graph and room community

Migration `0022` turns the room into a place with a memory of its people. Follows are
directed and public in both counts; a block is one row that is read **both ways**, so
neither side can follow, be followed or send a gift to the other after either taps it —
the ledger calls `assertInteractionAllowed` inside the same transaction as the balance
locks, so the rule cannot be raced. A report is a queue item, never an automatic ban:
filing one writes `PENDING`, a second open report against the same member is a `409`,
and the target is never told. The admin panel's **Moderation** screen decides each
report (`REVIEWED`, `ACTIONED`, `DISMISSED`), with banning as a separate checkbox that
the server refuses to combine with a dismissal; the **Users** screen's eye button opens
the same account's followers, follows, blocks and both directions of reports.

Rooms gained the controls a host actually needs. A host can pin a `300`-character
notice above the seats (`PATCH /api/rooms/:id` also writes it, and an operator can
override it from the room console), bookmark a room, invite a listener straight to a
seat, hand ownership to a member present in the room (history lands in
`room_ownership_transfers`, and both LiveKit publish grants move), and switch the
microphone to **approval required**. That switch is off by default so older clients
are unchanged; when it is on, taking a seat answers `202 { requested: true }`, the
host decides the queue, and approval arrives on the requester's private channel with a
fresh token. Turning approval off cancels the queue rather than stranding it. See
`backend/README.md` → *Social graph and room community*.

## Verification

* `cd backend && npm run test:e2e` — 401 checks against a running stack (real Postgres,
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
  every webhook-signature rejection. Together with the e2e suite that is 446 checks.
* `cd backend && npm run test:business` (87), `test:games` (69), `test:accounts` (98),
  `test:operators` (44) and `test:revenue` (25) cover the money book rather than the party: the
  nine-step recharge and its commission versions, the three game drivers and at-most-once
  settlement, the purpose-account projection and its exports, the operator roster's live re-read
  of every switch, and — since migration 0031 — the journal entry each gift's spread and each
  settled game's pool now writes, priced at `system_config.accounts.coinValue`.
* `cd backend && npm run test:social` — 24 checks over the migration-0022 edges with no
  database: the report/status/decision vocabularies, every validator's trim-and-refuse
  behaviour (details, resolution, block reason, announcement, transfer note, UUIDs), and
  the report DTO's camelCase and ISO timestamps.
* `cd backend && npm run test:social:e2e` — the same graph against a *running* stack:
  51 live checks over follows, symmetric blocks (including the ledger guard on a gift),
  the report queue and its decisions, pinned announcements, the speaker-approval state
  machine, host invitations, favorites and an ownership transfer. Needs the API, Postgres
  and Redis up; it creates timestamped throwaway accounts and one room.
* `cd backend && npm run test:wire-fixtures` and `npm run test:game-wire-fixtures`,
  then `cd android && ./scripts/run-dto-harness.sh`
  replays the captured live payloads through the mobile client's own Gson DTOs — 44
  assertions covering every REST envelope, the gift/like/theme/seat/profile socket events, the
  three live game boards, the seat range the client is told to offer, and the Gson trap
  where an absent key lands as null instead of
  the declared default. A response shape change fails in seconds rather than as an NPE on
  a phone.
* `cd android && ./gradlew testDebugUnitTest` — 170 JVM tests over the DTO→domain
  mappers (unknown enums, absent keys, Gson's skipped default initialisers), the game
  boards and the client's copy of the engine's seat rules, the gift
  purchase guard, the effect queue policy (takeover depth and eviction, ticker
  trim, entry tiers, panel paging), and the banner wall (rows that cannot be honoured,
  tap targets this build cannot name, one fetch serving four surfaces, impression
  dedupe).
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
