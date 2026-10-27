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
| `/gifts`        | Virtual store CRUD with live validation, inline active toggle, a ticker/full-screen effect tier selector and a Lottie preview of the gift overlay |
| `/withdrawals`  | R-coin cash-out queue: approve/reject with note                                   |

## Environment

| Variable          | Default                 | Description                        |
| ----------------- | ----------------------- | ---------------------------------- |
| `VITE_API_BASE_URL` | `http://localhost:4000` | Base URL of the Voiza backend API |
