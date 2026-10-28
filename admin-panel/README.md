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
needed. To build against a different API base baked into the bundle:

```bash
docker build --build-arg VITE_API_BASE_URL=https://api.example.com -t voiza-admin .
```

## Signing in

The panel authenticates against `POST /api/admin/login` (username + password, JWT
bearer afterwards). On a fresh stack the backend seeds a super-admin from
`ADMIN_USERNAME` / `ADMIN_PASSWORD` — with the defaults shipped in the root
`.env.example` that means username **`admin`**, password **`voiza-admin`**. Rotate
them (and `JWT_SECRET`) before exposing the panel. The alternative bootstrap path is
`POST /api/auth/verify-otp` with `ADMIN_BOOTSTRAP_PHONE` + `ADMIN_BOOTSTRAP_OTP`,
which returns an admin-scoped token for the same operator.

## Feature map

| Route           | What it does                                                                     |
| --------------- | -------------------------------------------------------------------------------- |
| `/`             | Overview: KPI cards, 7-day diamonds/rooms SVG trend chart, live rooms shortlist   |
| `/users`        | Search/filter/paginate users, adjust diamond/R-coin balances, ban/unban           |
| `/rooms`        | Room monitor: seat policy card (default speaker seats and the largest room a host may pick, `config:manage` to write, `room:read` to view), 5s polling, force-close, seat/audience drawer with disconnect |
| `/rooms/:id`    | Ops console: live seats/chat/listeners over Socket.IO, mute/lock/disconnect/ban, moderator announcement, host warning and the theme picker (`lottie-web` previews the generated animations) |
| `/gifts`        | Virtual store CRUD with live validation, inline active toggle, a ticker/full-screen effect tier selector, a Lottie preview of the gift overlay and an Upload button on each art field (`media:manage`; the URL box still accepts a CDN path by hand) |
| `/withdrawals`  | R-coin cash-out queue: approve/reject with note                                   |
| `/media`        | Media library: upload gift icons, Lottie gift scenes, gift sounds, room wallpapers, room effects and rank badges (base64 over `POST /api/admin/uploads`), then list, preview, copy the stored path or delete a file. Needs `media:manage`; a file a catalogue row still points at cannot be deleted |
| `/emoji`        | Chat emoji catalogue the room picker reads: search by key, name or code, then create/edit/delete a row (key, label, art URL or Upload, order). The card header prints how many codes `GET /api/emoji` currently publishes and the `codePattern` clients scan messages with, so a saved row is provably live on a phone. `key` is immutable after creation — sent messages are spelled after it — and deleting one leaves those messages as text instead of rewriting them. Reading needs `room:read`, writing `config:manage`, uploading `media:manage` |
| `/ranks`        | The earned level ladder (`rank_levels`, migration `0017`): every rung with its floor in XP, name, accent colour, badge art and how many members sit on it. A card at the top prints the two rates the server actually awards at — 1 XP per diamond spent, 0.5 per R-coin earned — and the row list compares each rung against `GET /api/ranks`, so a saved rung is provably published to phones rather than only written to the database. `level` cannot be edited (it is the key accounts sit on): renumbering means adding the new rung and deleting the old. Client-side checks mirror the server's — floors must strictly increase, level 0 must cost 0, `#rrggbb` only, art must be `/…` or `https://…` — and the badge preview loads from the same URL a phone uses, so missing art breaks here first. Deleting a rung moves its members down by XP, and level 0 refuses. Reading needs `user:read`, writing `config:manage`, uploading `media:manage`. Experience itself is corrected per account from **Users → Level**, which posts a signed delta with a reason and records `USER_XP_ADJUST` in the audit log |
| `/decor`        | Room decoration CRUD — the themes a host can pick and the Lottie loops a room plays. Themes: name, slug, accent colour, wallpaper (Upload or a CDN path by hand), default switch, room count, live preview. Effects: `AMBIENT`/`WELCOME` tabs, key, name, URL, order, and a "published" badge that compares the row against `GET /api/rooms/themes` so an operator sees the catalogue a phone will actually read. Plus one dropdown per room category choosing its ambient loop. Reading needs `room:read`, writing `config:manage`, uploading `media:manage`. A theme in use by rooms can be retired (those rooms fall back to the default art); an effect still mapped to a category is refused with `effect_in_use` |

## Environment

| Variable          | Default                 | Description                        |
| ----------------- | ----------------------- | ---------------------------------- |
| `VITE_API_BASE_URL` | `http://localhost:4000` | Base URL of the Voiza backend API |
