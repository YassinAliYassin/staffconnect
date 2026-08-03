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
| `DATA_DIR` | `./data` | Where the SQLite DB lives |

## API

- `GET /api/health` — liveness
- `POST /api/bookings` — create a booking; returns the row + composed `waLink`
- `GET /api/admin/bookings?status=` — list (requires `x-admin-code` header)
- `PATCH /api/admin/bookings/:ref` — update status (requires header)

## Deploy

This app has a backend, so it is **not** a static GitHub-Pages deploy anymore.
Run it as a long-lived service, e.g. with pm2:

```bash
pm2 start server.js --name staffconnect
# set ADMIN_CODE (and PORT / WA_NUMBER) in the environment or .env first
```

or a systemd user unit (mirrors the notes-ai pattern). If you need it public, put
it behind Tailscale Funnel or a reverse proxy with HTTPS.

## Branding

- Brand green: `#A4C71D`
- WhatsApp CTA green: `#25D366`
- Built for Fresh People · Powered by Solid Solutions AI
