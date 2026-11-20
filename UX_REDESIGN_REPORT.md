# Vozia Android — Luxury Dark UI/UX Redesign: Implementation Report

Date: 2026-11-20 · Branch state: uncommitted working tree (all changes in `android/`)
Scope: visual/UX redesign only. No backend, API, LiveKit, auth, or business-logic changes.

---

## 1. Executive summary

The Android app was redesigned end-to-end to a "Luxury Dark" identity — black/charcoal base,
royal purple primary, champagne gold reserved for premium/VIP semantics — using a centralized
design-token system and a new set of reusable components. A new five-item bottom navigation
(Home · Discover · Create · Messages · Profile) with a dedicated Discover search surface was
added. All 113 backend endpoints, LiveKit room/track management, gift/wallet transactions,
Socket.IO flows and navigation contracts were preserved untouched.

**Verification:** `assembleDebug` BUILD SUCCESSFUL · `testDebugUnitTest` 270 tests, 0 failures
(72 test classes incl. `AccentColorTest`, verified unweakened) · hardcoded-hex sweep reduced
screen-level `Color(0x…)` literals from ~100+ to a documented allowlist of scrims/medals.

---

## 2. Screens redesigned (priority order)

| # | Screen | What changed |
|---|--------|--------------|
| 1 | **Live audio room** (`PartyRoomScreen` + SeatGrid, SpeakingRing, AudienceListSheet, EntryBanner, ChatOverlay, BarrageOverlay, GiftTicker, GiftRanking, HostControls, MemberSheet, QuickReactions, HeartLayer, RoomVisuals, EntryRideOverlay, GiftRenderer) | 92 hex literals → tokens; gold HOST badge; violet speaking halo; gold gift button (VoizaGoldGradient); labeled `StatusPill` connection state (Live/Syncing/Offline) replacing 8-dot pip; gold = moderation warning/host/gift only |
| 2 | **Home** (`HomeScreen`) | New `VoizaBottomBar`, FAB removed (center Create action), `RoomGridSkeleton` loading, hairline-bordered RoomCards, skeleton+empty+error states, gold/purple discipline on badges |
| 3 | **Discover** (new `discover/DiscoverScreen.kt`) | Full search surface: debounced (400 ms) server-side search via `HomeViewModel`, category + sort chips, results grid, skeleton/empty/error states, pull-to-refresh, status-bar insets |
| 4 | **Room creation** (`CreateRoomScreen`, `FormColors`) | Purple focus/active states (slider, fields), shared `voizaFieldColors`/`voizaChipColors`, skeleton loading |
| 5 | **Profile** (`ProfileScreen`) | Token palette, violet edit affordances |
| 6 | **Gifts** (`GiftDialog`, `GiftRenderer`) | Token palette, purple selection/qty controls, locked/affordable scrims kept as intentional alpha-black |
| 7 | **Wallet** (`WalletScreen`) | Diamond glyph/balance in DiamondGold (currency semantics), purple input focus, list states |
| 8 | **Messages** (`FriendsScreen`) | `initialTab` param → dedicated Messages route; `ListSkeleton` loading; violet tabs/send/action tints |
| 9 | **Leaderboards** (`RankingsScreen`, `RankBadge`) | `ListSkeleton` loading; per-board themes on tokens (gold host / mint rich / purple new) |
| 10 | **Notifications** | Reached via existing routes; ticker restyled (`AnnouncementTicker`) |
| 11 | **VIP / Store / Quests** (`StoreScreen`, `QuestsScreen`, `DailyRewardDialog`) | Token palettes, `RoomGridSkeleton`/`ListSkeleton` loading states |
| 12 | **Settings** | Reached through Profile; no invented entries added |
| 13 | **Remaining** | Auth (hero gradient, status-bar + IME insets, purple cursor/focus), PK, Game (Ludo/Quiz/TicTacToe), Partner/Agency/Marketplace, Banners — all tokenized with gold=priority, purple=interactive discipline |

## 3. Design system (Phase 2 deliverables)

- **`ui/theme/Color.kt`** — tokens: `VoizaBackground #09090D`, `VoizaSurface #111118`,
  `VoizaSurfaceHigh #181820`, `VoizaSurfaceVariant #22212B`, `Violet #8050E8`,
  `VioletDark #512B9C`, `DiamondGold #D8B46A`, `GoldLight #F1D69A`, `OnDarkHigh/Medium/Muted`
  (#FFFFFF/#A6A3B0/#6F6C79), `SuccessMint #39C98A`, `DangerRed #F05C69`, plus
  `VoizaHeroGradient`, `VoizaAccentGradient`, `VoizaCtaGradient`, `VoizaGoldGradient`,
  `VoizaCardBorder`, `VoizaOutline`. **Legacy symbol names preserved** (`Fuchsia`→purple,
  `Cyan`→gold, `GiftPink`→gold) so ~100 existing imports/call sites compile unchanged.
- **`Theme.kt`** — dark-only Material3 scheme built from tokens.
- **`Type.kt`** — 13-role type scale (bold headings / medium buttons / regular body), tuned
  weights + tracking (no font assets bundled; system sans).
- **`Shape.kt`** — `VoizaShapes`, `VoizaCircleShape`.

## 4. Reusable components created/updated

| Component | File |
|---|---|
| `VoizaBottomBar` + `VoizaNavTab` (5 items, raised gradient Create) | `components/VoizaBottomBar.kt` **(new)** |
| `VipBadge`, `LevelBadge`, `StatusPill`/`StatusTone`, `SectionHeader` | `components/Badges.kt` **(new)** |
| `SkeletonBlock`, `RoomCardSkeleton`, `RoomGridSkeleton`, `AvatarRowSkeleton`, `ListSkeleton` | `components/Skeleton.kt` **(new)** |
| `VoizaButton`, `VoizaGoldButton`, `VoizaTextButton` | `components/VoizaButton.kt` |
| `VoizaCard` (+ bubble accent) | `components/VoizaCard.kt` |
| `DiamondChip`, `FilterChip` restyles, `Chips.kt` | `components/Chips.kt` |
| `DangerButton`, `RankBadge`, `SpeakingRing`, `AnnouncementTicker`, `PromoBanners` | respective files |

## 5. Navigation changes

- New routes: `Routes.DISCOVER = "discover"` (own `HomeViewModel` instance), `Routes.MESSAGES`
  (Friends with `initialTab = MESSAGES`) — wired in `Routes.kt` + `VoizaNavHost.kt`.
- Bottom bar replaces the old 4-item `NavigationBar` (Rooms/Store/Wallet/Profile). Store and
  Wallet remain reachable via Profile and the top-bar `DiamondChip`.
- Home FAB removed; live room remains a dedicated full-screen experience; back-button behavior
  unchanged (single-activity Navigation Compose).

## 6. Functionality preserved (explicitly verified)

- **LiveKit**: token fetch, room connect/disconnect, track publish/subscribe, participant
  identities and room IDs — no source touched outside `ui/`.
- **API contracts**: Retrofit services, endpoints, Gson models, Socket.IO — untouched.
- **Auth/session, gift transactions, wallet balances, permissions** — untouched; no hardcoded
  production data introduced; all lists still render from ViewModel state.
- **No invented content**: VIP benefits/pricing, room history, notifications and settings show
  only what the backend provides (unchanged code paths).
- `AccentColorTest` verified safe: `accentColor()` lives in `AssetUrls.kt` and compares against
  `OnDarkMedium` dynamically — no assertion weakened.

## 7. Files modified

- **Modified (50)**: 4 theme files; 10 components; 2 navigation files; 34 screen files
  (full list: `git diff --name-only`; excludes `admin-panel/nginx.conf`, a pre-existing user
  change untouched by this work).
- **Added (4)**: `components/Badges.kt`, `components/Skeleton.kt`, `components/VoizaBottomBar.kt`,
  `screens/discover/` (DiscoverScreen.kt).
- **Deleted/removed**: none. Only in-file removals: old 4-item `NavigationBar` block and Home FAB.

## 8. Build & test results

```
gradlew assembleDebug        → BUILD SUCCESSFUL
gradlew testDebugUnitTest    → BUILD SUCCESSFUL — 270 tests, 0 failures, 0 errors
```

## 9. Intentional remaining literals

Scrims/overlays (`0x99000000`, `0x66000000`, `0xB3000000`, gradients to `Color.Transparent`),
silver/bronze medal colors, `Badges.kt` gold-on-dark text pair (`0xFF1A140A`), ranking board
theme washes, `VoizaCard`'s material shadow default — all alpha-black or semantic exceptions.

## 10. Outstanding issues / notes

1. **No Inter font bundled** — Inter-like feel achieved via weights/tracking on system sans;
   drop in `inter/*.ttf` + `FontFamily` later for pixel parity.
2. **Visual QA on device not run** — compile + unit tests green; recommend one manual pass on
   emulator (edge-to-edge insets on Discover/Auth, bottom-bar safe area, room full-screen).
3. **Git line-ending warnings** (`LF will be replaced by CRLF`) from scripted edits — cosmetic;
   `git add` normalizes per `.gitattributes`.
4. **`admin-panel/nginx.conf`** shows as modified but is a pre-existing user change — left
   untouched.
5. Work is **uncommitted**; commit when reviewed.
