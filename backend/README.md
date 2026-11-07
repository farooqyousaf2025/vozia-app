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
| `GIFT_ANIMATION` | Lottie JSON 2 MB · SVGA 8 MB · MP4 8 MB | per format |
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

## Social graph and room community (migration 0022)

Migration `0022_social_and_room_community.sql` adds the edges a party platform needs
before it is a community: follows, symmetric blocks, a report queue, saved rooms, a
pinned notice, a per-room microphone-approval queue, seat invitations and room
ownership transfer. None of it is a counter column — every count is read from the
edge table, because a block has to delete the follow edges between the pair in the
same breath and a counter would drift.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/users/:id/followers`, `GET /api/users/:id/following` | signed in | a page of the directed follow graph; the public profile only carries the counts |
| `GET /api/users/:id/relationship` | signed in | `{ following, blockedByMe, blockedByThem, interactionBlocked }` for the caller |
| `POST|DELETE /api/users/:id/follow` | signed in | add/remove a follow; refused with `403 interaction_blocked` if either side blocked the other |
| `GET /api/users/blocked`, `POST|DELETE /api/users/:id/block` | signed in | the caller's own block list and the toggle. One row is enough: the block is read in both directions and deletes follows both ways |
| `POST /api/users/:id/report` | signed in | writes a `PENDING` report. A second open report against the same member is `409 report_already_open`; the target is never notified |
| `GET|POST|DELETE /api/rooms/:id/favorite`, `GET /api/rooms/favorites` | signed in | the bookmark flag and the caller's saved rooms, newest first |
| `POST /api/rooms/:id/announcement` | host (or an operator) | pin/clear the notice above the seats (`300` chars); emits `room:announcement` |
| `POST /api/rooms/:id/seat/:index/invite` | host | seat a member already in the audience; emits `room:seat_invited` with a fresh LiveKit token |
| `GET /api/rooms/:id/speaker-requests` | host | the pending microphone queue |
| `POST /api/rooms/:id/speaker-requests/cancel` | requester | withdraw the caller's own request |
| `POST /api/rooms/:id/speaker-requests/:requestId/{approve,reject}` | host | decide one request under row locks; approval seats the member and returns the token through `room:speaker_decision` |
| `POST /api/rooms/:id/transfer` | host | hand ownership to a member present in the room; writes `room_ownership_transfers` and moves both LiveKit grants |
| `GET /api/admin/reports`, `POST /api/admin/reports/:id/review` | operator (`user:read` / `user:moderate`) | the work queue and the decision. `banUser` is a separate flag and is refused together with `DISMISSED` |
| `GET /api/admin/users/:id/social` | operator (`user:read`) | followers, follows, blocks and both directions of reports around one account |
| `POST /api/admin/rooms/:id/announcement` | operator (`room:moderate`) | the override for a notice the host will not take down |

Speaker approval is opt-in per room (`rooms.speaker_approval_required`, default
`false`), so an older client keeps taking a seat immediately. When it is on, `POST
/api/rooms/:id/seat` answers `202 { requested: true, request }` instead of seating the
caller, a partial unique index allows one `PENDING` request per member per room, and
disabling approval cancels the queue rather than leaving requests nobody can decide.
A block is symmetric at the point of use, not at the point of writing: gifts and
follows call `assertInteractionAllowed` and cannot be sidestepped by being the first
to tap. A report is never an automatic ban — filing one writes `PENDING`; only the
operator queue moves it. Filing is the one interaction a block does *not* stop: the
member who was blocked is usually the one who needs the queue, so `createReport`
deliberately leaves the moderation channel open.
`npm run test:social:e2e` drives all of the above against a running stack — 51 checks,
including that a zero-balance gift across a block answers `403 interaction_blocked`
rather than `402 insufficient_balance`, which is the proof the guard runs inside the
ledger transaction.

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

Reactions are socket-only and store nothing: `room:reaction { roomId, key }` asks
`emoji.service.ts` to resolve the key against the operator's `emoji_characters` rows — a 15-second
in-process cache, invalidated by every admin write, so a burst of taps is not a query per tap — and
broadcasts `room:reaction { roomId, userId, key, code, url, label }` to the room. A key with no row
is dropped without a word, an emit is refused from anyone who is not a member of the room it names,
and `rateLimit('reaction:<userId>', 20, 5)` caps how often one member may fire. The client sends a
name and the server answers with the picture, which is what stops a device from animating arbitrary
art in somebody else's room; the worst a stale cache can allow is a code retired seconds ago.

Joining a room writes one SYSTEM chat row, `"<name> entered the room"`, deduped to
once a minute per member so a reconnect storm cannot push the conversation off the
screen; the visual banner is the client's `room:user_joined`, sized by VIP level.

`GET /api/users/top` answers two boards over the same ledger rows: the default
`role=receivers` ranks who earned r-coins (the room's star) and `role=senders`
ranks who spent diamonds (the gift-panel ranking sheet). The response carries
`window`, `role` and `unit` so a client never has to guess which money it is
looking at, and a role the server does not know falls back to `receivers` — the one
that cannot expose a spender's name to the room.

## The gift engine (migration 0023)

The catalogue, the ledger and the socket are the ones that shipped with the app; what 0023 adds is
the information an *animation* needs, and the identity a *paid* gift needs so it can be delivered
twice without buying twice.

| Column | Answers | Read by |
| --- | --- | --- |
| `gifts.animation_format` (`LOTTIE`/`SVGA`/`MP4`) | which player opens `animation_url` | the app's renderer routing |
| `gifts.duration_ms` (0–30 000) | how long the room hands the screen to this gift | the takeover slot and its watchdog |
| `gifts.display_priority` (0–1000) | which waiting gift is displaced | the takeover queue |
| `gifts.combo_enabled`, `combo_window_ms` (1 000–15 000) | whether repeats add up, and inside what window | the combo counter |

The format is never taken from a file name or from what the uploader declared: `media.service.ts`
sniffs the bytes (ISO-BMFF `ftyp` brand for MP4/M4A, ZIP-and-protobuf or `%SVGAFORMAT%` for SVGA)
and the admin panel refuses a row whose renderer cannot open the file attached to it. A row created
before 0023 reads `LOTTIE`, `0`, `0`, `false` — every pre-existing gift keeps playing exactly as it
did, because those are the defaults the clients already assumed.

**Idempotency.** `POST /api/gifts/send` accepts an optional `idempotencyKey` (8–80 `[\w.-]`). It is
claimed in `gift_requests` *before* either account lock is taken, so a replay cannot queue behind
the transaction it is replaying; the row stores `request_hash = sha256(giftId|receiverId|quantity)`
and a second body under one key answers `409 idempotency_key_reused` instead of silently answering
a different gift. A replay returns the original transaction with `replayed: true` and publishes
nothing new — no second ledger row, no second broadcast, no second notification.

**Room scoping.** A gift that names a `roomId` is broadcast there and raises that room's
`total_gift_value`, so inside the two account locks the ledger requires a live
`room_participants` row (`left_at IS NULL`) for *both* halves of the pair — otherwise
`403 not_in_room` / `403 receiver_not_in_room`. Without it any client could point an animation at a
strangers' room and score a room nobody was in. A gift with no `roomId` (profile and DM gifts) is
unaffected, and the app only ever sends from the room screen it is standing in.

**Identity.** The transaction id is broadcast as the event's `eventId`, on `room:gift_animated` and
in every gift-history page, which is what lets a device that saw a gift live drop the same gift when
a reconnect hands it the room's tail. `createdAt` rides the live payload too, so the two paths
describe a gift with the same fields rather than one worse than the other.

**Combos.** `comboId = sha256(room|sender|receiver|gift|windowIndex).slice(0,16)` over a window
aligned to the server clock, counted in Redis (`gift:combo:<id>`, TTL twice the window). The client
sends no counter and receives one, so a tap-storm cannot stretch a window and a reconnect mid-combo
reads the room's number. Each send inside a combo is still its own paid transaction; `combo_enabled
= false` reports `count: 1` forever.

**Catch-up.** `room:join` answers, then emits `room:gift_history { roomId, gifts[] }` to *that
socket alone* — the last 12 gift events, from the ledger, not awaited so a member is never held up
by a history page. The same rows are readable over REST: `GET /api/rooms/:id/gifts?limit=` (≤40,
newest first) and the member's own receipts at `GET /api/gifts/history?limit=&before=&receiverId=`
(keyset cursor on `(created_at, id)`, refused with 403 if the cursor belongs to somebody else).

`npm run test:gift:e2e` (66 live checks) covers the money path under concurrency, idempotency and
replay, the combo window's edges, the catch-up tail against the live event it must match, and the
upload policy's per-format caps and container sniffing.

## What a store row asks for, and what a shelf is (migrations 0024, 0025)

`profile_frames`, `room_themes` and `visual_effects` each gained `min_vip_level SMALLINT` (0–20, the
same bounds as `users.vip_level`) and `recommended BOOLEAN`. The gate is a *spend* gate, not a display
hint: `store.purchase` compares it against the buyer's account rank inside the same locks that read
the balance, and answers `403 vip_required` with `required`, `current` and the item's name in
`details` — so two members with identical wallets get different stores. Browsing is deliberately not
rank-gated: a cosmetic a member cannot afford yet is still a reason to keep playing. `recommended`
decides only what the grid shows first (`store.service.ts` sorts `recommended` before `sortOrder`),
which is why it has no CHECK and defaults to false everywhere: an operator's editorial voice, not a
ranking algorithm.

Migration 0025 turned `gifts.category` from a comment into `gift_categories (key, name, sort_order)`,
with `key ~ '^[A-Z0-9][A-Z0-9_]{1,23}$'` and a **RESTRICT** foreign key from `gifts`. The key is what
every gift row and every historical transaction refers to, so a rename is an edit to `name` and
`category_key_immutable` refuses the other; deleting a shelf that still holds gifts is refused with
`category_in_use` and the names in the way, because silently re-filing them is what an operator would
have to unpick by hand. The seed inserts the four names the schema comment listed and then adopts every
distinct value the catalogue already carries, so a category invented in raw SQL survives the switch
instead of breaking the key. `GET /api/gifts` now answers `{ gifts, categories }` in the operator's
order, and the panel edits the same table at `/api/admin/gift-categories` (`gift:manage`).

## What a member arrives with (migration 0026)

A **ride** is the cinematic that takes the whole screen while a member walks in — separate from the
WELCOME flourish, which plays *behind* the room. It is its own catalogue (`profile_rides`) rather than
a third `visual_effects.kind`, because `kind` is a hard split in code: an AMBIENT loop is chosen by
room category and can never be sold (`effect_kind_not_sellable`), and a ride is a file with a declared
renderer and a hard ceiling on the room's attention — the shape 0023 already settled for gifts.

| Column | Answers |
| --- | --- |
| `url` (`^(/|https://)`) | the file handed to every device in the room |
| `format` (`LOTTIE`/`SVGA`/`MP4`) | which renderer opens it; the `RIDE` media policy accepts all three |
| `duration_ms` (0, or 250–30 000) | how long the room stops for it; 0 defers to the asset's own length |
| `price_diamonds` / `for_sale` / `period_days` / `min_vip_level` / `recommended` | sold and worn exactly like a frame |

Ownership rides the existing `user_items` (member, kind, item_key) with `'RIDE'` added to its CHECK, so
renewal and the expiry sweep carry on unchanged; `users.profile_ride_key` plus the denormalised
`profile_ride_expires_at` are what keep `toMiniUser()` synchronous on the join path. `wornRide()`
resolves those two columns and returns **null** for an account that owns nothing, bought nothing, let
its copy lapse, or wears a key an operator retired — there is no free ride and no fallback art, so a
member with nothing simply walks in. The result publishes as `entryRide` on the account DTO
(`GET /api/auth/me`, and `GET /api/users/:id` as the preview the profile screen shows) and on the
`MiniUser` inside `room:user_joined`, which is what the room plays it from.

Operators maintain it at `/api/admin/rides` (POST/PUT/DELETE, `config:manage`) with
`/api/admin/rides/:key/holders` (`user:read`) answering "who stops playing this if I retire it" — the
receipts survive; the cinematic does not. Writes are refused with `ride_format_invalid`,
`ride_duration_invalid`, `ride_fields_missing`, `ride_exists` and `ride_key_immutable`. The three
seeded rides reuse the already-shipped `public/effects` Lottie scenes (MIT © 2023 Matula José Alberto,
see `THIRD_PARTY_LICENSES/trace-assets/PROVENANCE.md`) rather than naming files a device would 404 on,
and no `recommended` row is seeded — a migration that picked a favourite is the catalogue deciding.

## Lucky gift boxes (migration 0027)

A box is a `gifts` row with `is_lucky_box = true` and `receiver_share_bps`, not a new catalogue: a box
is *sent* — same combo window, same VIP tier, same idempotency key, same `GIFT_SENT` row, all of it
still inside `ledger.sendGift`, because the fastest way to lose one of those guards is to write a
second send path beside it.

The arithmetic, in one transaction and one order:

```
sender pays        diamond_price × quantity          (unchanged from a flat gift)
reward pool        r_coin_value × quantity
per unit           floor(pool_per_unit × multiplier_bps / 10000)   one weighted draw each
receiver banks     floor(gross × receiver_share_bps / 10000)
platform keeps     gross − receiver banks            the residual, never a second dial
```

Storing one dial and deriving the other is the whole point: the obvious `tax_bps` + `receiver_share_bps`
pair lets an operator set 60% and 60% and conjure 20% out of nowhere. `gift_box_outcomes` holds
`label`, `multiplier_bps` (100–1 000 000, so 0.01x to 100x of the pool) and `weight`, and `weight` is a
count rather than a percentage so "1 in 100" is 1 against 99 and no column has to add up to 100.

What the write refuses: `lucky_box_needs_outcomes`, `lucky_box_needs_reward_pool` and
`lucky_box_payout_unbounded` — the last one when `floor(expected_multiplier × receiver_share_bps /
10000) > 10000`, i.e. a box that pays out more than the pool it sells for, with the ratio it computed
in `details.payoutRatioBps`. Also `lucky_box_outcomes_invalid`, `lucky_box_too_many_outcomes`,
`lucky_box_outcomes_without_box` and `lucky_box_not_configured` for a box an operator somehow left with
no prizes, plus `category_*` and the gift price rules that already applied to every row.

Nothing about the send's money identity changes: XP, quests, agency commission and
`rooms.total_gift_value` all read the same `totalRCoins` the roll produced, and the outcomes are
written into that transaction's `meta`, so an idempotent replay answers the gift it already bought with
the numbers the ledger wrote instead of drawing a second time. The live event carries them as
`lucky { outcomes[], headline, grossRCoins, receiverRCoins, platformTaxRCoins, receiverShareBps }`, and
`GET /api/gifts` publishes `chanceBps` per outcome — the derived chance, never the `weight` — so a
phone can print the odds without reimplementing the draw. See *Gift engine* above for the client's side.

## Promotional banners (migration 0028)

A **banner** is operator-run art at one of four fixed surfaces — the splash screen, the home grid, the
top of the gift panel, the game desk. It is one table with a `placement` column instead of four
catalogues, because the four surfaces draw the same shape and differ only in where they hang.

| Column | Answers |
| --- | --- |
| `placement` (`SPLASH`/`HOME`/`GIFT`/`GAME`) | which screen draws it; a client asks for one and never renders a row for another |
| `url` (`^(/|https://)`) + `format` (`PNG`/`GIF`/`WEBP`/`JPEG`/`LOTTIE`/`SVGA`/`MP4`) | the file and which renderer opens it; the `BANNER` media slot accepts all seven and its sniffer refuses a mismatch |
| `duration_ms` (0, or 250–30 000) | how long the surface holds it — a still splash has no length of its own, so somebody has to say when it goes away |
| `cta_type` + `cta_value` | the *verb* the app runs with the target, not a route guessed from a string |
| `starts_at` / `ends_at` | the window a campaign may appear in; a banner that outlived its own date is the failure mode this prevents |
| `is_active` | retire ≠ delete. Switching off keeps `impressions`/`taps` readable; deleting destroys them |

`cta_type` is one of `NONE`, `INTERNAL` (only `HOME`/`STORE`/`WALLET`/`PROFILE` — the four screens a
phone has a route for without naming a resource; a gift panel or game desk belongs to a room, which is
what `ROOM` is for), `ROOM` (a room id) or `URL` (a full `https://` link). The pair's *shape* is a
database CHECK, not a service convention: a row saying `ROOM` and holding a sentence would be a 500 on
every device that asked for it.

`GET /api/banners?placement=` is public — a splash has to draw before the app knows who is signed in —
and returns only live rows: `is_active`, inside the window, and capped at
`MAX_BANNERS_PER_PLACEMENT = 10` per placement via `row_number() OVER (PARTITION BY placement …)`, so a
crowded HOME cannot starve the SPLASH. The `ROOM` clause is the part worth reading twice: a banner
pointing at a room that has closed is dropped from the member list entirely rather than shipped as a
broken navigation, and because rooms close every minute that is a join at read time, not a rule an
operator could have honoured when they wrote the campaign. `POST /api/banners/track` takes `{ id,
event: 'IMPRESSION' | 'TAP' }` behind `requireAuth` — anonymous traffic cannot inflate a count — and
updates only a row that is live this second, else `404 banner_not_live`. Both columns are advisory:
nothing else in the schema reads them and no payout depends on them.

Operators maintain it at `/api/admin/banners` (GET `dashboard:read`; POST/PUT/DELETE `config:manage`)
and the panel screen at `/banners` proves each row is published by re-reading the public list after
every write. Writes are refused with `banner_key_invalid`, `banner_url_invalid`, `banner_format_invalid`,
`banner_duration_invalid`, `banner_window_invalid`, `banner_exists`, `banner_key_immutable`,
`banner_not_found` and, for the tap target, `banner_cta_missing`, `banner_cta_shape`,
`banner_cta_target_invalid`, `banner_cta_url_invalid`, `banner_cta_room_invalid` and
`banner_cta_room_missing` — the last one refuses at the write what the read path would otherwise only
silently hide. The `BANNER` upload kind is registered in `media.service`'s `REFERENCE_SITES`, so
deleting a file a banner still points at answers `409 upload_in_use`.

Seeds: none. A banner is marketing copy over artwork somebody has to hold the rights to, and unlike the
rides and badges there is no art in this repository that would honestly fill a splash screen. An empty
table means every surface shows nothing, which is what a platform with no live campaign should look
like.

## Purpose accounts: the book behind the back office (migration 0029)

Every balance the platform owes or holds, in one place, read from the tables that already owned it.
This is a **projection, not a third wallet**: `fin_accounts` names the holders and
`purpose_account_balances` is a view that reads a user's diamonds from `users.diamond_balance`, a
host's R-coins from `users.r_coin_balance`, BD and seller positions from the commission entries and
settlement batches that already pay them, and platform money from `fin_journal`. No existing money
path was moved, so nothing here can disagree with the wallet that was already authoritative — and
every account carries `balance_source` for exactly that reason: a figure with no provenance is not
auditable.

The identity that makes the book worth trusting is

```
opening = balance − (lifetime_in − lifetime_out)
```

so `opening + ΣIN − ΣOUT` reproduces the balance from any statement the API returns. `opening` is
reported rather than assumed to be zero: for an account whose coins all arrived through recorded
movements it is zero, and where it is not, it is the amount granted before this book existed. Naming
it is what keeps a seeded balance from becoming a permanent unexplained difference.

Three books, three statement shapes, because there genuinely are three — inventing a fourth would
mean two definitions of "paid". The user and host books read the `coin_movements` view restricted to
`status = 'COMPLETED'`, which is precisely the set the balance view counts as lifetime. A PENDING
withdrawal is deliberately absent: the R-coins have already left `r_coin_balance` and are reported
as `pending`, so listing them as an outflow would charge a host twice for the same escrow. The
payable book emits three legs — accruals in, one `COMMISSION_REVERSAL` out per reversed entry, one
out per `PAID` settlement — with the counterparty always the *other* side of the order, and the same
`legs` expression serves the page and the count so the two cannot disagree.

`GET /api/admin/accounts/reconcile` asks whether each account can explain itself. An ERROR is a
contradiction between two tables, never a comparison of an account against the number the view just
read from it: `account_source_missing`, `frozen_exceeds_available`, `payable_state_conflict`,
`withdrawal_state_conflict`, `withdrawal_paid_step_missing`, `journal_entry_invalid` and — since 0031 —
`platform_revenue_not_booked`, which counts gifts and settled games whose spread has no journal entry
(see "What a gift keeps is now in the book"). The INFO findings are both true-but-unbooked figures the
operator needs to see rather than trust: `opening_not_explained_by_ledger`, a seeded opening balance the
ledger never moved, and `account_not_yet_opened`, a book that is legitimately empty. The one named money
gap left, an approved withdrawal with no paid step, is real and is open work (#53), not an artefact of
the query.

### The endpoints

| Route | Permission | Notes |
|---|---|---|
| `GET /admin/accounts` | `account:read` | category / ownerKind / ownerId / status / currency / search / `onlyWithPosition=true`, paged |
| `GET /admin/accounts/reconcile` | `account:read` | `?format=csv\|xlsx` for a two-sheet workbook |
| `GET /admin/accounts/holds` | `account:read` | across the book, `?status=OPEN\|RELEASED\|CONVERTED` |
| `GET /admin/accounts/:code` | `account:read` | either shape: `CATEGORY:owner`, or a colon-less platform ledger name like `COIN_LIABILITY` |
| `GET /admin/accounts/:code/movements` | `account:read` | `?from=&to=` ISO window; `?format=csv\|xlsx`; `?limit=` up to 200 |
| `GET /admin/accounts/:code/holds` | `account:read` | |
| `POST /admin/accounts/:code/holds` | `account:manage` | `{ kind, amount, reason, idempotencyKey }` → 201, or 200 with `replay: true` |
| `POST /admin/accounts/:code/status` | `account:manage` | `{ status, reason }`; anything but ACTIVE needs a reason ≥ 8 chars |
| `POST /admin/holds/:id/release` | `account:manage` | `{ idempotencyKey, convertTo? }` |

**There is deliberately no balance-editing route in this router.** `POST /admin/users/:id/balance`
stays the only manual money path in the product, because two entry points for the same act means two
sets of guards and the weaker set is the one used at 02:00. What this router can do is hold,
release, suspend and ask questions — actions that constrain money without inventing it. A hold is a
row with a reason and an author rather than a number written on an account, so a release has a
history; freezing more than the owner can currently spend is refused with `freeze_exceeds_available`.

Reading and deciding are split across two permissions on purpose: an operator who can see that a BD
balance does not reconcile should not thereby gain the right to freeze it. `SUPER_ADMIN` holds both,
`FINANCE_ADMIN` holds both, `OPERATIONS_ADMIN` holds only `account:read`, and `MODERATOR` holds
neither — the book contains platform and partner money, which is not a moderation concern.

One constraint the accounts work surfaced for #58: **an operator who has acted cannot be deleted.**
`admin_audit.admin_id` is `ON DELETE SET NULL`, but `admin_audit_actor_present` requires an actor on
every row, so removing the link fails the check and the whole delete rolls back — the suite pins that
as `node scripts/account-e2e.cjs`'s last assertion. An audit trail that survives the deletion of the
person who wrote it is the right trade, and it means admin CRUD has to offer deactivation, not
delete. Migration 0030 is that deactivation.

Mutations are replay-safe. `idempotent_requests` has `PRIMARY KEY (scope, key)`, and a second
attempt with the same key returns the first attempt's stored result rather than repeating the action;
a claim that exists but has published no result answers `409 idempotency_in_flight` rather than being
reported as a success it did not earn. Hold creation and hold release accept the caller's
`PoolClient` so the claim and the action commit **in one transaction** — without that, a failure
after the action would leave the money moved and the key permanently claimed. An attempt that
rolls back leaves no row behind, which is what makes the next retry possible.

### The exports, and why they are hand-written

`?format=csv` and `?format=xlsx` on the statement and the reconciliation report.
`src/utils/workbook.ts` writes OOXML directly: an `.xlsx` is a ZIP of XML parts, so the binary
discipline needed is a correct CRC-32 and central directory per entry, and npm does not run on the
development machine, which removes the library option. One column definition feeds both writers, so
the CSV and the workbook cannot disagree about a figure. `int8` and `numeric` arrive from node-pg as
strings, so a column marked `numeric` writes them as real numbers — otherwise an exported statement
lands in Excel as left-aligned text that cannot be summed — and a value that does not parse stays
text rather than silently becoming zero. The CSV carries a UTF-8 BOM, which is what makes Excel read
it as UTF-8 instead of Windows-1252.

A page of the statement route is at most 200 rows and an export is one page, so the whole book is
walked page by page — which is also how `node scripts/account-e2e.cjs` proves the identity over a
926-movement account instead of over the first screenful of it. That suite opens each workbook the
way a spreadsheet program does: it walks the ZIP's local headers, inflates every entry and
recomputes its CRC-32. Checking the checksum rather than grepping the buffer matters — a wrong CRC
is invisible to `grep`, survives a lenient extractor, and reads in Excel as a damaged file.

### Deployment note

Migration 0029 was corrected after it had been applied to the development database: the first
revision gave `idempotent_requests` no primary key at all, so the `ON CONFLICT (scope, key)` guard
raised `42P10` the first time it was exercised, and the payable lifetime columns were restated gross
of reversals so a reconstructed statement equals the balance it claims. `scripts/migrate.cjs --force`
re-accepts the checksum but does **not** re-run the file, so any environment that ran the original
revision needs those two changes applied by hand.

The same applies to the first `?format=xlsx` builds: `crc32()` indexed its table by the raw byte
instead of `crc ^ byte`, so every entry carried a checksum its own content did not satisfy. The rows
inside those files were correct — the numbers, the BOM and the CSV were never affected — but the
archives were not standards-conformant, so any workbook exported before that fix should be
re-downloaded rather than repaired.

Not yet built: the PAID step on withdrawals (#53), and booking the coin *issuance* side of demo-mode
recharges and admin balance grants, which move wallets without a journal line (#60).

## The operator roster is a switch, not a bin (migration 0030)

`admins` gained `is_active` and `disabled_at`, and the router gained six routes. Nothing else about
an operator changed, and that is the point: this is the one surface that decides who can change
every other surface, so it is built around two refusals rather than around editing.

**An operator is switched off, never deleted.** The constraint the accounts work ran into is general:
`admin_audit.admin_id` is `ON DELETE SET NULL` while `admin_audit_actor_present` requires every row
to keep naming an actor, so deleting anyone who has ever written something fails with `23514` and
rolls back. A history that survives the person who wrote it is the right trade, and it means the only
lifecycle this table can offer is deactivation. There is no DELETE route to match the database.

**A disable is read on every request, not remembered at sign-in.** The operator token is a signed
twelve-hour JWT that says nothing about a switch thrown after it was issued, so `requireAdminOperator`
and `requirePermission` re-read the row — which they already did for the role, so the check costs
nothing. The consequence is worth stating plainly in both directions: a token held by a disabled
operator is refused by the very next request, and a role raised after a login takes effect for the
token that was already issued. `POST /admin/login` and the `ADMIN_BOOTSTRAP_OTP` branch of
`POST /auth/verify-otp` answer `403 operator_disabled` for the same reason, and the bootstrap phone is
a way in for a new VPS, not a way back for an operator who was switched off.

Migration 0030 also pins the invariant in the table, not only in the code:
`CHECK (is_active = (disabled_at IS NULL))`. Two columns that can disagree are two columns where a
bug chooses which one wins.

### The endpoints

| Route | Permission | Notes |
|---|---|---|
| `GET /admin/operators` | `operator:manage` | `?search=` (username or display name, ILIKE), `?role=`, `?active=ALL\|ACTIVE\|DISABLED`, paged ≤100; active first |
| `GET /admin/operators/roles` | `operator:manage` | every role with the permissions `ROLE_PERMISSIONS` actually grants it, read live |
| `POST /admin/operators` | `operator:manage` | `{ username, password, role, displayName? }` → 201 |
| `PUT /admin/operators/:id` | `operator:manage` | `{ role?, displayName? }`; an update that changes neither is `nothing_to_update` |
| `POST /admin/operators/:id/disable` | `operator:manage` | `{ reason }`, at least 8 characters |
| `POST /admin/operators/:id/enable` | `operator:manage` | `{ reason? }` |

`operator:manage` is a new permission and it sits on `SUPER_ADMIN` alone. It is deliberately not folded
into `config:manage`: an operator who can change the money switches is not thereby entitled to hand
out the credential that changes them. `GET /admin/operators/roles` is ordered before
`GET /admin/operators/:id` for the same reason the account routes are — a literal path that only
works because of route ordering breaks the first time someone renames a parameter.

Two refusals protect the platform from its own operators, and both run inside the transaction that
writes the change:

* `cannot_disable_self` — you cannot switch off the account you are signed in as. Another
  super-admin has to do it, which is also the only way the act gets a second pair of eyes.
* `last_super_admin` — the final **active** super-admin can neither be disabled nor demoted, because
  `operator:manage` lives only on that role and losing it leaves no credential that can undo the
  change. The check first `SELECT … FOR UPDATE` every active super-admin row, so two operators
  demoting two different supers at the same moment cannot both conclude that a third is still around.
  A demotion that changes nothing about the super-admin count does not pay for those locks.

There is no password route in this router. Rotating an operator password needs that operator's own
credential, and an administrative reset without it is a way to take an account while leaving no reason
behind; until a supervised reset with its own audit trail exists, the route is the operator's own
`POST /admin/change-password`. Every roster write records `OPERATOR_CREATE`, `OPERATOR_UPDATE`,
`OPERATOR_DISABLE` or `OPERATOR_ENABLE` with the actor, the target id and — for a disable — the reason.

The DTO carries `roleStored` beside `role`: a row seeded before the vocabulary existed stores `SUPER`,
which the guards apply as `SUPER_ADMIN`, and a screen that shows only the normalised value would hide
an account whose stored value still needs migrating.


## What a gift keeps is now in the book (migration 0031)

Two money paths have always taken a cut and never said so. A gift pulls diamonds from a sender and
banks R-coins to a receiver in one ledger row; the difference is the platform's — the catalogue spread
on a flat gift (Teddy: 50 diamonds in, 45 out) or the tax drawn on a lucky box. A settled game keeps
its entry fees minus whatever the prize ladder distributed. Both moved coins; neither was worth a
journal line, so `GET /api/admin/accounts/reconcile` reported an empty revenue account beside a ledger
showing millions of diamonds spent.

**One rate, owned by the operator.** Pricing a coin in a money book needs a money value for a coin, and
the platform had exactly one — `STRIPE_CENTS_PER_DIAMOND`, inside the payment provider's configuration,
describing only what a top-up pack costs. It moves to `system_config` as `accounts.coinValue`
`{"minorPerCoin": 10}`, alongside the withdrawal and promotional switches 0029 seeded, with the default
set to the number the code hardcodes today. One row and one number, read by both the write path and the
backfill, is what makes a derived-versus-booked comparison honest: if the writer used `env` and the SQL
used config, changing the rate would make the reconciler cry wolf. `0` is a meaningful value — the book
does not value coins — and the writers then post nothing rather than inventing a rate.

The rate is read with the caller's `PoolClient`, not through `readConfig()`: that helper takes a
connection from the pool, and a money transaction already holds one, so using it here would put a second
connection on the critical path of every gift send and stall the pool under load.

**Three legs per entry.** `GIFT_TAX` is keyed on `transactions.id`, `GAME_TAKE` on the `game_sessions.id`
whose settlement produced it, and the book's `UNIQUE (source_kind, source_id)` index is the idempotency
key:

| Leg | Direction | What it states |
|---|---|---|
| `COIN_LIABILITY` | DEBIT `released × face` | the diamonds that left circulation |
| `COIN_LIABILITY` | CREDIT `minted × face` | the R-coins created in their place |
| `PLATFORM_REVENUE` | CREDIT `spread × face` | what the platform kept |

A gift with no spread books nothing — Rose is 1:1, and two liability lines that only cancel each other
are noise, not a record. A quantity of three books one entry for the whole send, and a retried send —
same `idempotencyKey`, so the same transaction id — answers the original receipt and adds no second
entry.

**A negative spread is a loss, and it is booked as one.** `validateLuckyBox` bounds the *expected*
payout of a box, not the drawn one: a 20x tail can pay out more than the pool its price bought. That
gap is real money leaving the platform, so the revenue line becomes a DEBIT. Dropping it would report
the platform as having kept a spread it actually paid for, which is the more expensive mistake.

**History was backfilled, not forgiven.** The migration's second statement walks every completed gift
and every settled session with no entry, writes `JR-BF-` references, and lands on a `PLATFORM_REVENUE`
balance that equals the ledger's own spread at the configured rate (2,577 entries on the development
database, one of them a genuine box loss). It is idempotent twice over: the `missing` CTE only selects
rows without an entry, and the unique index rejects a second one.

**The writer is atomic, and had to be.** `postJournal()` used to look up and insert the header over the
pool while its lines went through the caller's client. A send that rolled back afterwards — an
unaffordable gift, a failed guard — would therefore commit a header with no lines, which is exactly the
"credit committed, journal missing" failure the function exists to prevent. Both now use the caller's
client, and `node scripts/revenue-e2e.cjs` asserts the stronger property over the whole book: every
`GIFT_TAX` entry names a transaction that exists, before and after a refused send.

### What the reconciler says now

`platform_revenue_not_booked` was an INFO finding that asked whether the revenue account balance was
zero — a proxy that went quiet as soon as one entry existed, and forgave all of history. It is now an
ERROR that counts rows: completed gifts whose diamonds and R-coins differ, plus settled games whose pool
and payout differ, each without a journal entry. The count is in **coins, never minor units**, because
multiplying history by today's face value would report an amount the journal never posted. With the
spread booked as it is written, that finding has nothing to say.

One consequence is worth stating before someone meets it in a report: `COIN_LIABILITY` is now a running
total rather than a pile of credits, so a stack that minted diamonds through demo-mode
`POST /api/wallet/recharge` or `POST /admin/users/:id/balance` — paths that create no recharge order and
therefore no journal line — shows a negative balance. The debit side is correct; the issuance side was
never booked. Closing that is #60's job (promotional grants need the same treatment), and it is visible
on any development database long before it would be on one running real payment orders.


## The socket speaks for a member, and a password is guessed slowly

`joinRoom` is the moderation gate: it refuses a closed room, a banned account and a
removed member. Until now the socket had its own door — `room:join`, `room:chat` and
`room:like` trusted whatever the connection claimed — so a user the host had just
removed could stay in the party by never making the REST call again, and could keep
broadcasting lines into a room they were kicked out of. `assertMayAttendRoom()`
(`room.service.ts`) is the same three questions without the LiveKit token and seat
snapshot, and `socket.service.ts` now asks it before attaching a socket to a room and
before storing a chat line. A refusal arrives as an ack, not a disconnect:
`not_a_member` ("Join this room before following it") and `room_banned`.

Two deliberate edges:

* On `room:join` the gate runs *before* the previous room is dropped, so a refused hop
  cannot cost a member the room they are already standing in.
* `room:like` checks participation only when the payload names a room other than the one
  the socket was accepted into — a like burst is 40 emits per 10s and the validated room
  needs no re-reading. Chat pays four queries per message and is capped at 15 per 10s.

An operator password, unlike a phone OTP, has no short-lived code to blunt a guess. Both
`POST /api/auth/login` and `POST /api/business/login` are now throttled through the
existing `rateLimit()` bucket helper at **10 attempts per minute per IP and account**,
returning `429` when exceeded. Bucketing on the pair as well as the address is what keeps
one busy office NAT from locking out every operator behind it.

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
through 401 checks: OTP auth, wallet ledger double-spend under concurrency, seat
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
until no gift row points at the file), then the four catalogues that became data in 0024–0027: the
shelves a gift can be filed under (key immutable, `category_in_use` naming what sits on a shelf, the
public list shipped beside the gifts), the operator's gift revenue window (summed from the ledger, not
from the page, unattributed rows counted separately, a member refused the view), a cosmetic's rank gate
and recommended flag, entrance rides (container refused unless the sniffer agreed, the 250 ms–30 s
budget enforced, bought through the same ledger primitive as a ring, the worn key resolving again the
moment it is put back, every write audited), and lucky boxes — the write that refuses odds paying more
than the box sells for, twenty boxes costing exactly twenty prices, the roll floored per unit and
written into the receipt, a replay answering the roll it already bought, and the room being told the
same numbers the ledger paid. It exits non-zero on
any failure.

`npm run test:games` (69) and `npm run test:business` (87) run against the same stack:
the game lifecycle, pinned rule versions, fees, at-most-once settlement, timeout
forfeit, disputes and the three drivers, and since 0031 the journal leg of a settled pool — one
entry, priced at the configured face value, and no entry at all for a free match; then BD/coin-seller
accounts and scopes, the nine-step recharge, one-time credit, commission versions and statements,
reversals and reconciliation, with the revenue account pinned to holding only the coin spread.

`npm run test:accounts` (58) and `npm run test:operators` (44) need that stack running too. The
accounts suite walks the whole book rather than a page of it: the projection identity
`opening + ΣIN − ΣOUT = balance` on a 926-movement account, one statement leg per currency rule, the
reconciliation findings a clean database should not raise, idempotent hold create/release including
the `idempotency_in_flight` answer, the per-role permission split, and the two exports opened the way
a spreadsheet program opens them — ZIP local headers, every entry inflated, CRC-32 recomputed. It ends
by proving an operator with audit history cannot be deleted (`23514`).

The operator suite is mostly the same fact from the other side: that the switch is a switch. The two
checks worth reading first are that **a token issued before a disable is refused by the next request**
— twice, on a mutation and on a plain read — and that **a role raised after a login applies to the
token already in the operator's hand**. Both fall out of one design decision, every admin request
re-reads the row, and each breaks the moment someone caches it, lengthens the token or starts trusting
the `role` claim. The rest cover the roster shape and search, the role catalogue read live from
`ROLE_PERMISSIONS`, username and password validation, `cannot_disable_self`, `last_super_admin` with a
second super-admin on either side of it, the schema's own flag/timestamp check, and that every write
is audited by its own verb with the right actor. It leaves the four operators it created disabled — it
cannot remove them, which is the reason the feature exists — so run it against a development database.

`npm run test:revenue` (25) is the 0031 suite, and it is the only one that reads the journal rather than
the wallet. The checks worth reading first are the two that bookkeeping lives or dies on: that a send
the sender could not afford leaves **no** entry behind, orphan header included — which holds only
because the writer is atomic — and that each of twelve lucky-box draws books an entry whose numbers come
from the roll that receipt records, not from the box's advertised average — and when a roll lands past
the pool, that the entry's revenue leg is a DEBIT, which the run has watched happen for real rather than
only proving it with a hand-made overpaying gift.
The rest price a Teddy send against the catalogue (not against the ledger row, which would be a
tautology), confirm the revenue account moved by exactly the spread, confirm a 1:1 gift books nothing,
confirm a three-gift tap books one entry and a retry of the same `idempotencyKey` books it once, then
close the whole book: no unbooked gift or game anywhere, revenue equal to the ledger's spread at the
configured rate, no `platform_revenue_not_booked`, Σdebits = Σcredits, and the entry visible on
`GET /admin/accounts/PLATFORM_REVENUE/movements`. It creates two probe gifts and deletes them, and sends
from time-stamped phone numbers, so it needs a development database too.

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
