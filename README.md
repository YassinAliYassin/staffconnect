# StaffConnect

A take.app-style WhatsApp staff-booking app for Fresh People
(Premier Talent & Events Staffing, Johannesburg / Randburg, Gauteng).

Clients pick their staff from a structured role catalog, step through a booking
wizard (date, times, headcount, venue, contact), and the app saves the booking to
a backend and opens WhatsApp with everything pre-filled — fewer mistakes, faster
deals. Includes an admin dashboard to view and manage all bookings.

## Features

- **Multi-step booking wizard** — role selection → event date/times/headcount →
  venue & contact → review. Composes a structured WhatsApp message with labelled
  fields and a booking reference.
- **Real backend** — Node/Express + SQLite stores every booking (`data/bookings.db`).
- **Admin dashboard** (`/admin`) — password-gated view of all bookings, stats,
  per-booking detail with the pre-filled WhatsApp message, and status updates
  (new → quoted → confirmed → cancelled).
- **WhatsApp deep-link** — every booking produces a `wa.me` link with the message
  pre-filled; staff can reply with a quote and confirm.

## Stack

- Node.js + Express (API + static serving)
- SQLite via `better-sqlite3` (zero-config, single file)
- Frontend: vanilla HTML + Tailwind CDN + Inter font (no build step)

## Quick start (local)

```bash
npm install
npm start            # listens on http://localhost:5184
# open http://localhost:5184  (booking wizard)
# open http://localhost:5184/admin  (dashboard, default code "fresh-admin")
```

Configure via `.env` (see `.env.example`):

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `5184` | HTTP port |
| `WA_NUMBER` | `27672961272` | WhatsApp number for the wa.me deep-links |
| `ADMIN_CODE` | `fresh-admin` | Admin dashboard passcode — set a strong one in prod |
| `DATA_DIR` | `./data` | Where the SQLite fallback DB lives |
| `SUPABASE_URL` | — | Supabase project URL (e.g. https://xxx.supabase.co) |
| `SUPABASE_SECRET_KEY` | — | Supabase secret/service key (server-side) |

## Storage: SQLite (default) or Supabase

StaffConnect stores bookings in **Supabase Postgres when configured**, and
**automatically falls back to local SQLite** if the Supabase `bookings` table
isn't provisioned yet — so the app never goes down mid-migration.

- Set `SUPABASE_URL` + `SUPABASE_SECRET_KEY` in `.env` to enable Supabase.
- The server checks at startup whether `public.bookings` exists; if yes it uses
  Supabase, if not it falls back to SQLite (and logs which backend it chose).
- `GET /api/health` reports `"storage":"supabase"` or `"storage":"sqlite"`.
- To finish the migration, apply `supabase/migrations/0001_create_bookings.sql`
  (CREATE TABLE + RLS + index) in the Supabase SQL editor. Once applied, restart
  the service and it switches to Supabase automatically.

## API

- `GET /api/health` — liveness
- `POST /api/bookings` — create a booking; returns the row + composed `waLink`
- `GET /api/admin/bookings?status=` — list (requires `x-admin-code` header)
- `PATCH /api/admin/bookings/:ref` — update status (requires header)

## Deploy

This app has a backend, so it is **not** a static GitHub-Pages deploy anymore.
It runs as a persistent pm2 service with boot persistence (systemd).

```bash
# current production instance (already deployed):
pm2 start server.js --name staffconnect
pm2 save
pm2 startup systemd -u yassin --hp /home/yassin   # one-time, sudo, for boot persistence

# config in .env: PORT=5184, WA_NUMBER=27672961272, ADMIN_CODE=<strong passcode>
```

Expose it publicly via Tailscale Funnel or a reverse proxy with HTTPS when ready.

## Branding

- Brand green: `#A4C71D`
- WhatsApp CTA green: `#25D366`
- Built for Fresh People · Powered by Solid Solutions AI
