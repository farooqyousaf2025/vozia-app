# Voiza — Android app

Native Android client for the Voiza audio-party platform.
**Kotlin + Jetpack Compose (Material 3) + Clean Architecture / MVVM.**
No Flutter, no React Native, no Capacitor.

## Toolchain

| Piece | Version |
|---|---|
| Gradle | 8.7 (wrapper committed: `gradlew`, `gradlew.bat`, `gradle/wrapper/*`) |
| Android Gradle Plugin | 8.5.2 |
| Kotlin | 1.9.24 |
| Compose BOM | 2024.09.03 (compiler ext 1.5.14) |
| SDK | compileSdk 35 / targetSdk 35 / minSdk 24 |
| JDK | 17 to compile (`android.suppressUnsupportedCompileSdk=35` silences AGP's "tested up to 34" warning; builds and lint pass on 35) |

Key libs: Retrofit 2.11 + OkHttp 4.12 + Gson, `io.livekit:livekit-android:2.13.0`
(Maven Central, plus the JitPack repository for its `audioswitch` dependency),
`io.socket:socket.io-client:2.1.1`, Coil 2.7, navigation-compose,
`androidx.security:security-crypto` (encrypted session store), lottie-compose 6.4,
`androidx.lifecycle:lifecycle-process` (foreground detection for notifications).

## Building

The Gradle wrapper (`gradlew`, `gradlew.bat`, `gradle/wrapper/*`) is committed, so
a clean checkout needs only a JDK 17+ and an Android SDK with platform 35:

```sh
cd android
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest    # pure-JVM unit tests (wire mappers incl. the room profile, seat policy range, purchase guard, effect queue policy)
./gradlew assembleRelease      # signed if keystore.properties exists, else unsigned
```

`local.properties` (git ignored) must point at the SDK: `sdk.dir=/path/to/Android/SDK`.
Or open `android/` in Android Studio (Hedgehog+), which writes it for you.

### Release signing

Copy `keystore.properties.example` → `android/keystore.properties` and point it at
a `.jks` you generated (the file is git ignored, and `*.jks` / `*.keystore` are too).
`app/build.gradle.kts` picks it up automatically; `VOIZA_KEYSTORE_PROPERTIES` can
name a different path (useful on a CI machine). With no file present the release
build still assembles as `app-release-unsigned.apk`, which is what the CI job does
to prove the R8 + resource-shrinking config. Uploads to Play need a **keystore you
will never lose** — generate it once, back it up offline.

## Pointing at a backend

`VOIZA_API_BASE_URL` and `VOIZA_LIVEKIT_URL` are BuildConfig fields resolved in
`app/build.gradle.kts` with this precedence:
**gradle property → environment variable → emulator-host default**
(`http://10.0.2.2:4000` / `ws://10.0.2.2:7880`).

- Android emulator → host machine is `10.0.2.2`; the docker-compose stack
  exposes the API on 4000 and LiveKit on 7880, which matches the defaults.
- Physical device on LAN: `VOIZA_API_BASE_URL=http://192.168.x.x:4000`.
- Real VPS: `VOIZA_API_BASE_URL=https://api.voiza.example.com` and
  `VOIZA_LIVEKIT_URL=wss://livekit.voiza.example.com`. Put it in
  `~/.gradle/gradle.properties` or export it in the shell.

**The emulator defaults apply to the debug variant only, and a release build refuses to
guess.** `assembleRelease` (or `assemble` / `build`) fails at configuration time unless
both properties are supplied — `-PVOIZA_API_BASE_URL=… -PVOIZA_LIVEKIT_URL=…` — because a
signed APK that quietly dials `10.0.2.2` ships as a working-looking app that reaches
nothing. `assembleDebug` still needs no flags, so the emulator walk is unaffected.

### The code that comes back from `/request-otp`

With `SMS_PROVIDER=mock` the backend echoes the OTP as `devCode` so a tester can skip the
inbox. `AuthViewModel` fills it into the code field **only when `BuildConfig.DEBUG`**, and
drops it to null in a release build even against a dev backend that still hands one out:
the convenience is the one thing in the flow that would let a shipped client bypass SMS
verification entirely.

### Cleartext traffic

`android:usesCleartextTraffic` is **not** set. The manifest points at
`@xml/network_security_config`, and the two variants ship different files for it
(the debug source set wins during resource merging):

- `app/src/debug/res/xml/network_security_config.xml` — cleartext allowed for any
  host, user-installed CAs trusted, so the emulator (`http://10.0.2.2:4000`) and a
  LAN device (`http://192.168.x.x:4000`) work with no per-machine edits.
- `app/src/main/res/xml/network_security_config.xml` — `cleartextTrafficPermitted="false"`,
  system trust anchors only. A release build aimed at an `http://` host fails the
  request loudly instead of silently downgrading.

So a release build against a phone on LAN needs real TLS (a reverse proxy with a
valid cert, or `adb reverse` for local testing).

## Architecture notes / assumptions

- **Clean Architecture, manual DI.** `di/ServiceLocator.kt` is a hand-written
  container (deliberately no Hilt/Koin — smaller build, no annotation
  processors). `data → domain ← ui` boundaries per spec: ViewModels talk to
  use cases/repositories, Retrofit DTOs never escape `data/remote`.
- **JSON: Gson everywhere** (REST converter + socket payload parsing), picked
  over kotlinx.serialization because socket.io-client speaks org.json natively.
- **LiveKit identity == user UUID.** The speaking-ring resolves audio levels
  by matching `participant.identity` against seat `user.id`. If the backend
  mints tokens with a different identity scheme, that one mapping (see
  `LiveKitRoomManager.identityOf` + `SeatGrid` level lookup) must change.
- **Publishing rules.** The mic track is only created when the backend said
  `canPublish` *and* the `RECORD_AUDIO` runtime permission was granted
  (requested by `PartyRoomScreen` on entry). Seat changes flip publish rights
  without reconnecting the LiveKit room; only a different `roomName` re-dials.
- **Audio levels are polled** (120 ms) from participant state rather than
  event payloads, so LiveKit 2.x event-shape drift cannot break the UI.
- **The client never decides how many seats exist.** `HomeViewModel` fetches
  `GET /api/rooms/capacity` on launch and `CreateRoomScreen` draws its slider across the
  min..max the administrator published; an untouched slider posts no capacity at all, so
  the server's default applies even if that fetch failed. `SeatPolicy.isUsable` refuses an
  impossible range rather than drawing one, and the seat DTOs have no `= 9` default left to
  fall back on — a missing `seatCapacity` lands as 0 and the harness fails loudly.
  `SeatGrid` lays out whatever the room actually has: 3 per row up to nine seats, then 4
  narrower cells per row, so a 21-seat room shows all 21 instead of hiding thirteen.
- **Gift animation is routed by the server's format, not a file name.**
  `ui/screens/room/gifts/GiftRenderer.kt` is the one door: `gifts.animation_format` — what
  `media.service.ts` sniffed out of the uploaded bytes and wrote on the catalogue row — picks the
  player. `LOTTIE` plays through `com.airbnb.android:lottie-compose`, `MP4` through `MediaPlayer` +
  `SurfaceView` in `gifts/VideoArtLayer.kt`, and `SVGA` through the decoder vendored under
  `gifts/svga/` (`SvgaWire` reads the protobuf wire, `SvgaParser` turns an exported `.svga` ZIP into
  a `SvgaMovie`, `SvgaPlayer` answers "what does tick *n* look like", and `gifts/SvgaArtLayer.kt`
  drives it onto a `Canvas`). No SVGA library is a dependency; the model and the wire reader are
  plain Kotlin and are unit-tested on the JVM (`SvgaWireTest`, `SvgaParserTest`). Everything is
  fetched from the API origin at runtime — no animation ships in the APK.
  A gift with no animation file plays the pure-Compose burst (`BurstGiftRenderer`), and so does an
  SVGA whose bytes will not open: the money was paid and the room still has to see the gift. A dead
  Lottie or MP4 URL is not swapped for a burst — the overlay still names sender, gift and value, and
  the slot closes on its own clock. That clock is `animationSlotMs(declaredMs, fallbackMs)`: the
  operator's `gifts.duration_ms` when it is a usable 250–30 000, otherwise the container's ceiling
  (6 s Lottie, 6 s SVGA, 8 s MP4). `0` is an answer, not a gap — "play it for its own length" — so
  it takes the ceiling rather than a short default that would cut a long scene in half.
  `RoomVisuals.kt` adds the matching theme wallpaper, a once-per-join welcome
  flourish and a quiet ambient loop. All three are **URLs the API named** —
  `room.themeWallpaper`, the catalogue's `welcome` and `room.ambientEffect` —
  never a path built from a slug, because an operator's wallpaper lives at
  `/uploads/<uuid>.png`. A room whose payload carries no wallpaper just shows the
  gradient underneath.
- **The ride a member arrives with is a file, not a badge.** Migration 0026 put `entryRide`
  (`url`, `format`, `durationMs`, `name`) on the joiner's `MiniUser` inside `room:user_joined`, and
  `PartyRoomViewModel` keeps that arrival as `state.entryRide` — deliberately *not* the local user's
  own ride, for the same reason their own entry banner is not replayed to them. `EntryRideOverlay`
  draws it over the room and `RideArtLayer` opens the file in the renderer its format names, using
  the same `animationSlotMs` rule and the same per-container ceilings as a gift, so an operator who
  uploads one file twice — as a gift and as a ride — has it cut off at the same beat either way.
  Two differences are on purpose: an SVGA ride that will not open hands the screen back instead of
  playing a burst (a ride is a decoration bought for oneself, and the line at the foot of the
  overlay already says who arrived), and the overlay is drawn in the room's own layer, *under*
  `GiftEffectOverlay`'s `Dialog`, so an arrival colliding with a fullscreen gift waits rather than
  covering it. The shop sells rides under the *Arrivals* tab and previews them through the same
  `RideArtLayer`, in a `Dialog` because the detail sheet is a `ModalBottomSheet` — its own window,
  which would sit on top of anything drawn in the screen's `Box`.
- **Gift sound.** `gifts.sound_url` is served from the backend's generated asset
  set (`chime.wav` / `whoosh.wav` / `fanfare.wav`) and played by
  `ui/components/GiftSoundPlayer.kt`, which the overlay remembers per dialog and
  disposes with it. It uses `USAGE_ASSISTANCE_SONIFICATION`, so a gift can never
  steal audio focus from the LiveKit call, and it ducks other streams for the
  one-shot instead of pausing them. A blank, missing or unreachable URL is simply
  silence — a `setOnErrorListener` that swallows the error means a broken asset
  never looks like a failed purchase.
- **Room effects are Compose, counted by the server.** Nothing here comes from a
  vendor UI kit: `ui/screens/room/GiftTickerColumn.kt`, `HeartLayer.kt`,
  `QuickReactions.kt`, `EntryBanner.kt` and `GiftRankingSheet.kt` are hand-written Compose, and the
  queue policy they follow lives in one place, `domain/usecase/RoomEffects.kt`
  (pure Kotlin, unit-tested). `RoomEffects` decides that a `TICKER` gift scrolls a
  3-row column that dismisses itself after 3 s, that `FULLSCREEN` gifts
  serialise through a 3-deep queue which evicts the oldest entry *unless* every
  queued scene is the local user's own, and that a tap on the like button
  accumulates locally and reports at most 100 taps per 6 s flush. The numbers are
  the other kit's; the counting is ours — the client draws the server's `total`
  from `room:liked`, never its own tap count, and the ranking sheet renders
  whatever `GET /api/users/top` returns rather than a local tally. The ambient
  loop behind the seats is `room.ambientEffect` (the server's per-category choice,
  which an operator remaps from the panel's Decoration screen), the
  entry banner is tiered by `user_joined.user.vipLevel`, and the heart sprites are
  a `Canvas` bezier path, not a Lottie, so a hundred concurrent hearts cost one
  recomposition of one layer.
- **A quick reaction sends a name and animates the server's picture.** `ReactionStrip` sits above
  the action bar and offers the first six rows of `GET /api/emoji` in the picker order the operator
  set, so what a viewer can fly is exactly what the panel published. A tap emits only that emoji's
  `key` on `room:reaction`; `reactionByKey` in the backend looks it up, ignores a key with no row,
  rate-limits the sender, and broadcasts the `key`, `code`, `label` and `url` it found. The device
  never receives — and never builds — a URL it was not given, which is why a hand-written key cannot
  make a room animate arbitrary art. `ReactionLayer` flies the result along `HeartLayer`'s tracks so
  a puff of emoji and a puff of hearts read as one language, and because the broadcast includes the
  sender, the ViewModel drops its own echo: the burst you played at the moment of the tap is the
  same one the room saw. Nothing is stored behind any of this — a reaction moves no coins and writes
  no row, so it is the one effect that may be played optimistically.
- **A member's level is painted, never computed.** `UserRank` is the rung the
  server resolved from `users.xp` against `rank_levels`, and it arrives already
  shaped: `rank.name`, `rank.badge` (a URL, so an operator's upload at
  `/uploads/<uuid>.png` works the same as seeded `/badges/level-9.png`) and
  `rank.accent`. `ui/components/RankBadge.kt` draws that art through
  `asAssetUrl()`, `accentColor()` turns the rung's `#rrggbb` into a Compose
  colour, and neither one holds a threshold — the app has no ladder table, no
  `level = xp / 300` shortcut and no `/badges/level-<n>.png` guess. Where the
  payload carries no `rank` (a lean seat list, the audience roster) the badge is
  simply absent; the client never reads a missing rung as level 0. The rung sits
  beside the spend tier it must not be confused with: `EntryBanner` is still
  sized by `vipLevel`, an operator's gift-spend tier, while the badge and name
  next to it are what the member earned.
- **Chat lines are deduplicated by id.** Joining a room inserts an entry notice
  into `chat_messages` *and* emits it, so `GET /api/rooms/:id` and
  `room:chat_message` can bring the same row. The message list is keyed by id,
  which means a second copy is a crash rather than a doubled line, so
  `RoomEffects.appendChat` drops an id already on screen.
- **Gift panel is a paged 4×2 grid with two-tap send.** `GiftDialog` shows eight
  tiles per page (`HorizontalPager`, dot indicator, fixed `PANEL_HEIGHT` so the
  pager cannot resize while the second tap lands): first tap selects, second sends.
  The title row carries a **Ranking** chip that swaps the gift sheet for
  `GiftRankingSheet` — both are separate windows, so opening one closes the other.
- **A lucky box is drawn by the server and only reported by the app.** Migration 0027 turned a box
  into an ordinary `gifts` row with `is_lucky_box` plus a prize table, so sending one is the same
  `POST /api/gifts/send` with the same price, the same idempotency key and the same ledger row. The
  tile prints `chanceBps` — the prize's weight against the box's total, divided where the weights
  were written — and never a weight or an `odds` field it invented (`luckyOddsLabel` shows
  `LUCKY <best prize> 1 in N`, or says `LUCKY BOX` when no chance was disclosed). The animation's
  value line prints the server's `lucky.headline` above the diamonds-spent → r-coins-credited pair. Every number
  about that money — `receiverRCoins`, `grossRCoins`, `platformTaxRCoins`, `receiverShareBps` — is
  read off the event, which is the same object the ledger stored in `meta.lucky`; nothing here
  re-derives a payout from the prize table, because a client that computes a payout is a client that
  can be wrong in a way that looks like the platform's bookkeeping.
- **Moderation traffic is room-scoped.** `room:kicked` and the operator's
  `room:warning` arrive on the private `user:<id>` channel, so both are filtered
  by `roomId` in `PartyRoomViewModel` before they touch the UI; a warning shows
  as a dismissible banner under the top bar and never leaves the host's screen.
- **Relative asset URLs.** `iconUrl`, `avatarUrl` and `coverUrl` arrive as
  root-relative paths (`/gifts/rose.png`) that belong to the API origin, so
  every Coil load goes through `ui/components/AssetUrls.kt` (`asAssetUrl()`),
  which prefixes the scheme+authority of `BuildConfig.VOIZA_API_BASE_URL`.
  Absolute URLs (a CDN) pass through untouched.
- **Animated art moves because `VoizaApp` installs an `ImageLoaderFactory`.** Coil's default loader
  decodes a GIF or an animated WebP to a single static frame, which is fine until a banner — or an
  avatar — is one. `VoizaApp` implements `ImageLoaderFactory` and registers `ImageDecoderDecoder`
  on API 28+ and `GifDecoder` below it (both from `io.coil-kt:coil-gif`), so one `AsyncImage` call
  site animates everywhere in the app rather than only where a surface opts in. The other three
  banner formats do not need it: Lottie, SVGA and MP4 already have renderers — lottie-compose,
  `ui/screens/room/gifts/SvgaArtLayer.kt` and `ui/screens/room/gifts/VideoArtLayer.kt` — which
  `ui/components/banner/BannerArt.kt` routes to by the row's declared `format`.
- **Banners are fetched once and navigated through two CompositionLocals.** `BannersStore`
  (`domain/usecase`) is the only caller of `GET /api/banners`, and it calls it without a
  `placement`, because the splash, the home strip, the gift panel and the game desk are one
  question with four answers. A failure leaves its list empty, which draws nothing — an unloaded
  campaign is not an error a member can act on, and it looks exactly like a platform with none.
  A tap goes through `LocalBannerNavigator` (provided by `MainActivity` over its own
  `NavController`) rather than a `navController` prop on four screens, so no composable reaches
  for `ServiceLocator` and no screen has to know what a banner is allowed to point at: INTERNAL
  is one of four routes, ROOM is `Routes.room(id)`, URL is an `ACTION_VIEW` intent, NONE is inert.
  Impressions dedupe per banner id per session; taps always count.
- **Wire-shape harness.** `scripts/run-dto-harness.sh` deserialises captured
  live payloads (`node ../backend/scripts/capture-wire-fixtures.cjs` and
  `capture-game-wire.cjs`, which writes `scripts/fixtures/wire-games.json`) with the
  app's own compiled DTOs and mappers on a plain JVM. Gson builds Kotlin data
  classes without running their default initialisers, so any newly non-null
  field backed by an absent key crashes there instead of on a device.
- **Auth persistence is encrypted.** `SessionManager` stores the JWT + cached user
  in `EncryptedSharedPreferences` (`AES256_SIV` keys / `AES256_GCM` values) under a
  Keystore master key, because the JWT *is* the session. On first launch it copies
  the values out of the old clear-text `voiza_session` file and wipes that file, so
  upgrading does not log anyone out. If the master key is unusable (a keystore wipe
  after a device restore) it deletes the alias, recreates the store and costs one
  re-login; if the platform offers no keystore at all it falls back to the legacy
  private file with an `Log.e` rather than crashing on launch.
- **Notifications are socket-driven.** `data/notifications/VoizaNotifier` is created
  once in `ServiceLocator` and observes the process-wide socket, so a gift addressed
  to you, an operator warning, and a kick still land when no room screen is alive.
  It only posts when the app is backgrounded (`ProcessLifecycleOwner`) and
  `POST_NOTIFICATIONS` was granted — `MainActivity` asks once on Android 13+.
  Real FCM is a transport swap, not a rewrite: fetch the FCM registration token and
  `PUT /api/auth/me/device-token` with it; the backend already sends gift and
  withdrawal pushes (`services/push.service.ts`) whenever `FCM_PROJECT_ID` +
  `FCM_SERVICE_ACCOUNT_FILE` are configured, and logs a no-op otherwise.
- **The cached user is refreshed at cold start.** `ServiceLocator.ensureSessionValid()`
  (called by `MainActivity`) goes through `AuthRepository.refreshMe()` so the stored
  profile — including `diamondBalance` — is replaced by the server's copy before the
  first frame. It only logged the request before, which left the wallet chip and the
  gift sheet showing the balance from the day the user logged in; because
  `PartyRoomViewModel` only calls `refreshMe()` *after* a successful send, a stale 0
  made gifts unsendable with no way back. A 401 still drops the session.
- **Socket auth** connects with `auth: { token }` (Socket.IO v5 handshake
  auth), path `/socket.io`, same host as the REST API; it re-dials
  automatically when the token changes (login/logout).
- **A reconnect re-subscribes the room, and the room screen re-takes the seat.**
  The server sees a reconnect as a brand-new connection and has already dropped the old
  one from `room:<id>`, so `VoizaSocketClient` remembers the last room it was asked to
  join and re-emits `room:join` on `EVENT_CONNECT`; the id is cleared by `leaveRoom` and
  by `disconnect`, neither of which is a temporary drop. That alone is not enough after a
  real network blip: LiveKit reports the member gone, the webhook stamps
  `room_participants.left_at`, and the server's membership gate then rightly refuses the
  socket's own re-join. So `PartyRoomViewModel.observeSocketRecovery()` watches the
  connection edge and re-runs `JoinRoomUseCase`, which re-claims presence and re-emits the
  socket join, then applies the returned snapshot without touching the LiveKit session —
  LiveKit reconnects itself, and only publish rights may have moved with the seat. The
  room is process-wide state, so leaving a screen unsubscribes the shared socket rather
  than closing it, and `MainActivity.onDestroy` calls `disconnect()`, never the old
  `destroy()`: the singleton is never rebuilt, and cancelling its scope would take voice
  with it for the next `MainActivity`.
- **The hand-raise queue needs the detail endpoint, not just the socket.**
  `room:hand_raise` is a room broadcast (`emitToRoom`, sender included), but a
  host who opens the room later never sees raises that happened before
  connecting — and the join response has no `handRaises` key. So
  `PartyRoomViewModel.loadChatHistory()` seeds the queue from
  `GET /api/rooms/:id`, and the live event only maintains it. With the microphone
  gate on, a member's own pending ask is *not* in that payload (the queue is host-only), so a
  rejoin shows the button un-pressed; tapping it again is `POST /seat` a second time, and the
  server's pending-request index answers with the row it already had rather than a second one.
- **The microphone gate is the host's switch, and the server decides what the tap means.**
  `PATCH /api/rooms/:id` is the only writer of `speakerApprovalRequired` — there is no route for it —
  so `CreateRoomScreen` puts that switch on the edit form and nowhere else. With the switch on, an
  audience tap on an empty seat gets **202 `{requested, request}`** instead of a seat, which is why
  `TakeSeatUseCase` returns `SeatTakeResult.Seated | Queued` rather than a seat list: the branch is
  read off the response, never assumed. The host's queue comes from
  `GET /api/rooms/:id/speaker-requests` (403 for anyone else) and is drawn in the server's
  `created_at` order — `AudienceListSheet` does not re-sort it, because a queue a phone reorders is a
  queue where the loudest newcomer speaks first. `room:speaker_request` and
  `room:speaker_request_updated` both collapse into one instruction: re-read the list. Patching the
  local copy drifts the moment an emit is missed.
- **An invitation seats a member; it does not turn their microphone on.**
  `POST /api/rooms/:id/seat/:index/invite` is immediate — the server seats, grants publish and clears
  any pending request for them — so the invitee's consent is necessarily local:
  `PartyRoomViewModel` shows an accept/decline dialog and holds `canPublish` off (in `applySeats` and
  `it_publishCan`) until they answer, because the seat snapshot that follows would otherwise publish
  audio nobody agreed to. Declining is the existing leave-seat call, and accepting asks nothing of the
  server. The publisher token a later reconnect dials with is the one carried privately on
  `room:seat_invited`, not the audience copy from the join.
- **The pinned notice has two writers and one renderer.** `POST /api/rooms/:id/announcement` (300
  characters; blank clears) is what the host's composer calls, and `room:announcement` is how everyone
  else updates — including an operator's override. `room:profile_updated` carries the same fields, and
  there the difference between null and absent matters: a broadcast from a server that predates the
  notice omits it, and omission must not be painted as "the host cleared it".
- **The member card asks the server before it answers anything.** `MemberSheet` opens from a roster
  row or a chat author and its first act is `GET /api/users/:id/relationship`; the four flags it
  paints come from that response, not from a local tally, and unblocking re-reads it before the card
  is drawn again. Follow and block post the verb and then draw the boolean the 200 carries
  (`{following}` / `{blocked}`), so a refused ask leaves the row in the server's state rather than
  the tapped one. A block closes the card, because the room must not offer a follow it just made
  impossible in both directions, and the report form is worded as a review and not a removal —
  which is exactly what `user_reports` does: it queues a row for a person, and an open duplicate
  comes back 409 with the form left open and the member's text intact.
- **A profile edit is a full replacement, not a patch.** `room:profile_updated` carries the
  room as it now stands, so a `null` language or rules line means the host cleared it and
  the client must blank what it was showing — not keep the previous value.
- **The socket audience snapshot includes seated members** (`seatSnapshot()`
  returns seats + audience), so any "who is in my room" UI must dedupe against
  `seats` or the roster shows people twice — see `AudienceListSheet`.
- LiveKit SDK surface is verified against 2.13.0: events come off
  `room.events.events` (a `SharedFlow`), the disconnect event is
  `RoomEvent.Disconnected`, mic tracks come from `createAudioTrack()`, and
  `Participant.Identity.value` (not `stringValue`) carries the user id. Bump
  `livekit-android` only as a coordinated upgrade.

## Feature map

- `ui/screens/auth` — phone + country-code → 6-digit OTP, optional first-login
  username, gradient CTA; when the backend runs in dev mode it returns
  `devCode`, the field auto-fills and a hint chip tells the reviewer.
- `ui/screens/home` — top bar (avatar/username/diamond chip), Popular/Party/
  Music tabs → `GET /api/rooms?category=`, a discovery row above the grid (search box and
  the `default|popular|trending|recent` chips are query parameters, never a client-side
  re-sort of the rows already on screen; **My Room** switches to `GET /api/rooms/mine` and
  hides the sort chips because that endpoint has its own fixed order; **Quick Join** takes
  `GET /api/rooms/quick-join`'s id and navigates, so "the busiest room I can enter" is the
  server's judgement), responsive room grid (cover, host,
  listener badge, gift-value flame, PRIVATE lock), pull-to-refresh (which re-reads the banner wall
  on the same gesture, so a campaign switched on mid-scroll arrives with the rooms), empty
  state, FAB → `createRoom` (title/category/language/region/rules/public-private+password/capacity, the range
  and default of which come from `GET /api/rooms/capacity`). The same screen is the edit
  screen (`editRoom/{id}`, reached from the host's pencil icon): it prefills from
  `GET /api/rooms/:id` rather than the lobby row it was launched from, hides the access,
  password and capacity fields the `PATCH` refuses, adds the one switch that route does accept —
  `speakerApprovalRequired`, the microphone gate, which has no endpoint of its own — and shows the
  server's own 403/409 text when a change or a delete is refused instead of guessing client-side.
- `ui/screens/room` — seat grid (3 across, or 4 narrower cells once the room has more
  than nine seats) with speaking rings, mute/lock overlays, host emphasis ring and a `HOST`
  pill on the occupied host seat; danmaku (barrage) layer over the seats (`BarrageOverlay`,
  only messages that arrive while you watch, toggle in the strip); audience
  strip with a live hand-raise badge that opens `AudienceListSheet` (on the mic / requests to
  speak, in the server's queue order with Seat and Decline for the host / waiting to speak /
  pure listeners; a host can also invite any listener straight onto the first free speaker seat).
  Any row with an account behind it — here, or the author's face or name on a chat line — opens
  `MemberSheet`, that member's own card: follow or unfollow, report to the team, block or unblock;
  auto-scrolling chat overlay (gift lines
  highlighted, plus the SYSTEM `"<name> entered the room"` notices). The overlay's smiley
  icon opens an emoji strip loaded from `GET /api/emoji`: tapping a tile inserts the token
  (`[smile]`) rather than a picture, because the token is what the message stores and what
  the room's other clients draw art for. `ChatEmoji.rememberEmojiMessage` scans a line with
  the `codePattern` that same response published — never a copy of it that could drift — and
  renders the row with `BasicText(inlineContent = …)`, since Material 3's `Text` has no
  inline-content parameter and would show the raw token. A code with no row (retired, or
  typed by hand) is left exactly as written, and `BarrageOverlay` flies the same rendering; action bar
  (mic / raise-hand / like / gifts / leave — the raise-hand button is the same tap in both room modes,
  and which endpoint it calls is the host's switch, not this client's guess) where the like button reports a
  debounced total and paints hearts from the server's `room:liked` batch in a
  corner `HeartLayer`; directly above that bar a `ReactionStrip` of the operator's own emoji sends
  `room:reaction` on a tap and `ReactionLayer` flies the art the server answered with, for every
  member in the room; small gifts scroll in a right-edge `GiftTickerColumn`,
  big gifts take the screen through the 3-deep queue, and every joiner above the
  VIP thresholds gets an `EntryBanner` — a joiner who wears a paid ride also gets
  `EntryRideOverlay`, which opens that file in the renderer its format names and prints
  "`<name>` arrives in `<ride>`" at the foot of the screen; host per-seat sheet (`HostControlsSheet`:
  lock, mute, kick as icon rows); a Games chip in the top bar opens the room's match
  desk; the host's pencil icon opens the edit screen; below the top bar an
  `AnnouncementBanner` shows the notice the host pinned (the host taps it to open
  `AnnouncementEditorDialog`, which writes `POST /api/rooms/:id/announcement` — blank clears — and
  everyone repaints from `room:announcement`), and a `RulesBanner` shows the room's `rules` line
  (expandable, collapsed to two lines). A `RoomNoticePill` names the single thing that just happened
  to *you* — the request is with the host, the host declined, the notice is saved — and dismisses
  itself; an unanswered seat invitation is a dialog instead of a pill, because that one needs an
  answer before the microphone moves. The top bar prints `language · region` next to the room number
  when the host stated them; `room:profile_updated` swaps all of that live, and `room:closed` kicks
  you back home.
- `ui/screens/game` — `GameLobbyScreen` (the room's desk: what the server offers and
  at which pinned rules version, open tables, live tables, your recent matches) and
  `GameScreen` (one board per driver: Tic-Tac-Toe grid, Quiz Battle round with the
  server's own scoring and no answer key on the wire, Ludo track with the engine's
  start-roll gate). Every tap posts an intent and waits for `game:update` or the POST's
  own response before anything on the board moves, so a rejected move cannot leave a
  phantom piece; the settlement card reads only pool figures the engine wrote. Opening
  the desk keeps the room entry on the back stack, so the LiveKit voice connection owned
  by `PartyRoomViewModel` survives the visit.
- `ui/screens/gift` — catalogue behind `CategoryTabs` (All + the shelves an operator maintains on
  the panel, from `GET /api/gifts`'s `categories` array; `giftCategoryTabs` keeps the server's own
  order, drops a shelf no gift sits under, and — on a backend that ships no shelf list — reproduces
  the old behaviour of one tab per distinct category string), a paged 4×2 tile panel sent with two taps,
  selected-gift summary bar, price in diamonds, quantity presets (1/5/10/20/Max) +
  stepper, speaker target chips (host default), insufficient-balance state, and a
  **Ranking** chip that opens `GiftRankingSheet` — Gifters (`role=senders`,
  diamonds spent) or Hosts (`role=receivers`, r-coins earned) over day/week/month.
  A lucky box is one of these tiles: it buys through the same send, and its only difference on
  screen is the disclosed-odds line under the price.
  Gifts with a `minVipLevel` above your `vipLevel` show a gold `VIP n` chip instead of a price and stay previewable, but
  the send CTA is replaced by the reason (`selectedGiftLocked`): the tier is
  operator-assigned and the backend enforces it with `403 vip_required` before it
  ever looks at your balance.
- `ui/components/banner` — the four surfaces a promotional campaign is drawn on, all reading the
  same `BannersStore` list and all taking their tap target from the server's `ctaType`/`ctaValue`
  pair rather than a client-side guess. `PromoBannerStrip(placement)` auto-advances between an
  operator's rows on its own dwell (the row's `durationMs` when it set one), prints dots, and is a
  no-op that reserves no height when the placement has nothing live;
  `SplashBannerOverlay()` sits above the nav graph in `MainActivity` for the length of the first
  SPLASH row and can be skipped. `BannerArt` picks the renderer from `format`, `BannerHost` counts
  one impression per row per session and every tap. Inserted at: `HOME` under Home's discovery row,
  `GIFT` above the gift panel's pages (a shorter card — the Send button owns the bottom of that
  dialog), `GAME` under the desk's error line, `SPLASH` over cold start.
- `ui/screens/store` — one chip per kind (*Rings*, *Themes*, *Flourishes*, *Arrivals*) over a grid
  of server rows, nothing cached: the catalogue, the caller's holdings and the balance are re-read on
  `ON_RESUME`, and a purchase re-reads them rather than patching the tile. Price, rental period
  (`priceLine`) and expiry (`ownedLine`, "Yours until <date>" or "Yours permanently") are all the
  row's own fields, so a period is an operator's number and not a client constant. A row whose
  `minVipLevel` is above your tier is still readable, and the buy/renew button states the reason
  (`vipLocked` is display courtesy only — `POST /api/store/purchase` answers `403 vip_required`);
  wearing an already-owned row is never tier-gated, so a support grant stays wearable.
  `recommended` only badges the tile — the server already sorts those rows first. A flourish and a
  ride are playable from the detail sheet ("Tap to play"); a ring and a theme are still pictures.
  Rows an operator retired but the member still paid for list apart, with their own expiry.
- `ui/screens/wallet` — diamond hero card, R-coin earnings, preset recharge,
  withdrawal sheet, +/- coloured ledger. Balances stay live: the private
  `wallet:update` event is folded into the cached session by
  `SessionManager.applyWalletUpdate()`, and only the side the server actually names is
  replaced, so a gift sender never sees their R-coin balance drop to zero.
  The recharge sheet still calls `POST /api/wallet/recharge`, the simulated path: it
  works only while the backend runs `PAYMENTS_PROVIDER=simulated` and starts answering
  `403 payments_provider_is_stripe` the moment the stack charges for real. Shipping
  money means replacing that one call with `POST /api/wallet/recharge/checkout` plus a
  card sheet (Stripe PaymentSheet, `com.stripe:stripe-android`); the server side and the
  `wallet:update` refresh are already in place, so no polling is needed.
- `ui/screens/profile` — identity header with HOST/AGENCY badges plus a gold
  `VIP n` pill whenever the spend tier is above 0, lifetime
  stats, edit-profile dialog (`PATCH /api/auth/me`), wallet link, logout.
