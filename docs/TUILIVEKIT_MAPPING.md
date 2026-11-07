# Voiza — TUILiveKit feature-to-component mapping (spec §27–§39)

Every row is the state of Voiza **as verified in this repository**, not as described by the
reference material. `DONE` names the component that already does the job; `PARTIAL` names what
is missing from it; `ABSENT` means nothing exists to extend.

The reference repositories (TUILiveKit, the trtc.io solution pages) were used only as a list of
features to match. No source, class, resource or dependency was taken from them, and §27's
restriction is enforced by the check in §1 below.

---

## 1. §27 — No Tencent services (verified, not assumed)

`gradle :app:dependencies --configuration releaseRuntimeClasspath` greps for `tencent`, `trtc`,
`liteav`, `timarsd`, `quclive`, `gvoice`; the same terms across every `*.kts`, `*.gradle`,
`*.toml` and `*.properties` in `android/`. **Zero matches.** The transport ownership table is
already the architecture:

| Function | Voiza implementation (existing) |
|---|---|
| Voice | self-hosted LiveKit — `core` wrapper is `data/livekit/LiveKitRoomManager.kt` (SDK `io.livekit:livekit-android:2.13.0`) |
| Realtime events | Socket.IO — `backend/src/services/socket.service.ts`, `data/socket/VoizaSocketClient.kt` |
| Backend / DB / cache | Express+TS+raw `pg`, PostgreSQL, Redis |
| Gift economy | `backend/src/services/ledger.service.ts` — the only writer of coin balances |
| Admin | React + Vite |

Keep this check in CI: the acceptance criterion is a dependency tree, so it has to be re-run
after any dependency is added (the camera and streaming sections below are exactly where a
Tencent-shaped SDK would sneak in).

---

## 2. §28 — Voice chat room

### Room interface

| Feature | State | Component |
|---|---|---|
| Backgrounds, animated decorations | DONE | `ui/screens/room/RoomVisuals.kt` (`RoomWallpaper`, `AmbientRoomEffect`), `room_themes` |
| Speaker seats, audience list | DONE | `SeatGrid.kt`, `AudienceListSheet.kt`, `room_seats` |
| Avatars + profile frames | DONE | `SeatGrid.kt:126`, `profile_frames` |
| Title / room number / live count / chat / likes | DONE | `PartyRoomScreen.kt`, `ChatOverlay.kt`, `HeartLayer.kt` |
| Gift notifications | DONE | `GiftTickerColumn.kt`, `GiftEffectOverlay.kt` |
| Entry effects (rides) | DONE | `EntryRideOverlay.kt`, `profile_rides` |
| Host badge | DONE | `HostBadgeLabel` is drawn on the occupied host seat in `SeatGrid.kt` |
| Block / report / follow a member | DONE | `ui/screens/room/MemberSheet.kt` opens from a roster row or a chat author; `SocialRepositoryImpl` calls the six `api/users/:id/...` routes the backend already had, and every row reads the server's `GET /:id/relationship` before it draws |
| Audience grid | PARTIAL | only a horizontal avatar strip (`PartyRoomScreen.kt:730`) |
| Room announcements | DONE | `Room.announcement` + `PartyRoomScreen.kt` `AnnouncementBanner`, host composer writes `POST /:id/announcement`, everyone repaints on `room:announcement` (operator overrides included) |
| Moderator badge / role | ABSENT | `room_participants.role` is `HOST\|SPEAKER\|AUDIENCE` only; `SUPER\|MODERATOR` is the platform-operator table, not a room role |
| Reaction strip (floating emoji burst) | DONE | `ui/screens/room/QuickReactions.kt`: `ReactionStrip` offers the operator's first six `emoji_characters`, a tap emits only the key, and `room:reaction` comes back with the art the server resolved — which `ReactionLayer` flies along the heart layer's tracks |
| Exit effects | ABSENT | `room:user_left` only prunes state |

### Voice interaction

| Feature | State | Component |
|---|---|---|
| Mic on/off, mute, seat lock, kick, hand raise | DONE | `HostControlsSheet.kt`, `LiveKitRoomManager.kt:139`. One raise-hand button, two meanings: the host's `speakerApprovalRequired` switch decides whether the tap marks the member as waiting or files a queue request (`SeatTakeResult.Seated`/`Queued` reads that choice off the 200/202 response) |
| Reconnection / network recovery | DONE | LiveKit `Reconnecting/Reconnected` + socket re-subscribe and presence reclaim (`PartyRoomViewModel.observeSocketRecovery`) |
| Speaker invitation | DONE | the host's roster calls `POST /:id/seat/:index/invite`; the invitee gets `room:seat_invited` as an accept/decline dialog, and because the server seats immediately the client keeps its own microphone unpublished until the member accepts |
| Speaker queue | DONE | host-only `GET /:id/speaker-requests` in `AudienceListSheet`, rendered in the server's FIFO order, answered through the approve/reject routes; `room:speaker_request(_updated)` means re-read, not patch. Gap: a member's own pending ask is not in `GET /:id`, so after a rejoin the button reads "raise hand" again (a second tap returns the request the server already holds) |
| Audio device selection | ABSENT | no `AudioDeviceRouter` / bluetooth / `MODE_IN_COMMUNICATION` |
| Per-participant audio quality | ABSENT | one room-level pip only; `connectionQuality` unused |
| Voice effects (deep/high/robot/echo/reverb/pitch/noise-suppression/EQ) | ABSENT | no audio-processing layer anywhere; `LiveKit.create()` is called with **no `RoomOptions`**, so AEC/NS/AGC are uncontrolled SDK defaults |

---

## 3. §29 — Livestream gifting

| Area | State | Component / gap |
|---|---|---|
| Selection panel | PARTIAL | `ui/screens/gift/GiftDialog.kt` has categories, tiles, prices, quantity, VIP gate, balance. Missing: a combo-send affordance (combos are counted server-side and only displayed), a working recharge shortcut (L316 is dead text), room-restricted eligibility (no column) |
| Formats | PARTIAL | real decoders: Lottie, SVGA (vendored `gifts/svga/SvgaParser.kt`), MP4. **GIF, animated WebP, SVG, PNG sequences are not even accepted strings** (`GiftAnimationFormat`, `GIFT_ANIMATION_FORMATS`, `MEDIA_KINDS.GIFT_ANIMATION`) |
| Tiers | PARTIAL | TICKER and FULLSCREEN exist; there is no small/floating tier |
| Queue | DONE | `domain/usecase/RoomEffects.kt` (overlap, priority via `display_priority`, dedupe by id, combo grouping, expiry, bounded memory) + admin-configurable priority (`GiftsPage.tsx:937`). Caveat: `leaveRoom()` does not clear the queue; it relies on the ViewModel scope, and there is no `SavedStateHandle` |
| Transaction flow | DONE | `ledger.service.ts:166` single transaction: idempotency, `FOR UPDATE`, participation + VIP + balance gates, debit/credit, XP, commission row, `total_gift_value`; broadcast only after commit; the client never deducts |
| Analytics | **the weakest area** | `giftAnalytics` (`admin.service.ts:713`) gives per-gift sends/value/spend/earnings. Missing entirely: daily time-series, top senders, top receivers, per-room rankings, host-earnings report, gift-driven agency attribution, and a **gift platform-revenue source kind** (`PLATFORM_REVENUE` is fed only by recharge/commission/settlement/reversal/adjustment) |

---

## 4. §30 — Entertainment live / PK

DONE: invitations, timer, gift-based scoring, announcements, history, operator stop. Scores are
server-only (`pk.controller.ts` accepts none) and settlement pays XP, never diamonds.

ABSENT: team-based PK, like-based scoring, audience voting, countdown effects, win/lose
animations, PK leaderboard.

Configurable rules — of the eight the spec names, **one is admin-settable**: duration
(`pk_settings`, `PUT /api/admin/pk/settings`). Eligible gifts, score conversion (hardcoded
1 diamond = 1 point), like weight, team membership, winner calculation, tie handling and
cooldown (hardcoded `rateLimit('pk-invite', 6, 60)`) are not.

**Critical:** the admin API exists but there is **no admin UI at all** — `grep -i battle
admin-panel/src` returns nothing.

---

## 5. §31 — Interactive game console

Strongest area after gifting. `game.service.ts` (985 lines) + `game-settlement.service.ts` give
a lobby, server-side dice/boards/timers, event-log replay, history, disputes and admin review;
fees debit through `postGameMoves('GAME_ENTRY')`, prizes use a floor-rounded ladder with the
leader absorbing the remainder, commission is booked not banked, refunds are new rows. Legal
gating is real: money-affecting rule patches are refused without `confirmCompliance`, and
`entry_fee_min/max` seed `0..0` so every game ships free until an operator raises the ceiling.

Three games are implemented end to end (Tic-Tac-Toe, Quiz Battle, Ludo). Card games,
connect-four, word and skill games: ABSENT. Matchmaking, spectator mode (`allow_spectators`
column exists and is **never read**), invite-friends, game previews: ABSENT. Any physical-device
(crane) architecture: ABSENT — and the spec itself marks it optional and non-blocking.

---

## 6. §32 — Game live and screen streaming

**ABSENT end to end.** No MediaProjection (the manifest carries only `RECORD_AUDIO` +
`FOREGROUND_SERVICE_MICROPHONE`), no RTMP, no egress/recording, no split-screen, no co-stream.
The Android client is audio-only: the sole LiveKit local-track call is `setMicrophoneEnabled`;
there is no `VideoSource`, `addTrack` or `CameraVideoCapture` anywhere.

---

## 7. §33 — Social messaging

**ABSENT as a subsystem.** There is no `conversations` or `direct_messages` table; the only chat
table is `chat_messages`, which is room-scoped (`room_id NOT NULL`, no `receiver_id`, `read_at`,
`reply_to` or `deleted_at`). No DM route, no DM socket event, no sticker concept, no admin page,
no Android screen. Group text chat: absent (voice rooms cover seats and announcements only).
Communities: absent as an entity — categories are `POPULAR|PARTY|MUSIC|GAME|CHAT`, there is no
membership table and no pinned posts.

Already done and reusable: `user_blocks` / `user_reports` with service, routes, admin queue
(`ModerationPage.tsx`) and, since this tranche, an Android surface for them — `MemberSheet.kt`
(follow / block / unblock) and its report dialog. What is still absent is the messaging itself:
no conversation list, no thread screen, no `direct_messages` schema.

---

## 8. §34 — Face filters, stickers, beauty

**ABSENT entirely**, and nothing partial to build on: no CAMERA permission or `uses-feature
camera`, no MediaPipe/ML Kit/OpenCV dependency, no video pipeline, and `grep -rni beauty`
repo-wide returns zero — so there is not even a catalogue row standing in for it. Store kinds are
`FRAME|THEME|EFFECT|RIDE`, where `EFFECT` is a room Lottie loop.

---

## 9. §35 — Asset library and manifest

`media_assets` (`0014_media_uploads.sql`) already carries id, file_name, stored_name,
content_type, byte_size, sha256, url, width, height, kind, uploaded_by, created_at.
**Missing from the manifest the spec asks for:** animation duration, version,
license/provenance and an explicit cache policy — provenance is prose in `NOTICE.md` and
`THIRD_PARTY_LICENSES/` only.

Serving is the real gap: `app.ts:84` mounts `/uploads` and `app.ts:77` serves `backend/public`
as unauthenticated, unsigned `express.static` paths.

---

## 10. §36 — Admin panel controls and feature flags

Present: Overview, Users, Moderation, Rooms + RoomConsole, Gifts, Media, Banners, Decor, Emoji,
Ranks, Quests, Withdrawals, Games, Partners, Recharges, Commissions, Finance, Audit. Gift
management and room-effect management are complete; game management is complete.

Flags: the only persisted mechanism is `system_config` (JSONB by key, `config:manage`), and it
holds business/commission keys only. Everything else is bespoke — `pk_settings.is_enabled`,
`quest_settings`, `game_definitions.is_active`, `gifts.is_active` (`gift_categories` has no
enabled column at all). So of the nine proposed flags, only `ENABLE_PK_BATTLES` exists and is
enforced on both sides, `ENABLE_GAME_CONSOLE` exists per game, `ENABLE_GIFT_ANIMATIONS` is
per-gift only, and the other six have no feature to switch.

**Android reads exactly one server-driven flag** (`GET /api/pk/settings`). There is no generic
config endpoint, so every other feature is hardcoded into the UI.

Permissions (`rbac.service.ts:18`): 18 granular permissions over 4 roles, re-read from the DB on
every request because the JWT role claim is distrusted.

---

## 11. §37 — Integration rules

The rule "do not build a second application inside the project" already holds. The spec's
package names do not: `android/` is a **single `:app` module** organised layer-first
(`data/ domain/ di/ ui/ viewmodel/`), with no `features/*` or `core/*` packages, so that mapping
is a real restructure rather than a rename. Backend is missing `gift.service.ts` (gift CRUD lives
in `admin.service.ts`), `gift-animation.service.ts`, `messaging.service.ts` and
`moderation.service.ts`.

---

## 12. What the gap actually is, ranked by cost

1. **Cheap and already half-built** — done: the pinned notice (banner + host composer + `room:announcement`),
   speaker invitations (invite from the roster, accept/decline on the phone, microphone held until the
   member answers), the host's speaker queue (FIFO list, approve/reject, the same raise-hand button filing
   a request when the gate is on), the host badge, the gate itself on the edit screen because
   `PATCH /api/rooms/:id` is its only writer, and the member card (follow, block, report) on top of
   the social routes that were already finished server-side.
2. **Cheap, self-contained** — done: the reaction strip (`room:reaction`). Remaining: exit
   effects, GIF/WebP gift
   formats, gift analytics, a PK admin page, explicit LiveKit `RoomOptions` + audio device
   selection + per-participant quality.
3. **Medium** — a persisted feature-flag mechanism the backend enforces and Android reads;
   PK rules as knobs; moderator as a real room role; asset-manifest columns.
4. **Large, new subsystem** — private + group messaging (schema, routes, socket events, admin
   moderation, two Android screens).
5. **Large, new dependency and permission surface** — voice effects (local DSP) and camera
   beauty/filters/stickers (MediaPipe or ML Kit, CAMERA permission, video pipeline).
6. **Infrastructure, not code alone** — screen/game streaming (MediaProjection, RTMP or LiveKit
   egress, a media server you operate).
