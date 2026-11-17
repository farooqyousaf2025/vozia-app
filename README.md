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
| Diamond | Listener     | Bought from a coin seller, credited by finance      | Buying gifts                |
| R-coin  | Host         | Receiving gifts                                    | Sold to a coin seller, or `POST /api/wallet/withdraw` |

Money reaches the platform through a coin seller, not through a card form: the seller opens a
`recharge_orders` row against a member, claims it paid, and the order stops at `AWAITING_VERIFICATION` until
a `recharge:review` operator credits it — see *Coin sellers and cash settlement*. The Stripe path is still
built and tested, but no member surface may call it. In a `PAYMENTS_PROVIDER=simulated` stack (the default
here) `POST /api/wallet/recharge` credits balance directly, and that is the only free path — under this model
it is a test door, not a top-up, and it is why production refuses to boot on `simulated`. With
`PAYMENTS_PROVIDER=stripe` it returns `403 payments_provider_is_stripe`; only a signature-verified
`payment_intent.succeeded` webhook can credit a wallet, and `payment_proofs`
(`UNIQUE (provider, external_id)`, written in the same transaction as the credit) makes
a webhook redelivery a no-op rather than a second top-up. Balances then reach the
client over the private `wallet:update` event, which the Android session store folds
into the cached user — the diamond chip and wallet screen update without a reload. The
event's `promoDiamondBalance` is the wallet's bonus total rather than the amount of the
grant that just landed, so a minted batch cannot be quoted to the member as the pocket.

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

Coins a payment bought are owed on the book, not just present in a wallet. Until migration 0034 only a
seller order credited `COIN_LIABILITY`, so every `payment_intent.succeeded` minted diamonds the accounts
had never seen and the balance was a tally of the orders a seller happened to open. The posting now lives
in `settlePaymentOnClient` — the primitive both routes share — as DEBIT PROVIDER_COLLECTIONS / CREDIT
`COIN_LIABILITY`, keyed on the `payment_proofs` row, so a redelivered webhook answers the entry the first
delivery booked instead of doubling the debt. The seller path keeps its own fee-split entry — against
`SELLER_RECEIVABLE` rather than `PROVIDER_COLLECTIONS`, because that cash never reached a provider (0042) —
and opts out of the generic one, and the two shapes are mutually exclusive by construction: a proof counts as
covered when either credits exactly what was collected. A simulated top-up and an admin balance grant still book
nothing — they collect nothing, and the purchased-coin hand-out has no contra account either; the mint
that does book is the bonus pocket below. See `backend/README.md` →
*What a confirmed payment minted is owed on the book (migration 0034)*.

The wallet has a second pocket. `users.promo_diamond_balance` (`promo_grants`, migration 0036) holds coins
the platform minted rather than coins a member bought, and each grant carries its own deadline: a send
draws the batch dying soonest, so a bonus about to lapse is spent instead of left to expire. The balance is
a cache and the grant is the truth — which is why a 60-second sweep closes overdue rows, each one reversing
its own `PROMO_GRANT` entry with a `PROMO_LAPSE` rather than quietly dropping a number. Bonus coins feed
only the sinks an operator opens in `accounts.promotional.usableFor` (gift / box / store / game), and they
become cash to nobody: a member's only exit for diamonds is spending them, since withdrawal is priced in
R-coins. A gift paid from both pockets stores which grants paid it, so a refund returns the bonus to those
grants instead of handing back a purchased coin. See `backend/README.md` → *Promotional diamonds: the
pocket that expires (migrations 0036, 0037)*, and `npm run test:promo` (38).

What those bonus coins are earned for is now data rather than code. A campaign and its rules are operator
rows (`earning_rules`, migration 0038) carrying a target, a currency (`XP` or `BONUS_DIAMOND`), eligibility,
caps, a reset period and the conditions a payment must meet; a payout reads every one of those numbers off
the live rule *version* inside the transaction that pays, so no client can quote its own price and repricing
a campaign cannot change what an in-flight attempt was already owed. The reset period is a bucket string
computed in PostgreSQL — a new day needs no midnight job for the caps to be right — and the caps themselves
are unique keys, `(user_id, rule_id, bucket, occurrence)` on the attempt and `activity_id` on the payout, so
"twice a day" and "never twice for one attempt" hold while two requests race rather than in a count either of
them could pass. Nine metrics are counted by the server itself — gift sends, diamonds spent, chat lines,
check-ins, streak days, logins, room joins, game starts and store purchases — fired from the real product
paths, and the three on paths a member is waiting for (chat, room entry, sign-in) are deliberately not
awaited: a campaign never adds its latency to an action or fails it. `SUBMISSION` is the only thing a phone
may assert, only into a rule an operator marked reviewable, and a human with `user:wallet` signs every
payment from it. See `backend/README.md` → *What a member is paid for is a rule, not a code path
(migration 0038)*, and `npm run test:earning` (92), `test:earning:routes` (38) and
`test:earning:hooks` (40).

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
3. Money in is a coin seller's order, not a card form: the seller opens it with
   `POST /api/business/orders`, claims it with `…/mark-paid`, and a `recharge:review`
   operator credits it from the panel's Recharges queue. Keep `PAYMENTS_PROVIDER` off
   `simulated` in production, because that mode makes `POST /api/wallet/recharge` a
   free mint — and the Android wallet's top-up chips still call it, so on this stack a
   tap mints diamonds with no money behind them. The Stripe keys
   (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, a webhook on
   `POST /api/payments/stripe/webhook`) are only worth setting if you choose to keep
   the card path reachable; under the current model no member surface may call
   `recharge/checkout`. That leaves an unanswered config question — a seller-only
   production has no `PAYMENTS_PROVIDER` value that is both accepted by the boot guard
   and correct, since `simulated` mints and `stripe` opens checkout. See
   *Coin sellers and cash settlement*.
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
· Become a Partner `GET /api/role-applications/roles` (the four forms, plus where this account stands in each),
`GET /api/role-applications/form/:role`, `GET /api/role-applications/mine`,
`POST /api/role-applications` (`{role, data}` — the applicant is taken from the token, never from the body),
`POST /api/role-applications/:id/{supplement,cancel}`
· the agency desk `GET /api/agency/{position,hosts,settlements}` for the member who runs an agency, and
`GET /api/agency/sub-agencies` for a master only (migration 0040). There is no agency id in any of these
paths: the caller's agency is resolved from `agencies.owner_user_id` on every request, so naming another
agency's uuid reaches nothing, and a sub is refused the sub-agency list rather than shown an empty one
· room community `GET|POST|DELETE /api/rooms/:id/favorite`, `GET /api/rooms/favorites`,
`POST /api/rooms/:id/announcement`,
`POST /api/rooms/:id/{transfer,seat/:index/invite}`,
`GET /api/rooms/:id/speaker-requests`, `POST /api/rooms/:id/speaker-requests/{cancel,:requestId/approve,:requestId/reject}`
· admin `POST /api/admin/login`, `GET /api/admin/stats|users|rooms|gifts|withdrawals|reports`,
`GET /api/admin/users/:id/social`, `POST /api/admin/reports/:id/review`,
`POST /api/admin/withdrawals/:id/{review,pay}`, `PUT /api/admin/config/accounts.withdrawal`,
`GET /api/admin/agencies` + `/api/admin/agencies/:id`, `PUT /api/admin/agencies/{:id/rate,:id/hosts/:userId/rate}`,
`POST /api/admin/agencies/:id/settlements` and `/api/admin/agencies/settlements/:id/{approve,pay,void}`,
`PUT /api/admin/agencies/:id/{parent,override}` (migration 0040 — who a roster's commission is shared with,
and what that master keeps; both behind `commission:manage`, never reachable from an agency's own token),
`POST /api/admin/users/:id/vip` and the matching mutation routes for each domain above,
`POST /api/admin/users/:id/promo-grant` and `POST /api/admin/promo-grants/lapse` (behind `user:wallet`),
`GET /api/admin/users/:id/promo-grants` (behind `user:read`),
`GET /api/admin/partner-applications?status=&role=&search=&limit=&offset` — plus `.../forms` and `.../:id` —
behind `application:read`, and `POST /api/admin/partner-applications/:id/{approve,reject,request-info,revoke}`
behind `application:review`,
`GET /api/admin/qa/{identities,money,money/summary}` behind `qa:read` and
`POST /api/admin/qa/identities/{mark,cohort}` behind `qa:manage` (migration 0039; `qa_ref` is admin-only
and never appears in a member payload).

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

A profile ring carries two more display-only fields since migration `0043`: a rarity `tier`
(`COMMON`/`RARE`/`EPIC`/`LEGENDARY`) that badges the store card and the profile, and `animated`,
which tells the phone to draw a rotating aura in the ring's accent colour behind the still PNG —
Legendary adds a gold thread. Neither prices anything (`price_diamonds` stays the only number a
purchase reads) and neither adds an upload format: the aura is drawn on the device by the same
composable that paints the store preview, the profile header and every room seat. The panel's
**Decoration** screen edits both. See `backend/README.md` → *A ring's rarity is a badge, and its
life is drawn on the device (migration 0043)*. Emulator evidence verifies free Wear/Take off and
permanent Crown ownership; profile aura rotation and room-seat rendering are not yet device-verified.

Chat bubbles (migration `0044`) are a fifth cosmetic Store shelf. Operators manage colours, motif,
pricing, rental period and holders in **Decoration**; purchases and free Wear use the existing ledger
and ownership routes. Each text message saves the server-resolved style at send time, so editing,
retiring or taking off a bubble cannot restyle old messages. Emulator evidence (2026-11-17) covers a
styled send, the snapshot surviving Take off, and chat history recovering after an API restart with
saved styles intact; 177 live API checks and 224 Android unit tests pass. See `backend/README.md` →
*Chat bubbles keep their send-time style (migration 0044)*.

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

## Become a Partner

Host, Agency, Coin seller and BD manager are privileges a member applies for and an operator grants.
One module, four forms, one queue: `GET /api/role-applications/roles` ships the questions themselves,
so the phone draws a form it was handed rather than four screens written down in Kotlin, and the same
spec is what refuses a submission the moment an answer is missing, invented, unticked or out of bounds
— the client validates nothing, because a client that validated would be a second place to decide what
an application asks.

The app never asserts a privilege. A role is the `role_applications` row whose status is `APPROVED`,
which only an operator's decision can write; `users.user_type`, the column that has always recorded who
has *hosted*, is display only. An approval activates what the role is in the same transaction as the
decision — an agency row beside the member who owns it and its earnings account, a coin-seller partner
account under the BD it reports to and within the configured recharge limits — and a revocation suspends
those objects rather than merely flipping the row. Two `system_config` switches decide how much of the
platform this gates: `roles.hostApplicationRequired`, which ships off so that making hosting a
privilege is a choice an operator makes once the queue has caught up, and `business.bd`'s
`multiManager`. Reading the queue and deciding it are separate permissions, every refusal — reject,
ask for more information, revoke — has to carry a sentence the member reads back on the application's
own history (an approval is the one decision that can be filed without one), and every event on either
side lands in `admin_audit`. See `backend/README.md` → *Become a Partner: a role is a row an operator
approved*.

## Master and sub agencies

An agency can report to another agency. Two columns say so (`agencies.parent_agency_id` and
`agencies.parent_override_bps`, migration 0040) and there is deliberately no `kind` column: a stored kind
and a stored parent can disagree, and the screen that read the kind would promise a permission the link
does not give, so a row is a master or a sub because of who it points at. Depth is two and the database
enforces it — a trigger refuses a sub taking subs, a self-link, a non-active master and demoting an agency
that already has children, because that would move existing rows to depth three without their ever being
validated.

The money is the part worth reading. A sub's commission is accrued **gross** to the sub exactly as 0033
books it, and the master's share is then moved by a second balanced journal entry — DEBIT the sub's payable,
CREDIT the master's — keyed on the same commission row under its own source kind. `COMMISSION_EXPENSE` is
therefore still debited once: the platform promised the commission once, and the split only decides who it
is owed to. The share is truncated toward the sub, never rounded up, and moving an agency to a different
master clears the allocation, because a percentage negotiated with one master is not a promise to the next.

Neither half of the relationship is a client's claim. `requireAgencyOwner` re-reads the caller's active
agency from the token on every request, so there is no agency id to tamper with, and
`requireMasterAgency` refuses a sub's request for the sub-agency list with 403 `master_only` rather than
answering it empty — which is what makes "restricted access to Master Agency settings" a testable answer
instead of a hidden menu item. The Android desk is read-only for the same reason the panel's rate column is:
an agency cannot set its own percentage or raise its own payout batch, because the person who claims an
agency's money is not the person who signs it. See `backend/README.md` → *A sub-agency's share is booked to
two payables*, and `npm run test:agency:hierarchy` (65).

## Coin sellers and cash settlement

A member buys coins **from a coin seller** and sells R-coins **to a coin seller**, and the rupees for both legs
move out of the seller's own pocket, somewhere this backend has no window into. So the last question in a
top-up is one no webhook can answer — did the cash actually change hands? — and the answer is a document a
human reads. `payment_receipts` (migration 0041) stores that document and stores it as evidence, never as a
trigger: an upload lets a seller claim an order and nothing else, the order still stops at
`AWAITING_VERIFICATION`, and the coins appear only when a `recharge:review` operator approves. The bytes go to
`backend/receipts/` — `0600`, gitignored, named from a uuid rather than the filename, mounted nowhere —
because `/uploads` is served with no authentication, which is fine for a gift icon and wrong for a screenshot
of a name and an account number. Every receipt DTO has a size and a content type and **no `url`**, because
there is no URL to return: opening a document means calling a route that has already checked a permission.

The sell side reuses the cash-out rails instead of inventing a second table. `payoutMethod: 'SELLER'` is still
a `withdrawal_requests` row, so it keeps the minimum and the `fee_bps` quoted when the member asked, the
`payout_reference` finance must type before the row can be PAID, and the `withdrawal:review` permission that
releases the money. The seller is resolved from `business_accounts` — an active COIN_SELLER, never a code
pasted into the body — and the seller's own queue masks the member's account to its last four digits. What a
slip costs in reading is what that split buys: `finance:read` lists the documents on a record, and only the
review capability opens one.

**The book says what the seller says.** A `recharge_orders` row carries its own `amount_cents`, and approving
it credits `COIN_LIABILITY` for the gross — coins are a service owed, never revenue. The asset beside it is
`SELLER_RECEIVABLE` (migration 0042), not `PROVIDER_COLLECTIONS`: the seller collected those rupees and still
holds them, so what the platform owns is that seller's debt. A reversal credits the receivable back, and a
SELLER commission batch credits it too — the seller keeps their cut out of cash already in their pocket
instead of waiting for a transfer, and the 0004 ceiling means that cut can never exceed what they collected.
`PROVIDER_COLLECTIONS` stays what its name says: a Stripe settlement and a BD batch still use it, because a BD
manager holds no cash and paying one is a real outflow. The seller reads the result as `cash` on
`GET /api/business/statement` — collected, refunded, commission netted, and what is still to hand over — and
finance reads the same figure at `GET /api/admin/business/accounts/:id/cash-book`. The R-coin half of that
statement is counted in R-coins and never added to the money: the rate a member and a seller agree lives
outside this platform, and `payWithdrawal` has always refused to price external cash. The honest limit is
unchanged — nothing in the database can prove the rupees moved, which is exactly why the credit is a decision
with an audit row and a document a `recharge:review` operator opened, rather than something a file causes.

The gap is on the phone, not in the book. `POST /api/wallet/withdraw` accepts `SELLER`, but the withdrawal
sheet still offers only BANK / WALLET / USDT; the seller's desk — open an order, claim it paid, upload the
slip, read the payouts it must hand over — is a partner API (`/api/business/*`) that no client calls yet; and
the wallet's top-up chips still hit the simulated mint, so on this stack a tap credits coins with no money
and no seller behind them. `backend/src/config/env.ts` accepts only `simulated` and `stripe` for
`PAYMENTS_PROVIDER` and refuses to boot on the former in production, so a seller-only deployment has no value
that is both accepted and correct. See `backend/README.md` → *A manual settlement is judged on a document*,
and `npm run test:receipts` (69).

## Verification

* `cd backend && npm run test:e2e` — 402 checks against a running stack (real Postgres,
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
  unreferenced payment crediting nobody, and the collection journaled against
  `COIN_LIABILITY` once and only once across the credit and its replay). Re-runnable;
  it cleans up the accounts and gifts it creates.
* `cd backend && npm run test:sms` and `npm run test:payments` — 16 and 29 checks with
  `fetch` replaced by a recorder, so no account is needed: the exact Twilio form POST
  and Basic header, Vonage's `200`-with-`status:"1"` trap, the Stripe intent body, and
  every webhook-signature rejection. Together with the e2e suite that is 447 checks.
* `cd backend && npm run test:business` (93), `test:games` (69), `test:accounts` (135),
  `test:operators` (44) and `test:revenue` (25) cover the money book rather than the party: the
  nine-step recharge and its commission versions, the three game drivers and at-most-once
  settlement, the purpose-account projection and its exports, the operator roster's live re-read
  of every switch, and — since migration 0031 — the journal entry each gift's spread and each
  settled game's pool now writes, priced at `system_config.accounts.coinValue`. Since 0034 they hold
  the other side of the book to the money too: `COIN_LIABILITY` has to equal every cent
  `payment_proofs` recorded, whichever of the two posting kinds booked it.
* `cd backend && npm run test:promo` (38) — the second pocket, over the running stack: a mint that books
  its liability at the operator's face value, a spend that draws the batch dying soonest, a gift too big
  for the bonus pocket that pays the rest from the wallet and receipts exactly which grants paid it, a
  closed sink that leaves the bonus untouched, a refund that returns bonus coins to those grants instead
  of handing back bought ones, and an expiry that reverses the entry rather than deleting a number. It
  opens every sink at the start and puts the dial back before it reconciles, so it tests the spend path
  rather than whatever a previous interrupted run left switched off.
* `cd backend && npm run test:concurrency` — 35 checks that arrive at the same instant instead of one
  after another: six gifts against a balance that affords three, one idempotency key held by six arms,
  five withdrawals against two escrows, four parallel pays of one approved withdrawal, six holds with
  one key, then the whole book — no negative balance anywhere, every test wallet equal to its own
  ledger legs less the escrow still held, no ERROR finding and no breached tie-out. It is the suite that
  found the gift path's `40P01` deadlock; *What six simultaneous sends are allowed to do* in
  `backend/README.md` explains the two lock-order inversions behind it and why `ORDER BY … FOR UPDATE`
  over an `ANY()` list cannot fix them.
* `cd backend && npm run test:partner` — 98 checks on both sides of the Become a Partner door at once:
  eight member accounts file, withdraw and answer while three operators (one per role that the
  permission split actually separates) read, approve, ask for more information, refuse and revoke. The
  three claims it exists to hold are that a body naming another account is ignored, that an approval
  activates exactly the role asked for and nothing wider — an agency row with its earnings account, a
  seller account that cannot be approved without the BD it reports to — and that every refusal above
  files no row. It also walks the create-room switch on and back off again, and puts everything it
  borrowed back even when it throws.
* `cd backend && npm run test:qa` — 55 checks on the QA programme's own record (migration 0039): the
  database refuses a test account with no internal reference, marking an account reclassifies
  transactions that *already existed*, unmarking puts them back with the id list byte-identical, journal
  entries inherit the marking through the row their `source_id` names, the dashboard / gift analytics /
  member leaderboard all drop a marked account while `?includeTest=true` restores it for a `qa:read`
  holder, neither `is_test` nor `qa_ref` reaches a member payload, the cohort write is all-or-nothing,
  and the last production Super Admin cannot be marked out of the programme's own controls. It borrows a
  real gifter rather than a throwaway, and leaves zero marked accounts, zero test money and no enabled
  operator behind — on the crash path too.
* `cd backend && npm run test:agency:hierarchy` — 65 checks on migration 0040, over the running stack and
  read back through the backend's own pool. The three it exists for are on the split: `COMMISSION_EXPENSE`
  is still debited exactly once for the gross when a second entry moves part of that money to a master, the
  sub's payable falls by exactly what the master's rises, and both entries are keyed on the one commission
  row so a replayed gift posts neither side twice. Around the money it holds the depth rules from both the
  service and the trigger, the clear-on-re-parent rule, the two new reconciler tie-outs in both breach
  directions, and the member surface seen as a master's owner, a sub's owner, a member who runs no agency,
  an operator token and a suspended agency's owner. It stamps every row it writes and leaves them in place,
  so it is a development-database script.
* `cd backend && npm run test:receipts` — 69 checks on migrations 0041–0042, the coin-seller desk and the two
  verification queues. The four it exists for: an accepted slip changes nobody's balance (the member's
  `diamond_balance` is read before and after), a second partner cannot open a document it did not upload, the
  format comes from the magic bytes rather than the caller's filename (so a 6 MB file named `.png` is a 6 MB
  PNG and is refused), and a payout slip asked for on the order route — or the reverse — is
  `receipt_wrong_queue`. It also proves the sell side is still a withdrawal: fee at request, minimum,
  `payout_reference` before PAID, and the member's account tail-masked on the seller's desk. Since 0042 it
  reads the cash book back too: a requested sale is R-coins waiting on that seller, paying it moves the coin
  half and leaves `remittanceCents` exactly where it was, another seller's statement shows neither, finance
  and the partner read one number, a BD id is `not_a_coin_seller`, and the CSV keeps `rcoin` rows out of the
  money column. The documents it uploads are real PNG and PDF bytes with their chunk CRCs and xref offsets
  verified on the way back, so "the panel renders it" is asserted by the suite. Leaves stamped partners and
  files under `backend/receipts/` in place; development database only.
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
* `cd android && ./gradlew testDebugUnitTest --rerun` — 229 JVM tests over the DTO→domain
  mappers (unknown enums, absent keys, Gson's skipped default initialisers), the game
  boards and the client's copy of the engine's seat rules, the gift
  purchase guard, the effect queue policy (takeover depth and eviction, ticker
  trim, entry tiers, panel paging), and the banner wall (rows that cannot be honoured,
  tap targets this build cannot name, one fetch serving four surfaces, impression
  dedupe), the partner forms (a role or state this build has not met stays readable, a field it cannot
  draw is named rather than guessed at, `granted` read from the server's flag, and an answer that
  reads back as the member typed it rather than as Gson decoded it).
* `.github/workflows/ci.yml` runs all of the above plus `assembleDebug` and an
  unsigned `assembleRelease` (R8 + resource shrinking + lint) on real service
  containers.
* `cd backend && npm run assets:generate` — regenerates the placeholder gift/avatar art
  served from `public/`; clients prefix it with the API origin.
* `cd backend && npm run demo:gifts -- +15550000010` — seeds a demo room (host avatar,
  seats, three gifts, one chat line) and prints the dev OTP, so a phone or emulator can
  log in and see populated screens immediately.

## Landing rankings

Host, Rich and Gifter boards now open from Home, with Daily/Weekly/Monthly periods,
a 2–1–3 podium, the member's standing and a reward sheet. Live boards show the current
UTC window; rewards always use the previous completed window. Claims mint expiring,
non-withdrawable bonus diamonds through the journal, never by changing a client balance.
The operator's `rankings.rewards` setting controls podium payouts. Tied scores use the
same account-age/id ordering for the board, self-row and reward.

Verified on 2026-11-17: two consecutive `node scripts/rankings-e2e.cjs` runs passed
49/49 checks each; a forced exception also restored the reward dial and marked all four
proof accounts. Android's fresh unit-test run passed 229/229. Actual emulator captures
include all three boards, period switching, an eligible claim and its wallet grant;
evidence stays under `D:\vozia-runtime\qa-evidence`, outside git.

The native stack and installed debug APK target `192.168.1.100`:
API `http://192.168.1.100:4000`, admin `http://192.168.1.100:5173`, voice
`ws://192.168.1.100:7880`. The verified phone APK is
`D:\vozia-runtime\voiza-phone-192.168.1.100-debug.apk`; rebuild if DHCP changes the PC's address.
Historical unmarked script accounts still appear in demo boards; their backed-up,
audited sweep is tracked separately (#148). Physical-phone, real-SIM OTP and real-payment
verification remain outstanding; these checks used simulated development transactions only.

## Components

* [Backend](backend/README.md) — API, ledger, realtime, LiveKit integration
* [Admin panel](admin-panel/README.md) — moderation, virtual-store management and the media
  library operators upload gift art, sounds, room effects and rank badges through
* [Android app](android/README.md) — native Kotlin/Compose client

## License

AGPL-3.0-only. See [NOTICE.md](NOTICE.md) for the room-effect credit
(`Tencent-RTC/TUILiveKit`, MIT — behaviour only: no code, no SDK, no API calls) and
the provenance of everything served from `backend/public/`.
