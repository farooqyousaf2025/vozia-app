# Voiza backend

Express + TypeScript API, Socket.IO realtime layer, LiveKit token service and the
wallet ledger. PostgreSQL is authoritative; Redis holds presence, listener sets and
rate-limit counters.

## Run

```bash
cp .env.example .env
docker compose -f ../docker-compose.yml up -d postgres redis livekit
npm install
npm run dev          # tsx watch
npm run build && npm start
```

Two layers, applied by one runner:

```bash
npm run db:migrate   # node scripts/migrate.cjs — applies database/schema.sql, then any
                     # not-yet-applied database/migrations/NNNN_*.sql, over `pg`
                     # (no psql binary needed). --status lists applied/pending;
                     # --force re-checksums an edited file instead of failing.
npm run db:seed      # psql "$DATABASE_URL" -f database/seed.sql — demo agency,
                     # hosts and three live rooms
```

`schema.sql` is the frozen baseline (`CREATE TABLE IF NOT EXISTS` everywhere); new DDL
goes into a numbered migration file, which runs exactly once per database inside its own
transaction and is recorded with a sha256 in `schema_migrations`. That is what makes
"apply the update" safe on a database with user data in it — nothing is dropped and
nothing is re-run. `migrate.cjs` prints each file it lands, e.g.
`0012_room_seat_policy.sql (1c2dfa35b38eb1f8)`.

## Layout

```
src/
  config/      env.ts (validation + prod secret guard), db.ts (pool + withTransaction),
               redis.ts (presence, rate limits), livekit.service wiring
  controllers/ auth, room, gift, wallet, user, admin, livekit (webhook), payments (checkout + Stripe hook)
  services/    otp · sms (Twilio/Vonage over fetch) · push (FCM v1) · stripe · token
               · livekit (tokens, SFU admin, webhook verify)
               · room (seats, participants, moderation) · ledger (money)
               · socket (realtime fan-out) · admin (stats, store, users)
  routes/      one router per domain, mounted under /api
  middleware/  auth (requireAuth / requireAdmin), error (ApiError + pg code mapping)
  utils/       crypto (scrypt, codes, room numbers) · http (validation) · serialize (DTOs)
  types/       db.ts row shapes
scripts/       e2e-live.cjs · games-e2e.cjs · business-e2e.cjs · capture-wire-fixtures.cjs
               · capture-game-wire.cjs · generate-placeholder-assets.cjs · demo-gift-chat.cjs
public/        gift icons/animations and demo avatars served at the API origin
```

## Static assets

Catalogue rows store root-relative URLs (`/gifts/rose.png`, `/avatars/host-nova.png`),
so `app.ts` serves `public/` from the API origin and both clients prefix their
configured API origin before loading them. `npm run assets:generate`
(`scripts/generate-placeholder-assets.cjs`) redraws the committed placeholders with no
image dependency; replace the directory with real art or a CDN mirror at any time.

It emits three kinds of file, all deterministic (re-running is byte-identical):

| Path                        | What it is                                                            |
| --------------------------- | --------------------------------------------------------------------- |
| `gifts/<slug>.png`          | Store icon                                                            |
| `gifts/<slug>.json`         | Lottie overlay the clients play full-screen (9 gifts)                  |
| `welcome.json`              | Entry flourish, played once when a member joins a room                 |
| `effects/<slug>.json`       | Ambient loops (`room-sparkle`, `-confetti`, `-hearts`, `-glow`)        |
| `themes/<slug>/wallpaper.png` | Room background, one per theme slug                                  |
| `themes/manifest.json`      | The generator's own record of what it drew. Not read at runtime — the theme registry is in the database. |

Every animation is built by `scripts/lottie-kit.cjs` and passed through its
`validate()` before being written, because a malformed Lottie renders as an
invisible blank overlay rather than an error.

## Room decoration is data (`/api/admin/decor`)

Which themes exist, what they are called, which one is the default, which Lottie
loop breathes behind a PARTY room and which flourish plays on entry are rows in
`room_themes`, `visual_effects` and `room_category_effects` (migration `0015`),
not a file shipped with the build. The generated art in `public/` is only where
those rows point by default; an operator can point a theme at
`/uploads/<uuid>.png` instead and no client code changes.

`src/services/theme.service.ts` owns the catalogue. It reads the rows into an
immutable snapshot at boot, reloads after every admin write, and refreshes in the
background once a snapshot is older than 30 s — because `toRoom()` in
`utils/serialize.ts` runs on every room DTO (hundreds of times on a discovery
page) and is synchronous, so no request path may await a catalogue query. A
second backend process is therefore at most one refresh behind a write, which for
a few dozen rows is not worth a pub/sub channel.

| Route                                          | Permission      | What it does                                          |
| ---------------------------------------------- | --------------- | ----------------------------------------------------- |
| `GET /api/rooms/themes`                        | public          | the shape clients render: slugs, names, accents, **wallpaper URLs**, `welcome`, `effects` |
| `GET /api/admin/decor`                         | `room:read`     | the same rows plus the fields a phone never sees (`isDefault`, `sortOrder`, `roomsUsing`, `usedByCategories`) |
| `POST/PUT/DELETE /api/admin/themes[/:slug]`    | `config:manage` | add, rename, repoint, reorder, default or retire a theme |
| `POST/PUT/DELETE /api/admin/effects[/:key]`    | `config:manage` | same for an `AMBIENT` or `WELCOME` Lottie scene          |
| `PUT /api/admin/room-categories/:category/effect` | `config:manage` | which loop each `RoomCategory` plays                  |

Three rules make that safe to expose to an operator:

- **Clients get URLs, never a path to derive.** A theme's wallpaper arrives as
  `themeWallpaper` on every room payload and as `wallpaper` on `room:theme_changed`,
  so an app that guessed `/themes/<slug>/wallpaper.png` would 404 on uploaded art.
- **`url` is pattern-checked twice** — a `CHECK` in `0015` and `URL_PATTERN` in
  the service — because the string is handed to every device that joins a room;
  `javascript:` and `file:` are not storable even by an admin.
- **Deletes refuse or degrade, never orphan.** A theme still stored by rooms can
  be retired (those rooms keep the slug and render the default art afterwards);
  an effect mapped to a category answers `effect_in_use` until the mapping moves.

Hosts set a theme with `POST /api/rooms/:id/theme`, ops with
`POST /api/admin/rooms/:id/theme`; both emit `room:theme_changed` with the new
slug *and* its wallpaper so everyone in the room swaps background at once.

Ops actions that target one person — the `POST /api/admin/rooms/:id/warn`
nudge — go out on the private `user:<id>` channel as `room:warning`, exactly
like `room:kicked`, so the rest of the room never sees them.

## Operator uploads (`/uploads/…`)

`public/` is regenerable, so files an operator puts into a running system go to
`backend/uploads/` instead — gitignored, outside the repository, and part of any backup.
`src/services/media.service.ts` owns that directory: it decodes the base64 body, refuses
anything whose magic bytes do not match the formats the kind accepts, names the stored file
after a fresh UUID (the client's file name is kept only as a label), reads image dimensions
from the header rather than trusting the client, and records the row in `media_assets`
(migration `0014`). Identical bytes are deduplicated by sha256, so a re-upload returns the
existing row with `duplicate: true` and writes no second copy.

| Kind             | Accepted            | Cap    |
| ---------------- | ------------------- | ------ |
| `GIFT_ICON`      | PNG, GIF, WebP, JPEG | 2 MB   |
| `GIFT_ANIMATION` | Lottie JSON         | 2 MB   |
| `GIFT_SOUND`     | WAV, MP3, M4A       | 2 MB   |
| `EFFECT`         | Lottie JSON         | 3 MB   |
| `BADGE`          | PNG, GIF, WebP      | 512 KB |

`GET`/`POST`/`DELETE /api/admin/uploads` are gated on `media:manage` — its own permission
rather than `gift:manage`, because the same store holds room effects and rank badges and
whoever maintains those should not thereby gain the right to price a gift. Uploads are the
one request body allowed to be large: `app.ts` mounts a 5 MB `express.json` on that route
*before* the global 64 kB parser, so every other endpoint keeps the tight default.

`DELETE` answers `upload_in_use` (409) while a `gifts.icon_url`, `gifts.animation_url` or
`gifts.sound_url` still equals the asset's URL — a catalogue row pointing at a deleted file
is a broken image on someone's phone. Both writes and deletes are recorded in `admin_audit`
as `MEDIA_UPLOAD` / `MEDIA_DELETE`. `app.ts` serves the directory at the same root-relative
URL shape as `public/`, so the phone loads `/uploads/<uuid>.png` exactly as it loads
`/gifts/rose.png`, and new art appears without an app update.

`GET /emoji/manifest.json` remains a separate, static quick-react set under `public/emoji/`
(regenerated by `scripts/build-emoji-manifest.cjs`, `--check` verifies it against the art on
disk).

## Chat emoji: the database is the catalogue

A room message stores the **token**, not a picture: `[smile]` is what lands in
`chat_messages.content` and what every client is expected to draw. The art belongs to the
row, so retiring a code never rewrites history and adding one needs no app release.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/emoji` | anyone | `{codePattern, emojis: [{key, label, code, url}]}` — what a phone loads |
| `GET /api/admin/emoji` | `room:read` | the same rows plus `sortOrder` |
| `POST /api/admin/emoji` | `config:manage` | `{key, label, url, sortOrder}` |
| `PUT /api/admin/emoji/:key` | `config:manage` | `key` is immutable, so a saved row's token cannot move sideways |
| `DELETE /api/admin/emoji/:key` | `config:manage` | no guard: old messages keep their text and render it literally |

Both lists hand out URLs, never a slug the client turns into a path: seeded art is
`/emoji/<key>.webp` and an uploaded row is `/uploads/<uuid>.png`, both served by this origin.

`EMOJI_CODE_PATTERN` is the one expression the server scans messages with and it is published
as `codePattern`, which is what the Android client compiles. The key grammar
(`/^[a-z0-9][a-z0-9-]{1,31}$/`) is exactly the set that pattern accepts, so a stored token
cannot be spelled in a way the scanner would miss. Every write is recorded in `admin_audit` as
`EMOJI_CREATE` / `EMOJI_UPDATE` / `EMOJI_DELETE`.

The art itself was imported from two upstream sets (TUILiveKit, MIT; chat-uikit-android,
Apache-2.0 — provenance in `NOTICE.md`) and is carried by the migration, not by a generator:
62 rows in `database/migrations/0016_emoji_characters.sql`, each pointing at a
`/emoji/<key>.webp` file that `scripts/build-emoji-manifest.cjs` writes into `public/emoji/`.
A fresh database therefore gets the picker with `npm run db:migrate`:

    node scripts/migrate.cjs               # schema, including 0016_emoji_characters.sql
    npm run assets:generate                # regenerates public/emoji art + its manifest
    npm run test:e2e                       # group H1b, the checks prefixed "emoji:"

## The level ladder is data too (`/api/admin/ranks`)

There are two numbers on a member and they answer different questions. `users.vip_level` is a
**spend tier an operator assigns**; it is what `gifts.min_vip_level` is compared with. The ladder
is what the member **earns**: `users.xp` resolves to a rung in `rank_levels`
(migration `0017_rank_levels.sql`), and a phone never sees a threshold it would have to guess at.

Experience moves only on server-side writes. `ledger.service.ts` calls `awardXp()` inside the
same transaction that posts a gift, so XP cannot drift from the ledger: 1 per diamond spent,
0.5 per R-coin earned (`Math.floor`, so a half never rounds up on its own). The rates and the
rungs are both published, because an operator may change either without a release.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/ranks` | anyone | `{maxLevel, xpRules, levels: [{level, name, badge, accent, minXp}]}` — active rungs only, ascending |
| `GET /api/admin/ranks` | `user:read` | every row, retired included, plus `membersOnRung` — counted with the same rule `rankFor()` uses, so the screen cannot disagree with a phone |
| `POST /api/admin/ranks` | `config:manage` | `{level, name, badgeUrl, accent, minXp, isActive}` |
| `PUT /api/admin/ranks/:level` | `config:manage` | `level` is immutable; renaming a rung is an update, renumbering is add-then-delete |
| `DELETE /api/admin/ranks/:level` | `config:manage` | members keep their XP and re-resolve downward; level 0 is refused (`rank_last`), because a rung nobody can sit on is a room with no names |
| `POST /api/admin/users/:id/xp` | `user:vip` | `{delta, reason}` — the only way a human moves experience; audited as `USER_XP_ADJUST` with the reason |

Rules the server enforces, each with its own error code: a rung number is `0..20` (the `CHECK`
in 0017), floors must strictly increase (`rank_xp_order` — a rung costing the same as the one
below it can never be shown), level 0 costs 0 (`rank_floor`), `badgeUrl` must be `/…` or
`https://…` (`rank_url_invalid`, because this string is handed to every device that joins a
room), and `accent` must be `#rrggbb`. Writes land in `admin_audit` as `RANK_CREATE` /
`RANK_UPDATE` / `RANK_DELETE`.

Resolution is a boot-time snapshot with stale-while-revalidate after 30 s, the same shape
`theme.service.ts` uses. It has to be synchronous: `toUser()` and `toMiniUser()` run on every
DTO in a room fan-out and cannot await a query. Mini-users get `rank` only where the query
bothered to select `xp` — the seat list stays lean and simply carries no rung.

    node scripts/migrate.cjs               # schema, including 0017_rank_levels.sql
    npm run assets:generate                # public/badges/level-0.png … level-20.png
    npm run test:e2e                       # group H1d, the checks prefixed "rank:"

## How many seats a room gets is the administrator's call

`system_config` key `rooms.seats` holds `{"speakerSeats": 15, "maxSpeakerSeats": 32}` —
the default a new room receives and the most a host may choose. Seat 0 is the host seat,
so `speakerSeats: N` means `N + 1` rows in `room_seats`. Migration
`0012_room_seat_policy.sql` widened the schema checks to `seat_capacity BETWEEN 1 AND 64`
and `seat_index 0..63` and dropped the column DEFAULT, so exactly one number decides
capacity and no client can invent another.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/rooms/capacity` | any client | `{seatCapacity: {min, default, max}, speakerSeats, maxSpeakerSeats}` — the range the create-room form draws |
| `POST /api/rooms` | host | `seatCapacity` is optional; absent, or outside the policy, the platform default wins |
| `GET /api/admin/rooms/seat-policy` | `room:read` | the live policy plus the 64-seat ceiling |
| `PUT /api/admin/rooms/seat-policy` | `config:manage` | writes through `business.writeConfig()`, which self-audits as `SYSTEM_CONFIG_UPDATE` |

A CHECK constraint cannot read `system_config`, so the ceiling stays a hard schema bound
and `room.service.ts` clamps what it reads (`seatPolicy()` → `seatLimits()` →
`resolveSeatCapacity()`): a hand-edited or nonsense config value cannot create a
zero-seat room or exceed 64. Seats are materialised at creation, so an open room keeps
the count it started with. Taking a seat is validated twice — the controller bounds
`seatIndex` against the policy and `room.service.ts` compares it with that room's own
`seat_capacity` — because the row-level check is the one that cannot be raced.

## Room profile and discovery

Migration `0013_room_profile_and_discovery.sql` gave `rooms` three more host-owned
columns — `language VARCHAR(16)` (`^[a-z]{2}(-[a-z0-9]{2,8})*$`), `region VARCHAR(2)`
(`^[A-Z]{2}$`) and `rules VARCHAR(1000)` — plus the two indexes the lobby orderings
need (a partial `transactions (room_id, created_at)` for trending, and
`rooms (status, category, listener_count, created_at)`). Tags are stored normalized so
a filter is an exact comparison instead of `ILIKE` on free text; the shape is enforced
in the schema and the case in `room.service.ts` (`normalizeLanguage` /
`normalizeRegion` / `normalizeRules`), which is also where a malformed tag becomes a
400 rather than a silently-stored string.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/rooms?search=&category=&language=&region=&sort=&limit=&offset=` | any client | Postgres answers the filter and the ordering; `search` matches the title or the room number, `sort` is `popular`, `trending` (diamonds gifted in the last 24 h) or `recent`, and absent keeps each tab's existing order so an older client is unaffected |
| `GET /api/rooms/mine` | host | the caller's own rooms, open ones first, then the recently closed |
| `GET /api/rooms/quick-join` | any signed-in client | the busiest **public, active** room the caller is not already standing in and has not been banned from — so a password room can neither be picked nor bypassed; `404 nothing_to_join` when nothing qualifies |
| `PATCH /api/rooms/:id` | host only (`403`) | title/description/category/language/region/rules. Absent keys are left alone, empty strings clear them |
| `DELETE /api/rooms/:id` | host only | hard delete, but only a closed room that nobody has stood in and that no transaction names — otherwise `409 room_active` / `409 room_has_history` |

`rules` is host-written text shown in the room, not a moderation record; a room's
`like_count`, `listener_count` and ledger history stay server-side authority for the
ordering above. A successful `PATCH` emits `room:profile_updated` carrying the profile
**as it now stands** — a cleared field goes out as `null`, so a member's rule banner
empties instead of keeping the old text. A delete emits `room:closed`, because a client
that still holds the room open needs the same signal it gets when the host closes it.
Deleting is refused rather than cascaded: the ledger keeps every posted entry, and a
room that money moved through is history, not a row to remove.

## Room effects are the server's call

Nothing in this section needs a third-party UI kit: every payload below is a URL
served from `public/` plus a small enum, and the clients decide how to draw it.

| Field                                | Where                                   | What the client does with it                        |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------- |
| `gifts.effect_kind` → `effectKind`   | `GET /api/gifts`, `room:gift_animated`  | `TICKER` scrolls the gift in a 3-row column; `FULLSCREEN` takes the screen over |
| `rooms.like_count` → `likeCount`     | room detail / join / list               | the number under the like button, until the next batch |
| `ambientEffect`                      | every room payload                      | which `public/effects/*.json` loop breathes behind the seats, chosen per category by the `room_category_effects` rows |
| `themeWallpaper`                     | every room payload, `room:theme_changed` | the background to draw — a URL the server resolved from `room_themes`, never a path built from `room.theme` |

`effectKind` is operator-set (`POST /api/admin/gifts`, `PUT /api/admin/gifts/:id`),
never client-set, and an absent or unrecognised value reads as `TICKER` on both
clients — a gift nobody has ruled on must not blind the room.

Likes are socket-only: `room:like { roomId, count }` (1–100 per emit, rate-limited)
lands in a per-room buffer that `services/like.service.ts` flushes once a second as
`room:liked { roomId, count, total, user }`. `count` is the aggregate for that
window and `total` is Redis-backed, so a fast tapper produces one broadcast for the
room instead of ten, and no client ever trusts — or sums — its own taps. Postgres
`rooms.like_count` is the durable copy the room payload serves after a restart.

Joining a room writes one SYSTEM chat row, `"<name> entered the room"`, deduped to
once a minute per member so a reconnect storm cannot push the conversation off the
screen; the visual banner is the client's `room:user_joined`, sized by VIP level.

`GET /api/users/top` answers two boards over the same ledger rows: the default
`role=receivers` ranks who earned r-coins (the room's star) and `role=senders`
ranks who spent diamonds (the gift-panel ranking sheet). The response carries
`window`, `role` and `unit` so a client never has to guess which money it is
looking at, and a role the server does not know falls back to `receivers` — the one
that cannot expose a spender's name to the room.

## External providers

Three switches in `src/config/env.ts`, each with a development default so the stack
boots with no accounts, and each refused at boot when `NODE_ENV=production`:

| Variable                          | Default     | Production requires                                     |
| --------------------------------- | ----------- | ------------------------------------------------------- |
| `SMS_PROVIDER`                    | `mock`      | `twilio` or `vonage` + that provider's credentials      |
| `PAYMENTS_PROVIDER`               | `simulated` | `stripe` + `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` |
| `FCM_PROJECT_ID` + service account | unset      | optional — push stays log-only without it               |

None of them pulls in an SDK; `sms.service.ts`, `stripe.service.ts` and `push.service.ts`
call their providers with global `fetch`, so a sandbox key is the only thing needed to
exercise a real round trip.

Two behaviours worth knowing before pointing a test account at this:

* `SMS_PROVIDER=mock` logs the OTP and `/request-otp` echoes it as `devCode` for the
  demo clients. Configure a gateway and the echo disappears even in development — the
  text is then the only way to get a code. A gateway failure returns
  `502 sms_send_failed`; it never reports `sent: true` for a message that did not leave.
* `PAYMENTS_PROVIDER=stripe` makes `POST /api/wallet/recharge` answer
  `403 payments_provider_is_stripe` and moves credits to
  `POST /api/payments/stripe/webhook`. That route is mounted with `express.raw`
  (re-serialised JSON would not match Stripe's signature), rejects unsigned, forged and
  stale-timestamp payloads, and credits through `ledger.settlePayment()`, which inserts
  a `payment_proofs` row unique on `(provider, external_id)` in the same transaction as
  the balance change — so a redelivered webhook credits nothing. Events with no Voiza
  user reference are acknowledged with 200 and credit nobody.

## Tests

`npm run test:e2e` drives a *running* stack (PostgreSQL + Redis + LiveKit + this API)
through 154 checks: OTP auth, wallet ledger double-spend under concurrency, seat
row-lock contention, the seat policy (the published default, a room created with no
capacity, a refused over-the-max request, an admin rewrite that lands in `admin_audit`,
seats beyond the old hardcoded nine taken and refused, and a 64-seat room accepted by
PostgreSQL), the room profile and discovery (language/region/rules validation, server-side
search and sort, `mine`/`quick-join`, host-only edit, the delete gate, and the
`room:profile_updated` broadcast that reaches a socket already in the room),
LiveKit token/grant enforcement at the SFU, Socket.IO fan-out with
database assertions, gift `effect_kind` and the SYSTEM chat lines it writes, like
 batching (twelve taps must arrive as fewer than twelve broadcasts, and total exactly
twelve), the two ranking boards against the same ledger aggregate, the entry notice and
its dedupe, LiveKit webhook signature trust, VIP gift gating, and the Stripe webhook
path (signature rejection, idempotent credit, replayed delivery) and the media store (an
accepted PNG read back off `/uploads/` byte-for-byte, a script renamed `.png` refused by its
magic bytes, an oversized file refused, identical bytes deduplicated instead of copied, a
traversal-shaped file name stored as text only, a member token refused, and a delete refused
until no gift row points at the file). It exits non-zero on
any failure.

`npm run test:games` (67) and `npm run test:business` (87) run against the same stack:
the game lifecycle, pinned rule versions, fees, at-most-once settlement, timeout
forfeit, disputes and the three drivers; then BD/coin-seller accounts and scopes, the
nine-step recharge, one-time credit, commission versions and statements, reversals and
reconciliation.

`npm run test:wire-fixtures` and `npm run test:game-wire-fixtures` capture the live REST,
socket and game-board payloads into `android/scripts/fixtures/`, which
`android/scripts/run-dto-harness.sh` then replays
through the Android app's own Gson DTOs — the guard against a response-shape change
crashing the mobile client. The games capture opens each table through the same admin rule
editor a real operator uses, then puts every definition back in the shipped free-to-play
posture.

The two provider suites need neither a server nor an account: they replace `fetch` with
a recorder and assert the exact request that would leave the building.

* `npm run test:sms` — 16 checks: Twilio's account-scoped form POST with
  `Basic base64(sid:token)` and a 400 mapped to `502 sms_send_failed`; Vonage's JSON
  body with the `+` stripped, including the trap where it answers **200** with a
  per-message `status: "1"` and must still be treated as a failure; `mock` sending
  nothing at all.
* `npm run test:payments` — 29 checks: the `payment_intents` request (cents amount,
  currency from env, `metadata[voizaUserId]`), a refused intent surfacing as 502
  instead of a silent success, and the webhook signature path (valid, tampered body,
  non-hex digest, missing header, empty body, stale timestamp) plus event parsing.

Two scripts exist to set up and debug a demo rather than to assert:

* `npm run demo:gifts -- <phone>` gives the seeded hosts their `/avatars/*.png`,
  funds `<phone>`, seats it next to `nova_host`, and sends gifts plus one chat line,
  printing the dev OTP so a device can log straight in.
* `npm run webhook:sink` listens on `:4111` and answers LiveKit webhook deliveries,
  reporting whether the `Authorization` header carries `Bearer ` and whether the
  SHA-256 claim matches the body — then replies 500 so redelivery is exercised.

## Conventions

* Controllers stay thin: validate → call a service → broadcast → respond. `asyncHandler`
  removes try/catch; thrown `ApiError`s become `{ error: { code, message } }`.
* Anything that touches money goes through `services/ledger.service.ts` — the only
  module allowed to change a balance, always inside `withTransaction` with row locks.
* DB rows are snake_case, wire payloads are camelCase; every mapping lives in
  `utils/serialize.ts` so a column rename has exactly one blast radius.
* Banned accounts can authenticate but are blocked in `loadUser()` on any room or
  wallet mutation, and get `account:status` pushed over Socket.IO.

## LiveKit rights model

`issueRoomToken()` grants `canPublish` only for `host` and `speaker` levels; audience
members receive subscriber-only tokens and their text/gift traffic goes over Socket.IO.
Muting a seat also calls `updateParticipant({ permission: { canPublish: false } })`, so
the SFU enforces it rather than trusting the client.
