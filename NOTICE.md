# Notice

This repository (`backend/`, `admin-panel/`, `android/`) is licensed under
**AGPL-3.0-only** — see the `license` field in `backend/package.json`. This file
records where the room-effect behaviour and the served artwork came from, because
both questions will be asked before this ships.

## 1. Room effects: behaviour credited to `Tencent-RTC/TUILiveKit` (MIT)

The gift/like/entry interactions in `android/app/src/main/java/com/voiza/app/`
were studied from <https://github.com/Tencent-RTC/TUILiveKit>, MIT-licensed:

> Copyright (c) 2024 Tencent RTC Community

What was taken is **pacing and policy, expressed as numbers and a queue rule**, all
of it re-authored in Kotlin:

| Behaviour ported | Where it lives here |
| --- | --- |
| 4-across × 2-down gift panel, eight tiles a page, two taps to send | `domain/usecase/RoomEffects.kt` (`PANEL_*`), `ui/screens/gift/GiftDialog.kt` |
| Small gifts scroll a 3-row column that dismisses itself after 3 s | `TICKER_MAX`, `GIFT_DISMISS_MS`, `ui/screens/room/GiftTickerColumn.kt` |
| Expensive gifts hold the screen, serialized 3 deep, with the local user's own purchase winning the line | `TAKEOVER_MAX`, `enqueueTakeover()` |
| A tap storm is reported once per window, capped, and never trusted for the displayed total | `LIKE_FLUSH_MS`, `LIKE_MAX_REPORT`, `backend/src/services/like.service.ts` |
| Inbound like batch plays a short puff of bezier hearts | `HEARTS_PER_EVENT`, `HEART_STAGGER_MS`, `ui/screens/room/HeartLayer.kt` |
| Join banner sized by spend tier | `entryTier()`, `ui/screens/room/EntryBanner.kt` |
| One `"<name> entered the room"` chat row per join | `backend/src/services/socket.service.ts` (`announceEntry`) |
| Gifter/earner ranking board | `GET /api/users/top?role=`, `ui/screens/room/GiftRankingSheet.kt` |

What was **not** taken, deliberately:

* **No code.** No file in this repository is copied, translated or generated from
  TUILiveKit's Kotlin. `grep -rin "TUILiveKit\|Tencent"` over `backend/src`,
  `android/app/src` and `admin-panel/src` finds only the comment blocks that credit
  it (`RoomEffects.kt`, `like.service.ts`, `socket.service.ts`); the only other hits
  are in this file and in `THIRD_PARTY_LICENSES/`.
* **No SDK and no API.** Neither `com.tencent.*` nor any Tencent cloud endpoint
  appears in `android/app/build.gradle.kts`, `backend/package.json` or the compose
  stack. The app never contacts a Tencent service; every event it draws arrives on
  Socket.IO from this backend, and every asset URL it loads is served from
  `backend/public/` by this API. Chat, presence, gifts, likes and effects are all
  first-party.
* **No binary animation format.** TUILiveKit ships its gift scenes as SVGA/MP4
  behind a proprietary player. Rather than depend on that player, this project
  serves **Lottie JSON generated here** by `backend/scripts/lottie-kit.cjs` and
  played by the ordinary `com.airbnb.android:lottie-compose` dependency.

## 2. Artwork and sound

Three things under `backend/public/` came from outside this repository, and both
their licences and their exact upstream paths are recorded beside them:

* **`backend/public/emoji/`** — the 62-image room-chat emoji set, taken from
  Tencent's open-source UI kits:
  [`THIRD_PARTY_LICENSES/tuilivekit-emoji/PROVENANCE.md`](THIRD_PARTY_LICENSES/tuilivekit-emoji/PROVENANCE.md).
* **`backend/public/badges/trace/`** — the 21 rank-ladder seals, and
  **`backend/public/effects/room-spectrum.json`** and **`room-voice.json`** — two
  ambient loops. All four are from the MIT-licensed *Trace* Flutter template
  (Copyright (c) 2023 Matula José Alberto):
  [`THIRD_PARTY_LICENSES/trace-assets/PROVENANCE.md`](THIRD_PARTY_LICENSES/trace-assets/PROVENANCE.md)
  holds the licence text, the file-by-file table, the byte-identity check and the
  list of animations from that same folder that were inspected and refused. Only
  image and Lottie files were taken from it — no Dart source.

Everything else under `backend/public/` — the gift icons and their Lottie overlays,
the `welcome.json` flourish, the remaining ambient loops, the theme wallpapers, the demo
avatars, the `gifts/sounds/*.wav` and the `badges/level-*.png` fallbacks — is **generated
by this repository's own `backend/scripts/generate-placeholder-assets.cjs`** from vector
drawing routines (no third-party image, icon set, sound pack or model, and the generator
is deterministic: re-running it leaves the directory byte-identical).

Those generated files are deliberately plain placeholders. They are yours to replace
with licensed art at any time — the catalogue rows store root-relative URLs, so
swapping the directory (or pointing it at a CDN) is all a change of art requires. Do
not ship someone else's gift icons or animations in their place without the right to
redistribute them. Migration `0018_imported_asset_library.sql` is what that replacement
looks like in practice: it re-points the ladder at the imported seals and registers the
imported loops as options, matching only rows that still hold a placeholder so an
operator's own upload is never overwritten.

A third place art can come from is **`backend/uploads/`** — the files an operator puts
there at runtime through the panel's Media library. They are outside the repository and
outside this notice: whoever uploads a gift icon, Lottie scene, sound, room effect or rank
badge owns the question of whether they may redistribute it. The store refuses bytes whose
format does not match the slot it is going into, but it cannot judge a licence.

## 3. Third-party dependencies

Standard open-source libraries, none of them a Tencent product. Audio transport is
**self-hosted LiveKit** (`livekit-server-sdk` on the backend, `io.livekit:livekit-android`
on the phone), and the SFU runs from `docker-compose.yml` with `livekit.yaml`.

* Backend: `express`, `socket.io`, `pg`, `ioredis`, `jsonwebtoken`, `cors`, `helmet`,
  `dotenv`, `livekit-server-sdk`
* Android: Jetpack Compose / AndroidX, `retrofit2` + `converter-gson`, `okhttp3`,
  `gson`, `coil-compose`, `lottie-compose`, `socket.io-client`, `livekit-android`,
  `security-crypto`, `kotlinx-coroutines`
* Admin panel: React, `react-router-dom`, `socket.io-client`, `lottie-web`, built with
  Vite + Tailwind CSS (see `admin-panel/package.json`)

## 4. Trademarks

Tencent, TUILiveKit, LiveKit and the other names above are trademarks of their
respective owners. Crediting a project's design language does not imply endorsement
by its maintainer, and this software is not affiliated with or supported by Tencent.
