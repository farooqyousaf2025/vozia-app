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
- **Gift/room animation.** `animationUrl` (.json served from `/gifts/*.json`)
  plays as a Lottie through `com.airbnb.android:lottie-compose`, fetched from
  the API origin at runtime — no animation ships in the APK. `GiftEffectOverlay`
  falls back to the pure-Compose treatment (icon float-up + particle burst)
  whenever a gift has no animation or the URL fails, and a 6 s watchdog pops the
  queue slot either way so a dead URL cannot stall the gift queue.
  `RoomVisuals.kt` adds the matching theme wallpaper, a once-per-join welcome
  flourish and a quiet ambient loop; unknown theme slugs degrade to the gradient.
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
  `EntryBanner.kt` and `GiftRankingSheet.kt` are hand-written Compose, and the
  queue policy they follow lives in one place, `domain/usecase/RoomEffects.kt`
  (pure Kotlin, unit-tested). `RoomEffects` decides that a `TICKER` gift scrolls a
  3-row column that dismisses itself after 3 s, that `FULLSCREEN` gifts
  serialise through a 3-deep queue which evicts the oldest entry *unless* every
  queued scene is the local user's own, and that a tap on the like button
  accumulates locally and reports at most 100 taps per 6 s flush. The numbers are
  the other kit's; the counting is ours — the client draws the server's `total`
  from `room:liked`, never its own tap count, and the ranking sheet renders
  whatever `GET /api/users/top` returns rather than a local tally. The ambient
  loop behind the seats is `room.ambientEffect` (server-chosen per category), the
  entry banner is tiered by `user_joined.user.vipLevel`, and the heart sprites are
  a `Canvas` bezier path, not a Lottie, so a hundred concurrent hearts cost one
  recomposition of one layer.
- **Gift panel is a paged 4×2 grid with two-tap send.** `GiftDialog` shows eight
  tiles per page (`HorizontalPager`, dot indicator, fixed `PANEL_HEIGHT` so the
  pager cannot resize while the second tap lands): first tap selects, second sends.
  The title row carries a **Ranking** chip that swaps the gift sheet for
  `GiftRankingSheet` — both are separate windows, so opening one closes the other.
- **Moderation traffic is room-scoped.** `room:kicked` and the operator's
  `room:warning` arrive on the private `user:<id>` channel, so both are filtered
  by `roomId` in `PartyRoomViewModel` before they touch the UI; a warning shows
  as a dismissible banner under the top bar and never leaves the host's screen.
- **Relative asset URLs.** `iconUrl`, `avatarUrl` and `coverUrl` arrive as
  root-relative paths (`/gifts/rose.png`) that belong to the API origin, so
  every Coil load goes through `ui/components/AssetUrls.kt` (`asAssetUrl()`),
  which prefixes the scheme+authority of `BuildConfig.VOIZA_API_BASE_URL`.
  Absolute URLs (a CDN) pass through untouched.
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
- **The hand-raise queue needs the detail endpoint, not just the socket.**
  `room:hand_raise` is a room broadcast (`emitToRoom`, sender included), but a
  host who opens the room later never sees raises that happened before
  connecting — and the join response has no `handRaises` key. So
  `PartyRoomViewModel.loadChatHistory()` seeds the queue from
  `GET /api/rooms/:id`, and the live event only maintains it.
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
  listener badge, gift-value flame, PRIVATE lock), pull-to-refresh, empty
  state, FAB → `createRoom` (title/category/language/region/rules/public-private+password/capacity, the range
  and default of which come from `GET /api/rooms/capacity`). The same screen is the edit
  screen (`editRoom/{id}`, reached from the host's pencil icon): it prefills from
  `GET /api/rooms/:id` rather than the lobby row it was launched from, hides the access,
  password and capacity fields the `PATCH` refuses, and shows the server's own 403/409
  text when a change or a delete is refused instead of guessing client-side.
- `ui/screens/room` — seat grid (3 across, or 4 narrower cells once the room has more
  than nine seats) with speaking rings, mute/lock overlays,
  host emphasis ring; danmaku (barrage) layer over the seats (`BarrageOverlay`,
  only messages that arrive while you watch, toggle in the strip); audience
  strip with a live hand-raise badge that opens `AudienceListSheet` (on the mic
  / waiting to speak / pure listeners); auto-scrolling chat overlay (gift lines
  highlighted, plus the SYSTEM `"<name> entered the room"` notices); action bar
  (mic / raise-hand / like / gifts / leave) where the like button reports a
  debounced total and paints hearts from the server's `room:liked` batch in a
  corner `HeartLayer`; small gifts scroll in a right-edge `GiftTickerColumn`,
  big gifts take the screen through the 3-deep queue, and every joiner above the
  VIP thresholds gets an `EntryBanner`; host per-seat sheet (`HostControlsSheet`:
  lock, mute, kick as icon rows); a Games chip in the top bar opens the room's match
  desk; the host's pencil icon opens the edit screen; below the top bar a
  `RulesBanner` shows the room's `rules` line (expandable, collapsed to two lines) and the
  top bar prints `language · region` next to the room number when the host stated them;
  `room:profile_updated` swaps all of that live, and `room:closed` kicks you back home.
- `ui/screens/game` — `GameLobbyScreen` (the room's desk: what the server offers and
  at which pinned rules version, open tables, live tables, your recent matches) and
  `GameScreen` (one board per driver: Tic-Tac-Toe grid, Quiz Battle round with the
  server's own scoring and no answer key on the wire, Ludo track with the engine's
  start-roll gate). Every tap posts an intent and waits for `game:update` or the POST's
  own response before anything on the board moves, so a rejected move cannot leave a
  phantom piece; the settlement card reads only pool figures the engine wrote. Opening
  the desk keeps the room entry on the back stack, so the LiveKit voice connection owned
  by `PartyRoomViewModel` survives the visit.
- `ui/screens/gift` — catalogue behind `CategoryTabs` (All + the categories the
  catalogue actually returns), a paged 4×2 tile panel sent with two taps,
  selected-gift summary bar, price in diamonds, quantity presets (1/5/10/20/Max) +
  stepper, speaker target chips (host default), insufficient-balance state, and a
  **Ranking** chip that opens `GiftRankingSheet` — Gifters (`role=senders`,
  diamonds spent) or Hosts (`role=receivers`, r-coins earned) over day/week/month.
  Gifts with a `minVipLevel` above your `vipLevel` show a gold `VIP n` chip instead of a price and stay previewable, but
  the send CTA is replaced by the reason (`selectedGiftLocked`): the tier is
  operator-assigned and the backend enforces it with `403 vip_required` before it
  ever looks at your balance.
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
