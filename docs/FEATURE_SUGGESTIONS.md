# Voiza — Feature Suggestions

Based on the current codebase (rooms, seats, gifts, wallet, games, agencies, coin sellers, admin panel)
and the gaps in `docs/FEATURE_AUDIT.md`.

## P0 — Revenue and wallet

1. **Visa/card checkout in the Android wallet** — done: the backend's
   `POST /api/wallet/recharge/checkout` + signed webhook now feed Android PaymentSheet
   (`com.stripe:stripe-android:20.40.0`). It ships with a clear "first recharge" flow; the
   operator still has to supply keys and set `PAYMENTS_PROVIDER=stripe`.
2. **Diamond packages as server data** — done: migration `0048_diamond_packages.sql` and
   `GET /api/wallet/packages`; the wallet draws the operator's active packs and never computes a
   price on the device.
3. **First-recharge gate** — done: the server derives it from completed RECHARGE rows and the
   wallet shows progress plus the next step; the gate is enforced where diamonds are spent.
4. **Coin-seller marketplace** — done: `/api/marketplace` lists approved sellers and their
   server-priced packages, opens buyer-scoped manual orders, tracks only the caller's orders and
   accepts their own proof of payment; Android `MarketplaceScreen` is reached from the wallet.
   Needs migration `0050_member_receipt_uploader.sql` applied on the deployment stack.
5. **VIP subscription** — monthly diamonds + badge + frame + priority seat. Existing
   `vip_level` and store shelves give most of the pieces.
6. **Season/battle pass** — free and paid tracks, XP from gifts/quests/games, cosmetic rewards.

## P0 — Social and retention

7. **Friends system** — mutual follow becomes a friend edge; add friend requests,
   accept/decline, unfriend, and a two-request cap with a "do not contact again" flag.
8. **Direct messages** — one-to-one chat table keyed by the friend pair, with unread counts,
   block/report, and no messages between non-friends.
9. **Location/distance for friends only** — opt-in coarse location, distance shown only on a
   mutual friend card, never on public profiles.
10. **Host flower/follower system** — a host can receive "flowers" (a lightweight gift),
    followers get a badge, and hosts can see follower growth in the agency/creator desk.
11. **Announcement ticker** — server-driven `announcement:ticker` event with region and
    nearby-room targeting; render a reusable ticker composable on every screen.
12. **Referral and invite rewards** — invite code, first-recharge bonus, room-invite rewards.

## P1 — Live rooms and content

13. **Room persistence guarantee** — keep user-created rooms `ACTIVE` for the life of the
    account; only an explicit host/admin close changes status.
14. **Scheduled rooms and recurring events** — a host can schedule a party; users get a
    reminder and a "starting soon" card.
15. **Room categories/tags expansion** — music, languages, gaming, chill, study, etc., with
    server-side discovery already in place.
16. **Clip/highlight sharing** — short audio/video clips of gift moments, shareable outside
    the app.
17. **Co-host roles** — moderator, greeter, DJ, with scoped permissions.

## P1 — Safety and trust

18. **Age gate and spending limits** — daily/monthly diamond limits, parental controls,
    cooling-off for large top-ups.
19. **Content moderation** — chat filters, image/audio report evidence, repeat-offender
    escalation. The report queue already exists.
20. **Anti-cheat for games** — server timers/RNG already exist; add device integrity checks
    and dispute review UI.
21. **Account recovery** — email/backup code in addition to phone OTP.

## P2 — Product polish

22. **Localization** — Urdu, Arabic, Hindi, Bengali, Chinese; the app already carries
    language/region fields on rooms.
23. **Light/dark theme and accessibility** — font scaling, screen-reader labels, contrast.
24. **Offline cache** — last rooms, wallet snapshot and catalogue, with a clear stale banner.
25. **Deep links** — room, profile, gift and recharge links that open the right screen.
26. **Push notification preferences** — per-category toggles (gifts, follows, room events,
    payouts).

## P2 — Operations and admin

27. **Feature flags and maintenance mode** — already partly in `system_config`.
28. **Analytics dashboard** — DAU/WAU, retention, ARPU, gift funnel, recharge conversion.
29. **A/B testing** — package pricing, banner copy, onboarding.
30. **Audit/export improvements** — CSV exports for finance and moderation.

## Suggested first sprint

- Visa checkout + server-driven diamond packages + first-recharge gate (shipped; enable with Stripe keys on the server and Android build).
- Coin-seller marketplace (shipped; apply migration 0050 and wire the operator's approved sellers).
- Friends/DM schema and API, with the two-request cap — backend and Android client both wired (`FriendsScreen`, `FriendsViewModel`, live socket events).
- Announcement ticker event + composable.
- Room persistence and clean-install seed behaviour.
- `@Preview` coverage for the remaining component-level composables.
