# Voiza — App Feature Availability, Suggestions and Change Log

Date: 2026-11-20

## 1. What the app already has (verified from code)

### Android (Kotlin + Jetpack Compose, Material 3)
- Phone + OTP login with country code entry and dev-code auto-fill.
- Home lobby with category tabs, search, trending/recent sort, Quick Join and My Room.
- Party room: seats (host + speakers), audience, chat, gifts (Lottie/SVGA/MP4), reactions, likes, entry rides, themes.
- Wallet: diamond + R-coin balances, recharge presets, withdrawal sheet with policy, transaction history.
- Social: follow/unfollow, block/unblock, report, followers/following lists, other-user profile.
- Games: lobby + Tic-Tac-Toe/Quiz/Ludo boards.
- Store/Decoration: frames, themes, flourishes, rides, chat bubbles.
- Admin-facing partner desks (agency, seller, BD) via member token.
- LiveKit audio, Socket.IO realtime, FCM push + local notifier.

### Backend (Node + TypeScript + PostgreSQL)
- Auth (phone/OTP, JWT, admin JWT), rooms, seats, chat, gifts, wallet, withdrawals.
- Social graph (follow, block, report), levels/XP, VIP tiers.
- Games engine with lifecycle, fees, settlement, disputes.
- Business accounts (coin sellers, BD managers/agents), recharge orders, receipts.
- Admin panel (React) for users, rooms, gifts, withdrawals, agencies, banners, decoration, ranks, moderation, finance.

### Jetpack Compose dependencies
- Already present in `android/app/build.gradle.kts`: Compose BOM, `ui`, `ui-graphics`, `ui-tooling-preview`, `material3`, `material-icons-extended`, navigation-compose, plus `debugImplementation("ui-tooling")`.
- Compose preview support is therefore available; add `@Preview` to composables as needed. No dependency change required.

## 2. Requested changes — status

| Request | Status | Notes |
|---|---|---|
| Compose deps for Android Studio preview | Already available | See above. |
| Rooms persist as active (not auto-closed) | Partial | LiveKit `empty_timeout` is already ~29 days; backend only closes a room on explicit host close or LiveKit `room_finished`. Demo seed default turned off so no demo rooms appear. |
| Default rooms removed | Done | `SEED_DEMO_DATA` default changed to `0`. |
| All accounts/balances reset to zero | Done (via seed off) | No demo accounts are created on a fresh boot. |
| Diamond packages require first recharge | Done (server + client display) | Backend derives the gate from completed RECHARGE rows and publishes packages/`firstRecharge` on `GET /api/wallet`. Android reads both (`WalletRepository.packages()`/`firstRecharge()`) and shows the operator's pack chips plus the first-recharge banner. Pack taps open Stripe PaymentSheet when a publishable key is set (simulated route otherwise); the gate itself is enforced on the server where diamonds are spent. |
| Country codes (+92 PK, +91 IN, +971 Dubai, +968 Oman, +966, +965, +974, +880 BD, +44 UK, +86 China, +1 US/Canada) | Done (UI) | Auth screen now offers a country-code dropdown. |
| Announcement ticker for diamond/R-coin/game events to region + nearby rooms | Done (global) | Backend emits `announcement:ticker` for top-up, seller recharge, top ranker, game start and game winner; `AnnouncementTicker` overlays every screen. Region is carried on game events for later targeting. |
| Friends/unfriend/follow/unfollow + personal messaging + distance | Partial | Backend friends/DM API (migration 0049) is complete and the Android client consumes it: `FriendsScreen` + `FriendsViewModel` cover lists, requests, unfriend, do-not-contact and DMs, with live `friend:request` / `dm:message` socket flows. 0049 has not been applied here because this environment has no running Postgres/Docker daemon; `npm run db:migrate` (or the backend container entrypoint) applies it on a real stack. Distance is still unimplemented. |
| Two-request limit for unfriend/unfollow | Done (server) | Enforced in `friends.service.ts`; the Android client shows the server's refusal instead of predicting it. |
| Host flower/follower system | Partial | Follow/unfollow/block exists. |
| Visa payment for diamond top-up | Done (needs operator keys) | Backend Stripe checkout/webhook is complete; the webhook now settles the signed charged amount (so pack promos are not re-priced from the diamond count). Android ships `com.stripe:stripe-android:20.40.0`; with `VOIZA_STRIPE_PUBLISHABLE_KEY` set, pack chips create a PaymentIntent and present PaymentSheet, and a completed sheet re-reads the ledger. Without a key the simulated top-up remains the fallback. |
| Coin-seller marketplace (member side) | Done (needs migration 0050) | The seller/BD operations desk (`/api/partner`, `PartnerDeskScreen`) was already built; the missing member-facing market is now too. `/api/marketplace` lists approved sellers and their server-priced packages, opens buyer-scoped manual orders, lists only the caller's orders and accepts their own proof of payment — nothing credits diamonds. Android `MarketplaceScreen` (opened from the wallet) buys diamonds, attaches proof and sells R-coins through the booked withdrawal path. Migration `0050_member_receipt_uploader.sql` adds the member uploader column; apply it with the runner on a real stack. |

## 3. Suggestions (prioritised)

1. Keep `PAYMENTS_PROVIDER=stripe` in production, set a real `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` on the server and `VOIZA_STRIPE_PUBLISHABLE_KEY` on the Android build, then retire the simulated mint from the member surface.
2. Migration 0049 already provides the friend-request table, 2-request cap, "do not contact again" flag and DM storage; apply it on the deployment stack. Distance between friends is the remaining part of that request.
3. Broadcast announcement events over Socket.IO (`announcement:ticker`) scoped by region/nearby-room membership; render in a reusable ticker composable on every screen.
4. Apply migrations 0049 (friends/DM) and 0050 (member receipt uploader) on deployment via `npm run db:migrate`; neither could be applied here because this environment has no running Postgres/Docker daemon.
5. Add location capture (opt-in) and a distance helper between friends only; never expose coordinates to non-friends.
6. Add `@Preview` annotations to key composables for Android Studio design view.
7. Keep demo seed off by default for clean installs; document how to re-enable for demos.

## 4. Files changed in this pass

- `android/app/build.gradle.kts`, `di/ServiceLocator.kt` — `stripe-android:20.40.0` and `VOIZA_STRIPE_PUBLISHABLE_KEY`.
- `android/app/src/main/java/com/voiza/app/viewmodel/WalletViewModel.kt`, `ui/screens/wallet/WalletScreen.kt`, `data/remote/VoizaApiService.kt` — real PaymentSheet checkout; simulated fallback when no key.
- `android/app/src/main/java/com/voiza/app/ui/screens/marketplace/MarketplaceScreen.kt` + `MarketplaceViewModel`, DTO/model/mapper/repository — member coin-seller market.
- `backend/src/controllers/payments.controller.ts`, `services/stripe.service.ts` — settle the signed charged amount, not a recomputed rate.
- `backend/src/{controllers,services,routes}/marketplace.*`, `database/migrations/0050_member_receipt_uploader.sql`, `scripts/seller-marketplace-e2e.cjs` — member marketplace API.
- `android/app/src/main/java/com/voiza/app/ui/screens/auth/AuthScreen.kt` — country-code dropdown.
- `docker-compose.yml` — `SEED_DEMO_DATA` default `0`.
- `docs/FEATURE_AUDIT.md` — this report.
