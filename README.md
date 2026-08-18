# Canopy Tickets

A small tool for tracking AMC seat blocks you've bought so friends can
claim seats. One URL, one login form, two possible passwords:

- Enter **`ADMIN_PASSWORD`** and you land in the editor — create
  showtimes, pick which seats you actually bought on a real AMC seat map,
  assign seats to specific friends, and mark them paid.
- Enter **`SHARED_PASSWORD`** and you land on the reservation page — the
  one you hand out to friends. They see upcoming showtimes (soonest
  first) and how many spots are still open, pick a specific open seat off
  a seat map, claim it by name, and get a one-tap Venmo link pre-filled
  with the price. You still confirm the payment actually landed manually
  on the admin side.

There's nothing "admin-flavored" about the URL or login page — the same
link works for you and for friends, it just goes different places
depending on which password you type. That's the whole point of it being
one URL: `tix.canopysf.com` (or whatever domain you point at this app) is
the only link you ever need to share.

Everything is persisted server-side as a JSON file (see "Deploying on
Coolify" below for making that survive redeploys).

## How it works

- `server.js` — Express app: one login endpoint that checks a password
  against both `ADMIN_PASSWORD` and `SHARED_PASSWORD` and issues whichever
  session matches (they're still two fully independent cookies
  underneath), plus a JSON REST API for showtimes. `GET /` looks at which
  session (if either) is active and serves the editor, the reservation
  page, or the login form accordingly -- that's the whole "one URL" trick.
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
  a seat map to pick a specific open one from, and (if `HOST_VENMO` is
  set) a pre-filled Venmo pay link right after claiming; doesn't expose
  which seats are sold-out-but-not-mine vs. simply not part of the block.
- `public/login.html` — the one password screen (no "admin" language --
  it doesn't know or care which password you're about to type).

## Running locally

```bash
npm install
ADMIN_PASSWORD=whatever SHARED_PASSWORD=whatever2 HOST_VENMO=yourvenmo npm start
```

Then visit `http://localhost:3000` and enter either password to see that
side. If you don't set `ADMIN_PASSWORD`/`SHARED_PASSWORD`, the server
generates random ones and prints them to the console on startup.
`HOST_VENMO` is optional locally (the Venmo link just won't appear).

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
   - `SHARED_PASSWORD` — the password you give friends.
   - `HOST_VENMO` — your Venmo username (no `@`), so the reservation page
     can show a one-tap pay link. Optional; the link is just skipped if
     unset.
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
5. In Coolify's **Domains** settings for this resource, make sure the
   domain you actually want to hand out (e.g. `tix.canopysf.com`) is
   bound as the app's URL — since there's only one URL now (no separate
   `/reserve`), that domain is the single link for both you and your
   friends.
6. Deploy. Visit the app URL, enter your `ADMIN_PASSWORD` to get to the
   editor, and start adding showtimes.

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
