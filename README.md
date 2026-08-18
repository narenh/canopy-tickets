# Canopy Tickets

A small tool for tracking AMC seat blocks you've bought so friends can
claim seats. Two sides, two separate passwords:

- **Admin** (`/`, gated by `ADMIN_PASSWORD`) — create showtimes, pick which
  seats you actually bought on a real AMC seat map, assign seats to
  specific friends, and mark them paid.
- **Reserve** (`/reserve`, gated by `SHARED_PASSWORD`) — the page you hand
  out to friends. They see upcoming showtimes and how many spots are still
  open, pick a specific open seat off a seat map, and claim it by name. You
  still confirm payment (Venmo, etc.) manually on the admin side.

Everything is persisted server-side as a JSON file (see "Deploying on
Coolify" below for making that survive redeploys).

## How it works

- `server.js` — Express app: two independent password-gated sessions
  (admin + shared) and a JSON REST API for showtimes.
- `lib/store.js` — persistence: showtimes are stored as one JSON file on
  disk (`data/showtimes.json`), written atomically. No database needed at
  this scale. `claimSeat` does the friend-facing claim atomically (read,
  check, write inside one lock) so two people tapping the same seat at the
  same instant can't both win it -- verified with 10 concurrent claims
  against a single open seat (1 winner, 9 correctly rejected).
- `lib/auth.js` — one small password-session helper, instantiated twice
  (`canopy_admin` and `canopy_shared` cookies) so admin and friend logins
  never overlap.
- `lib/seats.js` — normalizes a stored seat entry (handles the legacy
  plain-string format from before per-seat names/paid existed) into
  `{status: 'occupied'}` or `{status: 'assigned', name, paid}`.
- `public/seat-layout.js` — the auditorium's row/seat geometry (which rows
  exist, how many seats, where the wheelchair/companion icons go). The one
  place both `admin.html` and `public.html` get it from, so they always
  agree on which seat IDs exist. Currently approximate, not pulled from
  AMC's real layout -- safe to correct later since a seat's identity is
  just its ID string (e.g. `"F14"`); just don't rename/renumber a seat
  that's already assigned to someone. See the TODO at the top of that file
  for adding a second screen (e.g. Dolby) later.
- `views/admin.html` — the showtime list + seat-map editor. Only served to
  authenticated admin requests.
- `views/public.html` — the friend-facing reservation page. Only served to
  authenticated shared requests. Shows each showtime's remaining spot count
  (green if any are open, red if sold out), who's already claimed a seat,
  and a seat map to pick a specific open one from; doesn't expose which
  seats are sold-out-but-not-mine vs. simply not part of the block.
- `public/login.html`, `public/shared-login.html` — the two password
  screens.

## Running locally

```bash
npm install
ADMIN_PASSWORD=whatever SHARED_PASSWORD=whatever2 npm start
```

Then visit `http://localhost:3000` for the admin side, or
`http://localhost:3000/reserve` for the friend-facing side. If you don't
set `ADMIN_PASSWORD`/`SHARED_PASSWORD`, the server generates random ones
and prints them to the console on startup.

## Deploying on Coolify

This repo is currently set to Coolify's "static" build pack — switch it to
**Dockerfile** (or "Application"/"Docker" depending on your Coolify
version) so it actually runs the Node server instead of being served as
static files. The included `Dockerfile` builds and runs the app directly.

1. In the Coolify resource settings, change the build pack from **Static**
   to **Dockerfile**.
2. Set environment variables:
   - `ADMIN_PASSWORD` — your password for the editor. Keep this one to
     yourself.
   - `SHARED_PASSWORD` — the password you give friends for `/reserve`.
   - `SESSION_SECRET` — a long random string (e.g. `openssl rand -hex 32`),
     so logins survive restarts/redeploys.
3. Add a **persistent volume** — this is where `showtimes.json` lives.
   Without it, every redeploy gives the container a brand-new, empty
   filesystem and your showtimes are gone. The `Dockerfile`'s `VOLUME`
   line does *not* do this by itself — it just marks the path as
   volume-worthy; Coolify still needs to be told to actually attach a
   persistent volume there. In the Coolify UI, on this resource, open the
   **Storages** tab and add an entry with:
   - **Destination Path**: `/app/data` (must match `DATA_DIR`, default
     `/app/data` — leave `DATA_DIR` unset unless you changed this)
   - Name: anything (e.g. `canopy-data`)
   Save it, then redeploy so the running container picks it up.
4. Coolify will set `PORT` automatically; the app listens on whatever
   `PORT` is provided (defaulting to `3000`).
5. Deploy. Visit the app URL, enter your `ADMIN_PASSWORD`, and start adding
   showtimes.

### Confirming persistence actually works

On every boot the server logs how many showtimes it found on disk, e.g.:

```
[canopy-tickets] DATA_DIR=/app/data (3 showtime(s) found on disk at startup)
```

Check this in Coolify's deployment logs right after a redeploy. If it says
`0` but you know you'd already added showtimes, the volume above isn't
actually attached (Storages tab is empty, wrong destination path, or it
was added but the resource hasn't been redeployed since) — fix that and
redeploy again; nothing else changes.
