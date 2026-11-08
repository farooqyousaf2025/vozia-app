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
               · partner-application (the four forms, the queue, what an approval activates)
  routes/      one router per domain, mounted under /api
  middleware/  auth (requireAuth / requireAdmin), error (ApiError + pg code mapping)
  utils/       crypto (scrypt, codes, room numbers) · http (validation) · serialize (DTOs)
  types/       db.ts row shapes
scripts/       e2e-live.cjs · games-e2e.cjs · business-e2e.cjs · partner-e2e.cjs
               · capture-wire-fixtures.cjs · capture-game-wire.cjs · generate-placeholder-assets.cjs
               · demo-gift-chat.cjs
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
`status = 'COMPLETED'`, which is precisely the set the balance view counts as lifetime. A PENDING or
APPROVED withdrawal is deliberately absent: the R-coins have already left `r_coin_balance` and are
reported as `pending`, so listing them as an outflow would charge a host twice for the same escrow. The
payable book emits three legs — accruals in, one `COMMISSION_REVERSAL` out per reversed entry, one
out per `PAID` settlement — with the counterparty always the *other* side of the order, and the same
`legs` expression serves the page and the count so the two cannot disagree.

`GET /api/admin/accounts/reconcile` asks whether each account can explain itself. An ERROR is a
contradiction between two tables, never a comparison of an account against the number the view just
read from it: `account_source_missing`, `frozen_exceeds_available`, `payable_state_conflict`,
`withdrawal_state_conflict`, `journal_entry_invalid` and — since 0031 —
`platform_revenue_not_booked`, which counts gifts and settled games whose spread has no journal entry
(see "What a gift keeps is now in the book"). The INFO findings are true-but-unbooked figures the
operator needs to see rather than trust: `opening_not_explained_by_ledger`, a seeded opening balance the
ledger never moved, and `account_not_yet_opened`, a book that is legitimately empty. Since 0032 the
withdrawal queue adds one more: `withdrawal_awaiting_payout`, the total of what has been accepted and
not yet sent — real money owed, and open work rather than an artefact of the query.

Since 0033 the agency book adds five, each of them a disagreement between two tables rather than
between an account and a view of itself: `settlement_claim_mismatch`, a batch that states an amount its
own claim rows do not add up to; `settlement_payout_unbooked`, a `PAID` batch whose transfer the journal
has no entry for, and its opposite `settlement_booked_early`, an entry describing a payout for a batch
still awaiting approval — the journal moves when the transfer is recorded, never when the figures are
signed off, so either order is a contradiction; `agency_commission_not_booked`, a commission
`transactions` row whose `AGENCY:` account never received the matching journal line; and
`agency_book_orphan`, a journal entry booked against an agency that no longer exists. The fourth of
these softens itself to the INFO `agency_commission_unpriced` while `accounts.coinValue` carries no face
value, because an accrual that cannot yet be priced is work waiting for a dial, not a broken book.

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

Not yet built: booking the coin *issuance* side of demo-mode recharges and admin balance grants, which
move wallets without a journal line (#60). The withdrawal PAID step this list used to carry is built —
see "A withdrawal is paid, not promised (migration 0032)".

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

One consequence is worth stating before someone meets it in a report: `COIN_LIABILITY` is a running total
rather than a pile of credits, so it can read negative. Demo-mode `POST /api/wallet/recharge` and
`POST /admin/users/:id/balance` mint diamonds that no entry recognises, because both collect nothing and
neither creates a `payment_proofs` row to key one on — the debit side is real spend, the issuance side was
operator fiat. #60's promotional balance is what gives a grant a contra account of its own. What is no
longer missing is the half that was never a policy choice: a payment the provider confirmed is booked by
the primitive that credited it, which is the next section.


## A withdrawal is paid, not promised (migration 0032)

The queue had three states and used two. A host asks for R-coins, the escrow leaves
`users.r_coin_balance` at that moment, an operator approves, and the approval flipped the
`transactions` row to COMPLETED — the ledger declaring the money gone, with no row anywhere saying who
sent it, when, or under what reference. `PAID` has existed in the enum since `schema.sql:56` and
nothing had ever written it.

The gap was not cosmetic. `purpose_account_balances.pending` counts PENDING **and** APPROVED requests,
while `coin_movements` counts the outflow only from a COMPLETED ledger row, so the instant the old
approval ran the same R-coins were both still owed and already gone: `opening + ΣIN − ΣOUT` started
disagreeing by exactly that amount, and the reconciler reported it as an unexplained opening rather
than as the missing step it was.

**The outflow is recognised where the money actually leaves.**

| Step | Route | `withdrawal_requests` | `transactions` (WITHDRAWAL) | Host wallet |
|---|---|---|---|---|
| Request | `POST /api/wallet/withdraw` | `PENDING`, fee frozen | `PENDING` | gross deducted (escrow) |
| Accept | `POST /admin/withdrawals/:id/review` `{approve:true}` | `APPROVED` | `PENDING` | unchanged |
| Refuse | same, `{approve:false}` | `REJECTED` | `REVERSED` | gross returned |
| Pay | `POST /admin/withdrawals/:id/pay` | `PAID` + evidence | `COMPLETED` | unchanged |

Refusal is reachable from APPROVED as well as PENDING: the escrow leaves at the request, not at the
payout, so an operator who accepts and then finds the bank details wrong has to be able to hand the
R-coins back. Approval is refused from any other state (`withdrawal_not_pending`), and Pay only accepts
APPROVED (`withdrawal_not_approved`) — a transition table enforced in the service and pinned by the
suite, because the states are also reachable by raw SQL and the enum will not stop a wrong one.

**The fee is decided when the host asks.** `accounts.withdrawal` in `system_config` is the dial —
`{minRCoins, feeBps}` — seeded by 0029 with the note "Replaces the `MIN_WITHDRAW_RCOINS` environment
variable once the ledger reads this", and this is the change that lets the ledger read it.
`Math.floor(amount × feeBps / 10_000)` is computed at request time and **stored on the row** in
`fee_r_coins`, so the number the wallet screen showed is the number charged even if the operator
reprices the dial while the request sits in the queue. It is a cut of this withdrawal, never a charge on
top: `amount_r_coins` stays gross, the escrow is gross, and net = gross − fee.

**The dial is read out with the wallet.** `getWallet` returns `withdrawalPolicy: {minRCoins, feeBps}`
beside the balances it already sent, taken from the same `withdrawalPolicy()` call the request path uses,
so the app quotes the terms it will be charged rather than a number it guessed. It is a published dial, not
a promise: the row's stored `fee_r_coins` is still what the ledger books, and `serialize.ts` computes
`netRCoins` server-side so no client adds up its own payout. A backend that does not send the field leaves
the Android sheet silent about the minimum instead of inventing one.

Because `writeConfig()` replaces the whole JSON blob rather than merging a key, a dial write must send
the complete object; the route validates the pair (`partner-admin.controller.ts`'s `CONFIG_DIALS`), so a
`{"feeBps": 1e9}` that would take every R-coin in the account is refused with `bad_config_value` before
it lands. The service then re-checks each field on read and falls back to the shipped default, because
the same row can be edited with `psql`. Two guards, one for the console typo and one for the honest
database.

**Only the fee is journaled.** `payWithdrawal` posts `WITHDRAWAL_FEE` — DEBIT `COIN_LIABILITY` / CREDIT
`PLATFORM_REVENUE`, `fee × minorPerCoin` — through the same `postCoinSpread` the gift spread and game
take use, keyed on the withdrawal id so a retried Pay cannot book the cut twice. The payout itself gets
**no cash leg**: there is no bank account, no payment rail and no FX rate in this stack, so the book
cannot price the transfer without inventing one. The consequence is stated rather than hidden — the net
stays inside `COIN_LIABILITY` after PAID, and `payout_reference` is the evidence that it left. A zero-fee
request posts no entry at all, which is `postCoinSpread`'s existing rule for a spread of zero.

**Evidence is a column, not a note.** `withdrawal_requests_paid_step_evidence` refuses a PAID row with
no `paid_at` and no `payout_reference`, and the route requires a reference of at least three characters
before it will call the service — pressing Pay by accident is far easier than remembering a month later
which transfer paid which request. `withdrawal_requests_fee_within_amount` bounds the fee inside the
amount. `paid_by` references `admins` with `ON DELETE SET NULL` and is deliberately outside the CHECK:
`admin_audit` records who pressed Pay, and a later-disabled operator account must not blank a payment
that happened.

**History was restated toward the ledger, not away from it.** The migration's last statement marks an
APPROVED request whose ledger row is already COMPLETED as PAID, taking `paid_at` from `reviewed_at`
because that is the last time the system genuinely knew anything, with a reference that says plainly it
is a restatement. Reverting the ledger row to PENDING would rewrite what the wallet already did —
`transactions` is the append-only record of the escrow leaving. On the development database zero rows
matched; on a stack with withdrawals in it, this is what keeps the reconciler from reporting yesterday's
payouts as open work. (Any environment that ran an older build should re-check that count: a restated
row is a row the payout queue will now show as closed.)

### What the reconciler says now

`withdrawal_paid_step_missing` is gone, along with the ERROR it produced on every accepted withdrawal.
`withdrawal_state_conflict` remains and now enumerates four disjoint shapes — PENDING or APPROVED
without a PENDING ledger row, PAID without a COMPLETED one, REJECTED without a REVERSED one — so it
fires only on a real contradiction between the two tables. `withdrawal_awaiting_payout` is one aggregate
INFO: how many accepted requests await a payout, their total, and the date the oldest was accepted. The
split is deliberate; a queue of unpaid work is true and open, so it belongs in one line, while a
disagreement between books is per row and needs an id.

### The read path opens the account it is asked about

Testing the fee surfaced that `accountFor()` — the lazy "open the owner's book on demand" helper 0029
wrote and commented as the intended read path — had no callers at all. 206 of the development database's
932 users therefore had no purpose accounts, and `GET /api/admin/accounts/HOST_RCOIN:<new-user>` answered
404 for every one of them. `account.controller.ts`'s `readAccount()` now splits a `CATEGORY:owner` code
and opens the book before reading it, wired into both `detail` and `movements` — the latter because the
CSV and workbook exports hit that route without ever going through `detail` first. Platform codes, which
have no owner to open a book for, keep going straight to `findAccount`.

Accounts are still created on first read rather than in a backfill, so a book whose owner has never been
looked at does not exist yet. That is a defensible rule for a projection nobody has asked about, but it
means `GET /admin/accounts?onlyWithPosition=true` under-reports the platform's own hosts until someone
views them.

### Routes, permissions and the panel

Accept, refuse and pay all sit behind the single `withdrawal:review` permission rather than a separate
`withdrawal:pay`. The dial that permission turns is "you may decide the fate of a withdrawal", and
releasing the money is the last of those decisions, not a different kind of one; what the split *does*
buy is two rows in `admin_audit` — `WITHDRAWAL_REVIEW` and `WITHDRAWAL_PAY` — so who accepted and who
actually paid stay distinguishable forever. `GET /api/admin/config/:key` reads the dial under
`finance:read` and the write needs `config:manage`, which is the existing pairing for every other money
setting.

The panel's `/withdrawals` page shows the fee and the net under the amount, offers Pay only on APPROVED
rows, requires a reference before the button enables, and states in the review modal what accepting
promises ("the host is owed …"). `PolicyCard` on the same page edits the dial and recomputes a worked
example live, so an operator sees that a R 100k cash-out would pay X and keep Y before saving it.

`node scripts/account-e2e.cjs` walks the whole thing over HTTP with SQL spot-checks: the dial refuses a
partial, out-of-range and non-numeric write and stays unmoved after each; a request below the minimum
fails with the *dial's* number in the message, not the environment's; the projection identity is
re-asserted at all five lifecycle points; Pay refuses a missing reference and a `MODERATOR`; the fee
journal is two balanced legs; a reject-after-approve returns the gross; and the reconcile report ends
with zero withdrawal ERRORs. `coin_movements` is read with `Number()` coercion — Postgres returns
`COUNT(*)` as a string, and a `rows[0].n === 2` assertion silently fails on `"2"`.

## An agency's share is booked, then settled (migration 0033)

Before this, `agencies.commission_bps` was a number the panel could edit and nothing else read: a gift
sent to a host on a roster changed nobody's balance. It is now a liability with an account behind it, and
clearing it is a lifecycle an operator can be audited through.

**The accrual rides the gift send.** A send that pays a roaster-host writes a `transactions` row of type
`AGENCY_COMMISSION` holding the commission in **R-coins** — the unit an agreement is negotiated in — and
the journal entry DEBIT `COMMISSION_EXPENSE` / CREDIT `AGENCY:<uuid>` priced at that moment's face value,
keyed `(AGENCY_COMMISSION, transactions.id)` so a retried send cannot owe the agency twice. The two units
are both kept on purpose: the account is in paisa because it is settled in paisa, while `accruedCoins` is
what an agency and a host actually argue about, and the reconciler needs the pair to say "this 20 R-coin
share is worth 200 pkr at today's dial".

**A rate that can be absent.** Both rate columns used to be `NOT NULL DEFAULT 1000`, which made every row
look agreed and the platform fallback unreachable; a row still holding 1000 has never been agreed to
anything (no code outside `seed.sql` wrote either column, and the seeded roster is 1500 / 1200 / 1500), so
0033 drops the defaults and nulls exactly those rows. Precedence is then a chain the server resolves per
send — this host's rate, then this agency's, then `accounts.agency.defaultCommissionBps` — and a `NULL`
means "say nothing", not "zero". When every level is absent or `0`, nothing is booked at all.

**Settling claims; it does not pay.** `POST /admin/agencies/:id/settlements` takes a half-open period
(`occurred_at >= from AND < to`, which is why the panel labels the end day "not included") and inserts one
`agency_settlement_items` row per unclaimed accrual. `UNIQUE (entry_id)` is the entire answer to "can this
commission be settled twice": the schema refuses it, so the service never has to win that race. Two guards
run on the account row that the hold is then taken on, so the figures and the freeze describe one position
rather than two reads of a moving one — nothing to claim is `409 nothing_to_settle`, and asking for more
than is unclaimed (`available − frozen − pending`) is `409 settlement_exceeds_payable` naming both numbers
and what would fix it. The batch opens as DRAFT behind a `PENDING_SETTLEMENT` hold.

**The journal moves when the transfer is recorded.** DRAFT → APPROVED → PAID, or VOID from either of the
first two. Approval moves no balance and books no entry; it says the figures are right. Pay is the only
step that writes — DEBIT `AGENCY:<id>` / CREDIT `PROVIDER_COLLECTIONS`, the pair BD and seller
settlements already use because the money leaves through the same rails, keyed
`(AGENCY_SETTLEMENT, settlement.id)` so a pay whose response was lost replays its first answer instead of
sending a second transfer. Its hold is CONVERTED with the batch's reference, which is how the statement can
still name the batch that cleared it, and the payout reference is required for the same reason 0032
requires one for withdrawals: the amount is a fact the platform did not decide. A VOID deletes its claim
rows and releases the hold, so every accrual is claimable again by the next window.

**Two operators, stated twice.** `CHECK (status <> 'PAID' OR (paid_at IS NOT NULL AND payout_reference IS
NOT NULL))`, `CHECK (period_to > period_from)` and `CHECK (approved_by <> created_by)` sit in the table
beside the service's `self_approval` 403. The duplication is deliberate: a batch one person can raise,
approve and pay is a money movement with no witness, and the schema is what keeps that true when a future
writer forgets the rule.

| Route | Permission | Notes |
|---|---|---|
| `GET /admin/agencies` | `finance:read` | search / status / paged, each row carrying its own account position |
| `GET /admin/agencies/:id` | `finance:read` | agency, roster with each *effective* rate and where it came from, batches |
| `PUT /admin/agencies/:id/rate` | `commission:manage` | `{ commissionBps }`; `null` hands the decision back to the platform default |
| `PUT /admin/agencies/:id/hosts/:userId/rate` | `commission:manage` | only a host already on the roster — this is not the route that adds people |
| `GET /admin/agencies/settlements` | `finance:read` | `agencyId` / `status` filters, with each batch's raising and approving operator |
| `POST /admin/agencies/:id/settlements` | `commission:manage` | `{ periodFrom, periodTo, payoutMethod?, idempotencyKey }` → 201, or 200 with `replay: true` |
| `POST /admin/agencies/settlements/:id/approve` | `commission:manage` | 403 `self_approval` when you raised it |
| `POST /admin/agencies/settlements/:id/pay` | `commission:manage` | `{ payoutReference, payoutMethod?, note?, idempotencyKey }` → 200 |
| `POST /admin/agencies/settlements/:id/void` | `commission:manage` | `{ reason (≥ 8 chars), idempotencyKey }` → 200 |

**History was priced, not forgiven**, in the same shape as 0031's backfill: `JR-BF-` references over every
completed commission row that never reached the book, after the same migration opens a `fin_accounts` row
for any agency that arrived since 0029's seed — `fin_journal_lines.account_code` references
`fin_accounts (code)`, so an accrual for an agency with no account would fail at the line rather than at
the intent. Where `minorPerCoin` is `0` the backfill posts nothing and the reconciler reports those rows as
unbooked instead of inventing a rate.

An `AGENCY:<uuid>` is an ordinary purpose account from here on: `GET /admin/accounts/AGENCY:<id>/movements`
is the agency's statement — `AGENCY_COMMISSION` IN, `AGENCY_SETTLEMENT` OUT — and it satisfies the same
`opening + ΣIN − ΣOUT` identity as every other book. `node scripts/account-e2e.cjs` walks the whole
lifecycle over HTTP with SQL spot checks: precedence resolved at all three levels and a retried send
booking no second accrual, a raise that replays rather than double-claims, a moderator refused, the
self-approval 403, pay-before-approve refused, a payout with no reference refused, one balanced entry on
pay with the claim CONVERTED, a void returning every accrual and RELEASED its hold, a batch unable to claim
money a dispute froze, the statement naming both an accrual and a payout and adding up to the account it
describes, three audit rows for the three steps, and the agency book leaving the reconciler nothing to say.

## What a confirmed payment minted is owed on the book (migration 0034)

`COIN_LIABILITY` has existed since 0029 on the understanding that coins are a service still owed, which
means the account should read as what the platform has to deliver. It did not, because only one route ever
credited it. `seller-recharge.service.ts`'s `creditOrder` posts a `RECHARGE_ORDER` entry per order it
verifies, and `settlePaymentOnClient` — the shared primitive *both* that flow and the Stripe webhook call —
moved the balance, wrote a `transactions` row and stopped. So every payment confirmed through
`payment_intent.succeeded` minted diamonds the book had never heard of, while the coins behind a seller's
27 orders were counted. The account was not a running total of what was owed; it was a running total of the
orders a seller happened to open.

**The fix is in the primitive, and it is the default.** `settlePaymentOnClient` now posts `COIN_ISSUANCE` —
DEBIT `PROVIDER_COLLECTIONS` / CREDIT `COIN_LIABILITY` — inside the same SQL transaction as the credit it
describes, keyed on the `payment_proofs` row id. Two properties matter on a money path. Posting is what
happens unless a caller says otherwise, so a caller added next month cannot mint coins silently; the failure
mode chosen is the one that over-records, because an unrecorded collection is invisible while a duplicate is
caught by the unique `(source_kind, source_id)`. And the key is the proof, which `payment_proofs` already
guarantees is one-per-settlement on `(provider, external_id)`, so a redelivered webhook returns the entry the
first delivery booked instead of doubling the liability. Idempotency for the bookkeeping comes from the same
fact as idempotency for the credit, rather than being bolted beside it.

**`journaledByCaller` is the opt-out and exactly one caller takes it.** The seller order's entry is not a
coarser version of the generic one: it splits the gross into `PROVIDER_COLLECTIONS` and `PROVIDER_FEES`, so
booking both would double the liability *and* lose the fee — and the order-keyed shape is what the existing
recharge tie-outs read. Opting out leaves those checks meaningful. The two postings are then mutually
exclusive by construction, which is the claim 0034's backfill is written to make true: a proof is missing
only if it has neither an issuance entry keyed on itself nor an order entry reachable through the
transaction they share.

**History was booked, not forgiven.** The migration's backfill walks the proofs that minted coins with no
entry and writes them at the cents and currency they recorded, with `occurred_at` set to the proof's own time
so each entry lands in the period the payment actually arrived rather than the day the file ran — 66 entries
and 625000 cents on the development database, which is the stripe-shaped traffic six earlier suites left
behind. Idempotent by the same unique index, and re-running the file answers `INSERT 0 0`.

### What the reconciler says now

`recharge.issued_has_journal` counts proofs that collected money and booked no liability, accepting either
posting shape but requiring the credited cents to equal what was paid; `journal.issuance_source_rows_exist`
counts issuance entries whose proof has gone. Both are zero on a database where every path above has run.
The stronger statement lives in the suites rather than in a count: `node scripts/business-e2e.cjs` asserts
that the two issuance kinds add up to *exactly* what `payment_proofs` recorded, and
`node scripts/e2e-live.cjs` drives a real signed webhook, replays it, and requires one entry with two
balanced lines afterwards. Two paths still mint coins with no line at all — the simulated top-up collects
nothing, and an admin grant has no contra account until #60 builds one — so they create no proof row and sit
outside these checks by construction, which is a stated gap rather than a silent one.

## Become a Partner: a role is a row an operator approved (migration 0035)

`HOST`, `AGENCY`, `COIN_SELLER` and `BD_MANAGER` are privileges, and before this migration none of
them was one. An agency existed only if an operator created it in the back office; `users.user_type`
answered `HOST` for anyone who had ever opened a room, because `room.service.ts` wrote it there on
`createRoom`; a coin seller was a `business_accounts` row an operator typed by hand. The three
claims below are what the module changes, and each is a claim a suite now checks rather than a
convention someone remembers.

**A grant is the `APPROVED` row, never a column.** `role_applications` holds the whole privilege: one
row per (account, role) that is still live — a partial unique index on
`(user_id, role) WHERE status IN ('PENDING','INFO_REQUESTED','APPROVED')` is what makes "a second tap
is the same queue item" true rather than polite — and the readers ask that table. `activeRolesFor` is
the only way the app learns what an account holds, `user_type` is still written on `createRoom` and is
still read only to decide whether to raise that marker itself, and a revocation moves the row to
`REVOKED`, which is why it stops working immediately and why the display marker is left alone.

**The applicant is the token.** `POST /api/role-applications` takes a role and an answer object and
*nothing else*: there is no `userId` in the body to trust, and the one place a caller can name another
account is ignored — the suite files an application with `userId`, `user_id` and `id` all pointing at a
different member and reads back the row's `user_id`. `PATCH /api/auth/me` writes five profile columns
and `user_type` is not among them, so the self-grant path that a "become a partner" feature invites is
closed at the route that would have been the obvious way in.

**Approval activates what the role *is*.** `approve` cannot answer 200 and grant nothing, so the
activation lives beside the decision rather than behind a button an operator can forget: a `HOST`
approval raises the marker and nothing else; an `AGENCY` approval creates the `agencies` row the
applicant owns *and* its `fin_accounts` purpose account, refusing first if the name is taken
(`agency_name_taken`); a `COIN_SELLER` approval opens a partner account under a BD, refuses one with no
BD above it (`seller_bd_required`) and refuses a seller as its own parent (`invalid_parent`), starting
it from `partner.sellerLimits` with `password_hash` left NULL because handing over a panel credential
is a human act; a `BD_MANAGER` approval opens a second office only while `business.bd.multiManager`
says the platform wants more than one. A refusal leaves no row: every check above is enforced before
anything is written.

### The four forms are the server's, not the app's

`APPLICATION_FORMS` (`src/services/partner-application.service.ts:93`) describes each role's
questions — `HOST` asks `fullName`, `country`, `city`, `ageConfirmed`, `experience` and an optional
`preferredAgencyId`; `AGENCY` a name, an owner, a place, a `teamSize` and a `recruitmentExperience`
story; `COIN_SELLER` a business, a location, a phone, an optional email, a volume and the rails it gets
paid over; `BD_MANAGER` a person, a place, an experience, languages, a network and a coverage area — and
`GET /api/role-applications/roles` ships that spec beside where the calling account stands in each role.
The Android client renders it instead of keeping its own copy, so a field added here reaches a phone
without a release, and a required question cannot be a different question on the two sides of the wire.

The same spec is the validator. `submitApplication` normalises every answer against it and refuses
anything the form did not ask (`unexpected_field`), anything required that is missing
(`field_required`), an unticked confirmation as a refusal rather than a `false`
(`confirmation_required`), and a value outside its own bounds or shape (`invalid_country`,
`invalid_email`, a phone normalised to E.164 or refused). A `preferredAgencyId` has to be a row that
exists and is recruiting. Five submissions an hour per account are allowed, and a refusal consumes one
— the limit is on the attempt, because the attempt is the thing being limited.

### The queue and its two permissions

`/api/admin/partner-applications` splits reading from deciding the way `account:read` is split from
`account:manage` (`src/services/rbac.service.ts:56`): `application:read` goes to `SUPER_ADMIN` and
`FINANCE_ADMIN` and `OPERATIONS_ADMIN`, `application:review` only to `SUPER_ADMIN` and
`OPERATIONS_ADMIN`, and a `MODERATOR` gets neither. `GET /` filters by status, role and a search that
matches a username or the phone behind it; `POST /:id/approve`, `/reject`, `/request-info` and `/revoke`
are the only writes. A rejection or a revocation without a reason is refused with a 400 — the schema's
own CHECKs demand the note beside the state, so a decision nobody can explain cannot be stored — and a
requested-information row goes back to `PENDING` only through the applicant's own
`POST /api/role-applications/:id/supplement`, which *merges* into the stored answers rather than
replacing them, so an operator asking one question does not reopen the whole form.

### The two switches

`roles.hostApplicationRequired` (default **off**, `system_config`) turns `assertMayHost` in
`src/services/room.service.ts:460` into a gate: with it on, an account with no approved partner role is
refused a room with 403 `role_approval_required`. It ships off on purpose — flipping it on a live
platform would close every existing host's door in one request, so the queue gets worked through first.
Any grant passes the gate, not only `HOST`, because an agency owner and a BD manager are already
trusted with a room and refusing them would be a new rule rather than the one being enforced.
`business.bd`'s `multiManager` is the other one, and both are read and written over
`GET|PUT /api/admin/business/config/:key` — the same dial panel the withdrawal fee uses, and the write
needs `config:manage`.

### What an operator sees afterwards

Every event on either side of the wire lands in `admin_audit` with `target_type = 'role_application'`:
`ROLE_APPLICATION_SUBMIT`, `..._SUPPLEMENT`, `..._CANCEL` from the applicant's side recorded with
`admin_id NULL` and `actor_system = 'partner-application'`, and `..._APPROVE`, `..._REJECT`,
`..._INFO_REQUEST`, `..._REVOKE` each naming the operator who gave it. One application's whole life
therefore reads back in order from one query — filter `/audit` by the `role_application` target and both
sides appear — which is what makes the queue auditable after the fact rather than only while it is open.
Note that the member's own rows surface under actor *System*, not *Partner*: the actor kind is derived
from which id column is set, and an applicant has neither.

`npm run test:partner` (98) is that suite, and it is the only one that runs on both sides at once.

## Promotional diamonds: the pocket that expires (migrations 0036, 0037)

A member's `diamond_balance` answers one question — how many diamonds — and after a campaign it stops
answering the two an operator needs: how many of them somebody paid for, and how many are still owed
back. Minted coins and bought coins in one column means retiring a campaign touches money a member
bought, and nothing in that column can have a deadline. So diamonds are now two balances.

### A balance is a cache; the grant is the truth

`promo_grants` holds one row per award — `amount`, `remaining`, `expires_at`, a status
(`ACTIVE / EXHAUSTED / LAPSED / REVERSED`) and the `source_kind` + `source_id` pair naming the check-in,
quest, campaign or operator action behind it. `users.promo_diamond_balance` is the sum of what is still
live, kept so every existing read path works unchanged beside `diamond_balance`. Where an id exists the
pair is unique, which is what lets a reward hook call `grantPromoDiamonds`
(`src/services/promo-diamond.service.ts:120`) *inside* the transaction that recorded the qualifying
action: a retry sweeps a check-in twice, the grant lands once. An operator mint carries no id and mints
every time it is asked — see the panel note below.

A balance cannot expire, a grant can. A member with three grants therefore spends the one nearest its
death first (`planPromoSpend`, :226), which is the difference between an expiry that costs the member
nothing and an expiry that quietly eats their bonus.

### Why bonus coins cannot become cash

Not because a rule says so. A member's only exit for diamonds is spending them: withdrawal is priced in
R-coins (`withdrawal_requests.amount_r_coins`) and `transactions` refuses a row whose sender is also its
receiver, so bonus coins can be given away or lapse but never laundered into a payout by their own
holder. What they are *not* is free — a minted coin is a coin the platform owes, so every grant posts
`PROMO_GRANT` (DEBIT `PROMOTIONAL:PLATFORM`, CREDIT `COIN_LIABILITY`) at the operator's face value and
every unspent death posts `PROMO_LAPSE` in reverse. Coins minted without a journal line are exactly the
hole 0034 closed.

0037 exists because 0036 over-built: it had added `PROMO_EXPENSE`/`PROMO_LAPSED` accounts and a
`promo.diamonds` config key while 0029 had already seeded `PROMOTIONAL:PLATFORM` and
`accounts.promotional`. Two budgets for one expense, or two dials for one expiry, is how the panel and
the finance report start disagreeing about the same marketing spend, so the unused rows are deleted and
`PROMOTIONAL:<user>` accounts got a projection branch that reads `promo_grants` — a bonus pocket with no
branch would have reported zero, and the view would have presented that as a fact about the member.

### The dial, and what a closed sink does

`accounts.promotional` is the whole configuration: `expiryDays` (default 30, what a mint without an
explicit number of days gets), `usableFor` (which of `GIFT / BOX / STORE / GAME` a bonus pocket may
feed) and `welcomeBonusDiamonds`. Read and written over `GET|PUT /api/admin/business/config/accounts.promotional`
like every other dial; the write needs `config:manage` and replaces the whole blob, so a caller that
knows two fields must send the others back. A dial naming an unknown sink or an empty list is refused
with `bad_config_value` rather than widened. `welcomeBonusDiamonds` is validated but nothing grants from
it yet — it becomes live with the check-in and referral hooks (#62), which is also the first caller that
will pass a `source_id`.

Switching a sink off does not hide its price. The spend path asks the policy before it counts
(`src/services/ledger.service.ts:323-351`), so a member holding only bonus coins is quoted the purchase
as unaffordable — 402 with `promotional: 0` — instead of the order being taken and then failing. Where a
sink does take bonus coins, the ledger row prices the whole fee and its meta names the split
(`meta.promoDiamonds`), and `promo_grant_spends` writes one receipt per grant drawn on. A refund goes
back the way it came: to a live grant it revives it, to a grant whose expiry has passed it lapses on
arrival (`refundPromoDiamonds`, :315) and releases the liability in the same step, so a dead batch never
resurrects through a cancelled match.

### Who closes a dead grant

Expiry is a date, not an event. The sweep in `src/index.ts:79` runs every minute, and
`POST /api/admin/promo-grants/lapse` runs it on demand so finance never waits on the clock: an expired
remainder is still a liability on the book until something releases it. `GET
/api/admin/users/:id/promo-grants?includeSpent=true` shows a member's whole grant history, live and dead.

The book is checked, not assumed: `reconciliation.service.ts` carries three promo tie-outs —
`promo.every_grant_booked` (a grant with no posting against the budget), `promo.cached_balance_matches_grants`
(the cache out of step with the rows it caches — a present-state invariant, so it names no window) and
`promo.spend_within_purchase` (a purchase drawing more bonus diamonds than it cost).

### What the two clients show

`GET /api/wallet` returns `promo: { grants, policy }` next to the member's own number, ordered nearest
expiry first because that is the order the ledger spends in, and the app's wallet screen keeps the
pockets visibly apart: the bonus card says these are minted, not bought, and can never be withdrawn.
`wallet:update` carries the pocket's **total**, not the minted grant's remainder — a phone that applied
one batch as the whole balance would quote 75 where the member holds 660. The panel does the same
separation in the other direction: the Users table never sums the two pockets into one number, and the
Bonus dialog re-derives the spendable total from the grant rows rather than trusting the badge.
`npm run test:promo` (38) walks mint, spend order, split refunds, lapse-on-return, the closed-sink guard
and the statement identity behind all of it.

## What a member is paid for is a rule, not a code path (migration 0038)

0020 gave the app daily quests and a check-in streak, and both still work — but the figure they pay is an
XP number on a row that cannot say anything else. There was no way to write "this campaign pays 300 bonus
diamonds, only to hosts above VIP 3 who are older than a week, twice a day, and only after an operator has
looked at the screenshot" without shipping code. `earning_rules` / `earning_campaigns` /
`earning_activities` / `earning_payouts` are that gap, and they are a *data* gap rather than a second money
system: the coins were built by 0036/0037 and this engine spends them through that module.

Four decisions hold it up, and each one exists because the obvious alternative is a bug in a wallet.

### No number in a payout comes from a request

A phone names a rule and, for the one metric a member can assert, attaches evidence. `target`,
`reward_amount`, currency, the caps and the restrictions are read off the live rule version *inside the
transaction that pays*, the same way `commission.service` refuses a client-supplied rate. The rule is
versioned like `commission_rules`: publishing a reprice closes the previous version's window, and both the
activity and the payout carry `rule_id` plus `rule_version`, so repricing a live campaign cannot change
what an in-flight attempt pays or what was already paid. A support answer and a finance report can agree
because the history says what the rule said that day.

### The reset period is a bucket string, not a job

`DAY`, `WEEK`, `MONTH` or `NEVER` resolve to a `bucket` like `2026-11-08` or `2026-W45`, computed by
PostgreSQL in `quest_settings.reset_timezone` — the same definition of "today" the quests already use, so
there is not a second one somebody can get wrong. The activity row is keyed
`(user_id, rule_id, bucket, occurrence)`, which means a new period simply has no rows: no midnight sweep has
to succeed for the caps to be right. `occurrence` is what makes "twice a day" a unique constraint instead of
a `COUNT(*)` that two racing requests can both pass. `earning_payouts UNIQUE (activity_id)` is the same
argument one level down, and it is why a count cap *is* a value cap: 2 payouts a day at 300 diamonds is 600
diamonds a day, so there is no separately-raceable "daily amount" column. Campaigns get the one cap an
individual count cannot express — `budget_diamonds`, the total this campaign may mint before it stops paying
anyone, checked against the sum of its own payouts while the campaign row is locked.

### A progress value is written by a server hook or by a claim, and the two are not interchangeable

`EARNING_METRIC_CATALOGUE` (`earning-rule.service.ts`) is the list of what the platform can see for itself:
`GIFT_SENT`, `DIAMONDS_SPENT`, `CHAT_MESSAGE`, `CHECKIN`, `CHECKIN_STREAK`, `DAILY_LOGIN`, `ROOM_JOIN`,
`GAME_PLAY` and `STORE_PURCHASE` are `countedBy: 'SERVER'`; `SUBMISSION` is the one metric a member may
claim, and only into a rule an operator marked `requiresApproval`, and every payment from it is signed by a
human (`user:wallet`). A rule can only be conditioned on what its metric can actually answer —
`minDiamonds` / `giftCategory` / `luckyBox` on the two spend metrics, `roomCategory` on chat and room joins,
`minStreakDay` on the check-ins, `itemKind` on the store, `gameKey` on games — and `CHECKIN_STREAK` is
`progress: 'MAX'` rather than `'ADD'`, because a streak row that summed its days would reach a 7-day target
in three check-ins. A filter an event cannot answer fails closed: the event is not counted at all.

### The hooks are in the product paths, and none of them can cost the action it counts

| Metric | Fires from | Awaits? |
| --- | --- | --- |
| `GIFT_SENT`, `DIAMONDS_SPENT` | `ledger.service.ts:435`, inside the send transaction | yes |
| `CHECKIN`, `CHECKIN_STREAK` | `quest.service.ts:236`, inside the check-in transaction | yes |
| `STORE_PURCHASE` | `store.service.ts:543`, inside the purchase transaction | yes |
| `GAME_PLAY` | `game.service.ts:408`, once per seated player at start | yes |
| `CHAT_MESSAGE` | `socket.service.ts:319` → `recordChatEarning` | no |
| `ROOM_JOIN` | `room.controller.ts:240` (the HTTP join only) | no |
| `DAILY_LOGIN` | `otp.service.ts:103`, after the session token is issued | no |

The four awaited ones already own a transaction, so the payout is committed with the action it describes.
The three not awaited are on paths a member is waiting on — a chat send, a room entry, a sign-in — and a
campaign must not add its latency to those or fail them, so their rows land a moment after the response.
`DAILY_LOGIN` has no last-login state to read and does not need it: the DAY bucket plus the cap is the
once-a-day answer. `CHAT_MESSAGE` is the one hook that goes looking for a fact only a rule asked for —
`needsContext('CHAT_MESSAGE')` asks whether any live chat rule carries restrictions, and the room row is
read only when the answer is yes, so an uncensored deployment pays nothing for the decoration on every
line of chat.

A mint that lands in the bonus pocket is announced: `announceBonusChange(userIds)` reads
`promo_diamond_balance` back from the database and emits `wallet:update` after the commit, so the phone is
never told a number the engine made up.

### Routes and the three permissions

`/api/earnings` (member): `GET /` is the reward board — a flat `rules` list, one entry per live rule with
this account's attempt folded onto it, plus `buckets` and the payout trail; `POST /claim` names a rule and
attaches evidence; `GET /payouts` is the member's own history. Nothing on this prefix states a price.

`/api/admin/earning` (operator, mounted behind `requireAdminOperator`): `config:manage` publishes a rule
(`POST /rules` is the verb for both the first version and a reprice), opens or closes a campaign, flips
`/active` and runs `/sweep`; `user:wallet` is the only thing that can approve a claim, because that is a
mint with nothing bought behind it and holds the same bar as a manual balance adjustment; `user:read` covers
the catalogue, the queue, the trail and the rule history. There is no route that edits an activity, a payout
or a grant — refusing a claim and retiring a rule are the only verdicts an operator gets.

### What the reconciler says now

Six checks in the new `earning` domain, all counting offending rows rather than a difference somebody could
explain away: a PAID attempt with no payout beside it, a payout standing on an attempt that is not PAID, a
bonus payout whose grant is not the same account / source / size, a payout whose user, rule version, bucket,
occurrence, currency or amount drifted from what the attempt promised, a payout that no longer resolves to
the rule version it was paid under, and a campaign that minted past its own budget. The last two read without
a date filter on purpose — a snapshot either exists or does not, and this week's spending against a lifetime
budget is a different, weaker claim.

### Tests

`npm run test:earning` (92) feeds the engine events directly and proves what it does with them: eligibility,
windows, caps, buckets, MAX-versus-ADD progress, the budget lock, the approval queue, idempotent replay.
`npm run test:earning:routes` (38) walks the member board and the operator surface over HTTP, including the
permission each route needs. `npm run test:earning:hooks` (40) proves the other half — that the platform's
own paths deliver those events — by doing the real thing over HTTP and a socket: sign in, check in, join a
PARTY room, send a chat line, give a rose and a pricier gift, buy a frame, start a match, then repeat the
same facts one notch off every filter and show nothing was counted. It closes on arithmetic rather than on
the engine's own word: the member's bonus pocket must equal what this deck minted into it minus what
`promo_grant_spends` records this deck's grants paid out, the purchased balance must pay exactly the rest of
the spend, and the campaign's budget total must equal the sum of its payouts. Its teardown retires every rule
it published, and its first act is to retire anything an earlier crashed run left listening.

## What six simultaneous sends are allowed to do

Every other suite here asks a money path one question at a time. The question a phone always ends up
asking is different: it taps Send twice because the response was slow, six members gift the same host
in the same second, an operator presses Pay on a withdrawal and then presses it again.
`npm run test:concurrency` (35) runs those races as parallel HTTP against the live stack and asserts on
what the database ends up holding rather than on what any single response said.

What it must never find is a request that failed because the *database* gave up. That is not
hypothetical: the first run of this suite answered five 500s to six gifts, and `pg.log` named the
reason — `deadlock detected`, four backends each holding one `users` row and waiting for the other's.
Two separate inversions were behind it, and both are gone from `sendGift`:

* `SELECT * FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE` does not lock in `ORDER BY` order.
  PostgreSQL takes a row's lock as it scans and applies the sort afterwards, so the sequence belongs to
  whichever plan that execution chose, and a custom plan and a generic one can walk the same two rows in
  opposite directions. The account locks are now one statement per id, in an order the code sorted.
* The idempotency claim used to run *in front of* those locks. `gift_requests.sender_id` is a foreign
  key, so its insert takes a `KEY SHARE` lock on the sender's row — weak, but it conflicts with the
  strong mode. A gift waiting for the receiver therefore held a weak lock on the sender at exactly the
  moment the gift holding the receiver asked for the strong mode on the sender. The claim now runs
  behind the account locks, where that `KEY SHARE` lands on a row the same transaction already owns.
  The one-statement-per-id shape is applied the same way in `postLedgerMoves` (games, seller
  recharges) and in the two PK battle paths, which lock `rooms`.

A deadlock that cannot happen is still worth answering honestly if one ever does, so PostgreSQL's
`40P01` is mapped: 409 `retry` — "the request collided with another change; retry it" — instead of a
500 that tells a caller their money moved unpredictably when the truth is that the transaction was
rolled back whole and nothing was spent. The suite keeps the two apart on purpose: a 402 is a loss the
sender's balance chose, and any `retry` or 5xx in a race is a loss the server chose for them.

The rest of the run is the same discipline across the book. One idempotency key held by six arms
produces one debit and five answers that name the same gift, while the same key around a *different*
gift is refused 409 rather than replayed; five withdrawals against a balance that escrows two admit
two; four parallel pays of one approved withdrawal leave one PAID row, one reference and one completed
ledger row; six holds with one key freeze the money once. Then it asks the whole database the
questions the operator's reports ask: no balance anywhere negative, with the two `CHECK` clauses still
on the table; each test wallet equal to its own `coin_movements` legs less the escrow still held; no
ERROR finding from `/api/admin/accounts/reconcile`; no breached tie-out from the finance report; no
unbalanced journal entry in the book; and the account that was raced still reconstructing from opening
plus entries. It rejects its own open withdrawals and releases its hold on the way out, so it leaves
the database consistent rather than pristine — the throwaway accounts keep their ledger rows, which is
what the reconciler reads.

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
through 402 checks: OTP auth, wallet ledger double-spend under concurrency, seat
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
path (signature rejection, idempotent credit, replayed delivery, and the collection journaled against the
coin liability exactly once across both) and the media store (an
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
reversals and reconciliation, with the revenue account pinned to holding only the coin spread and — since
0034 — the liability pinned to exactly the cents every `payment_proofs` row collected, whichever of the two
kinds posted it.

`npm run test:accounts` (133) and `npm run test:operators` (44) need that stack running too. The
accounts suite walks the whole book rather than a page of it: the projection identity
`opening + ΣIN − ΣOUT = balance` on a 926-movement account, one statement leg per currency rule, the
reconciliation findings a clean database should not raise, idempotent hold create/release including
the `idempotency_in_flight` answer, the per-role permission split, and the two exports opened the way
a spreadsheet program opens them — ZIP local headers, every entry inflated, CRC-32 recomputed. Since
0032 it also runs a withdrawal from end to end: the `accounts.withdrawal` dial refusing a partial,
out-of-range and non-numeric write and staying unmoved after each, a below-minimum request answered with
the dial's number rather than the environment's, the escrow and the `pending` column agreeing while the
ledger row is still PENDING, the identity re-asserted at all five lifecycle points, Pay refusing no
reference and a `MODERATOR`, the `WITHDRAWAL_FEE` journal arriving as two balanced legs, a
reject-after-approve returning the gross, both `admin_audit` verbs recorded for one request, and the
reconcile report finishing with zero withdrawal ERRORs. Since 0033 the same run walks an agency batch from
accrual to payout: precedence resolved at all three rate levels with a retried send booking no second
accrual, a raise that replays its own batch instead of double-claiming, `nothing_to_settle` on a window
already drained, the self-approval 403, pay-before-approve refused, a payout with no reference refused, one
balanced entry on pay with the claim CONVERTED rather than left hanging, a void returning every accrual and
RELEASING its hold, a batch unable to claim money a dispute has frozen, the statement naming both an accrual
and a payout and adding up to the account it describes, and the agency book leaving the reconciler nothing
to complain about. It ends
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

`npm run test:partner` (98) is the Become a Partner suite, and it is the only one that runs on both
sides of that door at once: eight member accounts file, withdraw and answer, three operators (one per
role that the permission split actually separates) read, approve, ask, refuse and revoke, and the
assertions land on `agencies`, `business_accounts`, `fin_accounts` and `admin_audit` rows rather than on
the responses that created them. Read the three checks named in *Become a Partner* above first — a body
that names another account, an approval that must activate exactly the role asked for, and a refusal
that must file nothing — because the rest of the run is the queue's own behaviour around them: the live
index, the merge that lets one information request ask for one thing, the note a refusal cannot be
stored without, and the create-room gate on both sides of its switch. It needs the running stack and a
development database, and it shapes itself around the five-submissions-an-hour limit rather than
against it — which is why refusals get their own accounts. Everything it borrows it gives back, on the
failure path as well as the success one: both switches restored, its open rows withdrawn, its rooms
closed by the accounts that opened them, its grants revoked, its operators disabled.

`npm run test:promo` (38) is the promotional-diamond suite, and the checks worth reading first are the
four that keep the two pockets from quietly becoming one: a fee paid from the bonus pocket refunds to
the bonus pocket, a fee paid from both splits the same way in reverse, a coin returned to a grant whose
expiry has passed lapses instead of resurrecting, and `PROMOTIONAL:<user>` still reproduces its balance
from its own statement afterwards. It opens a paid game for the duration, forces all four sinks on at the
start and puts the dial and the free-to-play rules back on the way out — the settings are applied before
anything is asserted rather than inherited, so a run interrupted halfway cannot poison the next one.
Time-stamped accounts, so it needs a development database.

The three earning suites are the 0038 engine seen from three different sides — `npm run test:earning` (92)
feeds it events directly, `npm run test:earning:routes` (38) walks the member board and the operator surface
over HTTP, and `npm run test:earning:hooks` (40) proves the platform's own paths deliver those events by
doing the real thing over HTTP and a socket, then ties the bonus pocket, the purchased balance and the
campaign budget against the spending each one funded. *What a member is paid for is a rule, not a code path
(migration 0038)* earlier in this file is where the three are described together, including the two hooks
deliberately not awaited. The last two need a running stack and a development database; the first is
self-contained and retires everything it publishes.

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

`npm run test:concurrency` (35) needs the same running stack and, like the money suites above, a
development database: it is the parallel one, and *What six simultaneous sends are allowed to do*
earlier in this file is where its reason for existing — the two lock-order inversions it found in the
gift path — is written down.

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
