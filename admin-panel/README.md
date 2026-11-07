# Voiza Admin Panel

Back-office for the Voiza audio party platform: live stats, user moderation, room
monitor, virtual gift store and the R-coin withdrawal queue.

Stack: **Vite + React 18 + TypeScript + Tailwind CSS 3** (classic `tailwindcss@3` +
`postcss` + `autoprefixer` pipeline). No UI kit, no chart library — everything is
built from the small component set under `src/components/ui/`.

## Run standalone (development)

```bash
cd admin-panel
npm install
cp .env.example .env.local   # optional: point at a non-default backend
npm run dev                  # http://localhost:5173
```

`vite.config.ts` proxies `/api` to `http://localhost:4000` during development, and
`src/lib/api.ts` also calls `VITE_API_BASE_URL` directly when it is set.

Production build: `npm run build` (emits `dist/`), preview with `npm run preview`.

## Run via Docker Compose (full stack)

From the repository root:

```bash
docker compose up --build
# admin panel -> http://localhost:5173  (container serves nginx on port 80)
# backend     -> http://localhost:4000
```

The containerized panel serves the SPA with an nginx fallback and reverse-proxies
`/api` to the `backend:4000` service (see `nginx.conf`), so no CORS setup is
needed *when the bundle is built with a same-origin base*. That is the catch:
`apiBase()` defaults to `http://localhost:4000` and dials the backend directly, so the
proxy is only on the path if `VITE_API_BASE_URL` is set to the panel's own origin (an
empty string works and is what makes it same-origin). To build against a different API
base baked into the bundle:

```bash
docker build --build-arg VITE_API_BASE_URL=https://api.example.com -t voiza-admin .
```

`nginx.conf` listens on 443 and redirects 80, so it expects a certificate at
`/etc/nginx/tls/fullchain.pem` with its key at `/etc/nginx/tls/privkey.pem` and **fails to
start without them** — that is the intent for a public deploy, not a local one. To run the
container over plain HTTP, delete the 443 server and the redirect. Two things it also
carries that are easy to lose when the file is rewritten: `/socket.io/` is proxied with
`Upgrade`/`Connection` headers and a 120s read timeout — the ops console dials that path
websocket-only, so without the block a same-origin build gets an HTML body where the
handshake should be and the room monitor never goes live — and HSTS is emitted only when
the request actually arrived over TLS, so a local http:// panel cannot get itself pinned.

## Signing in

The panel authenticates against `POST /api/admin/login` (username + password, JWT
bearer afterwards). On a fresh stack the backend seeds a super-admin from
`ADMIN_USERNAME` / `ADMIN_PASSWORD` — with the defaults shipped in the root
`.env.example` that means username **`admin`**, password **`voiza-admin`**. Rotate
them (and `JWT_SECRET`) before exposing the panel. The alternative bootstrap path is
`POST /api/auth/verify-otp` with `ADMIN_BOOTSTRAP_PHONE` + `ADMIN_BOOTSTRAP_OTP`,
which returns an admin-scoped token for the same operator.

The sign-in screen prints those defaults as a bootstrap hint, but only under
`import.meta.env.DEV`. That is inlined at build time, so the block is dead-code
eliminated from a production bundle rather than merely hidden at render — verify with
`grep -r voiza-admin dist/assets/` after `npm run build`, which must return nothing.
`/api/admin/login` itself is throttled at 10 attempts per minute per IP and username;
a locked-out operator gets `429` and the message is shown as typed.

## Feature map

| Route           | What it does                                                                     |
| --------------- | -------------------------------------------------------------------------------- |
| `/`             | Overview: KPI cards, 7-day diamonds/rooms SVG trend chart, live rooms shortlist   |
| `/users`        | Search/filter/paginate users, adjust diamond/R-coin balances, ban/unban           |
| `/rooms`        | Room monitor: seat policy card (default speaker seats and the largest room a host may pick, `config:manage` to write, `room:read` to view), 5s polling, force-close, seat/audience drawer with disconnect |
| `/rooms/:id`    | Ops console: live seats/chat/listeners over Socket.IO, mute/lock/disconnect/ban, moderator announcement, host warning and the theme picker (`lottie-web` previews the generated animations) |
| `/gifts`        | Virtual store CRUD with live validation, inline active toggle, a ticker/full-screen effect tier selector, a Lottie preview of the gift overlay and an Upload button on each art field (`media:manage`; the URL box still accepts a CDN path by hand). **Lucky gift boxes** (`gift_box_outcomes`, migration `0027`) are edited in the same form: an `isLuckyBox` switch, one dial — `receiverShareBps`, typed as a human percent, with the platform's residual printed beside it ("Receiver keeps 60%" → the box banks 40%) — and a prize table you add to, remove from and edit in place (label, a `×2.5` multiplier that maps to 25000 bps, a relative weight), capped at 20 rows because a longer table cannot disclose its own odds. Each row live-prints the odds it produces in both units (`1 in 40 · 250 bps`), and a running line below the table states the expected multiplier and what the box pays of its own pool on average. That line is the server's guard, mirrored: `floor(Σ(multiplier × weight) / Σ weight)`, then `floor(expected × share / 10000)`, the same floors in the same order, so an operator sees "on average this box pays 250% of what it sells for" while typing rather than after a 400. The warning is deliberately non-blocking (the ladder is half-typed a lot) and the write still refuses. Updates go by `PUT` — `PATCH` 404s on this path — and the prize table is re-sent only when the table itself changed, since an omitted `boxOutcomes` means "leave the stored draw alone" while `boxOutcomes: []` on a live box is a refusal; switching a box off sends the flag alone, which is what deletes its prizes. Box rows carry a `box` badge in the grid with every prize and its odds printed under the price, so the draw is readable without opening the editor, and the earnings table flags box rows and prints **Paid / spent** (R-coins against diamonds), which on a box is the realised payout rate of the rolls rather than the price list's margin. Refusals arrive as stable `error.code` values and are rendered as sentences, not statuses: `lucky_box_needs_outcomes`, `lucky_box_too_many_outcomes`, `lucky_box_needs_reward_pool`, `lucky_box_outcomes_without_box`, `lucky_box_outcomes_invalid` and `lucky_box_payout_unbounded`, whose `error.details` (`expectedMultiplierBps`, `receiverShareBps`, `payoutRatioBps`) are worked into that sentence. A field the server rejects by bounds (`requireInt`/`requireString`) answers with `bad_request` and names the row, e.g. `boxOutcomes[0].weight must be >= 1`, which the panel shows as the server wrote it. The arithmetic and the phrasing live in `src/lib/lucky-box.ts`, mirroring `backend/src/services/lucky-box.service.ts` |
| `/withdrawals`  | R-coin cash-out queue: approve/reject with note                                   |
| `/media`        | Media library: upload gift icons, Lottie gift scenes, gift sounds, room wallpapers, room effects, entrance rides and rank badges (base64 over `POST /api/admin/uploads`), then list, preview, copy the stored path or delete a file. Needs `media:manage`; a file a catalogue row still points at cannot be deleted |
| `/banners`      | Promotional art (`banners`, migration `0028`) for the four surfaces a phone draws it on — splash, home, gift panel, game desk — in one list with a tab per placement. The card header prints what `GET /api/banners` publishes right now per placement, so a saved row is provably on the wall rather than only in the database, and each row shows its own status derived the same way the server derives it (`Switched off` / `Starts …` / `Ended …` / `Room has closed` / `On the wall`) with impressions, taps and the click-through rate beside it. `ArtField kind="BANNER"` uploads the seven containers the media slot accepts; the format select has to match the file, since that string is what chooses the renderer on the device, and the preview under it renders Lottie (`lottie-web`), plays MP4 and names SVGA as app-only. The tap target is a verb plus a value — nothing, one of the four internal screens, a room picked from `api.listRooms({status:'ACTIVE'})` (a retired room still shows as an option so an old campaign is editable, and the row is then flagged red because the read path hides it), or an external `https://` link — and switching the verb clears the value rather than carrying a room id into a link box. Retiring is the inline switch, which writes `isActive` and then re-reads the public list to prove the banner actually left the phone; the delete dialog prints the counts the delete destroys and says so in those terms. `key` is immutable. Reading needs `dashboard:read`, writing `config:manage`, uploading `media:manage` |
| `/emoji`        | Chat emoji catalogue the room picker reads: search by key, name or code, then create/edit/delete a row (key, label, art URL or Upload, order). The card header prints how many codes `GET /api/emoji` currently publishes and the `codePattern` clients scan messages with, so a saved row is provably live on a phone. `key` is immutable after creation — sent messages are spelled after it — and deleting one leaves those messages as text instead of rewriting them. Reading needs `room:read`, writing `config:manage`, uploading `media:manage` |
| `/ranks`        | The earned level ladder (`rank_levels`, migration `0017`): every rung with its floor in XP, name, accent colour, badge art and how many members sit on it. A card at the top prints the two rates the server actually awards at — 1 XP per diamond spent, 0.5 per R-coin earned — and the row list compares each rung against `GET /api/ranks`, so a saved rung is provably published to phones rather than only written to the database. `level` cannot be edited (it is the key accounts sit on): renumbering means adding the new rung and deleting the old. Client-side checks mirror the server's — floors must strictly increase, level 0 must cost 0, `#rrggbb` only, art must be `/…` or `https://…` — and the badge preview loads from the same URL a phone uses, so missing art breaks here first. Deleting a rung moves its members down by XP, and level 0 refuses. Reading needs `user:read`, writing `config:manage`, uploading `media:manage`. Experience itself is corrected per account from **Users → Level**, which posts a signed delta with a reason and records `USER_XP_ADJUST` in the audit log |
| `/decor`        | Room decoration CRUD — the themes a host can pick and the Lottie loops a room plays. Themes: name, slug, accent colour, wallpaper (Upload or a CDN path by hand), default switch, room count, live preview. Effects: `AMBIENT`/`WELCOME` tabs, key, name, URL, order, and a "published" badge that compares the row against `GET /api/rooms/themes` so an operator sees the catalogue a phone will actually read. Plus one dropdown per room category choosing its ambient loop. Reading needs `room:read`, writing `config:manage`, uploading `media:manage`. A theme in use by rooms can be retired (those rooms fall back to the default art); an effect still mapped to a category is refused with `effect_in_use`. **Entrance rides** (`profile_rides`, migration `0026`) are the fourth sellable catalogue on this screen: the full-screen cinematic a room plays while a member joins, listed with the same price/VIP/recommended badges as a frame plus its renderer and its screen budget — a `durationMs` of `0` reads as "asset length", never "0 ms". The form takes key (immutable, so an update never sends it), name, file (Upload as the `RIDE` media kind or a CDN path by hand), renderer (`LOTTIE`/`SVGA`/`MP4`), budget in ms with the 0 / 250–30000 rule spelled out inline, order, price, on-sale switch, period (blank = permanent), VIP level and recommended. Client checks mirror the server's refusals (`ride_fields_missing`, `ride_exists`, `ride_format_invalid`, `ride_duration_invalid`, `ride_price_required`, `ride_price_without_sale`) and the server's own sentence is still shown when it says no. Each card has a "who holds this" list and a delete confirmation that reports how many members keep their receipt and stop playing it |
| `/finance`      | The double-entry book (`fin_journal_entries` / `fin_journal_lines`, `fin_accounts`), in four tabs. **Automated tie-outs** each print a count of the rows that violate their own rule, so a breach is queryable rather than arguable, and a pass says only that these tie-outs hold for this window. **Trial balance** sums every debit and credit line per account and flags the pair if they differ. **Chart of accounts** and **Journal** are paged reads of the same book. Real money is always minor units and every figure is printed with its currency code; `Export report` downloads the tie-outs as CSV. Needs `finance:read` |
| `/accounts`     | Purpose accounts (`fin_accounts` projected by `purpose_account_balances`, migration `0029`) — every balance the platform owes or holds, read from the table that owns it and labelled as such in the "Read from" column (`users.diamond_balance`, `users.r_coin_balance`, `fin_journal_lines`). **The book**: search, category / owner-kind / status / currency filters, an "only with a position" switch and pagination; balances, holds and statement amounts are all rendered through `formatUnitAmount`, so `dmn` and `rcn` print as whole coins and `pkr` as minor units — a number without its unit is a number a partner disputes. Opening a row gives the six projection cells, a lifetime sentence (in − out + opening against the balance it claims), the paged statement with a date window and CSV/Excel export, the holds on that account with a **Release** button, and the two writes: place a hold (kind, amount in that account's own unit, reason ≥ 8 chars) and change status. Both send an idempotency key generated per click, so a retry after a lost response replays instead of freezing the same money twice, and after either write the drawer re-reads the account rather than reusing what it had displayed. A hold is carved out of `available` rather than off it, so the drawer prints `available − frozen` as what a new hold could still take — the same figure the server uses when it answers `freeze_exceeds_available`. **Reconciliation** lists the tie-out findings with their severity, account and amount; **Open holds** spans the whole book and links each hold to the account behind it. This screen never edits a balance — that route stays on `/users`. Reading needs `account:read`, both writes need `account:manage`; an `OPERATIONS_ADMIN` token gets the same book with the actions replaced by a note saying which permission is missing, and the server refuses the write anyway (`403 permission_denied`). Exported workbooks are validated by `backend/scripts/account-e2e.cjs`, which inflates every entry and recomputes its CRC |

## Environment

| Variable          | Default                 | Description                        |
| ----------------- | ----------------------- | ---------------------------------- |
| `VITE_API_BASE_URL` | `http://localhost:4000` | Base URL of the Voiza backend API |
