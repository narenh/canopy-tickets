# Canopy Tickets

A small tool for tracking AMC seat blocks you've bought so friends can
claim seats. One URL, one login form, two possible passwords:

- Enter **`ADMIN_PASSWORD`** and you land in the editor — create
  showtimes, pick which seats you actually bought on a real AMC seat map,
  assign seats to specific friends, and mark them paid.
- Enter the **friend password** (set from the editor, not an env var — see
  below) and you land on the reservation page — the one you hand out to
  friends. They see upcoming showtimes (soonest first) and how many spots
  are still open, pick a specific open seat off a seat map, claim it by
  name, and get a one-tap Venmo and/or Cash App link pre-filled with the
  price (whichever you've set up — see "Payment handles" below). You still
  confirm the payment actually landed manually on the admin side.

There's nothing "admin-flavored" about the URL or login page — the same
link works for you and for friends, it just goes different places
depending on which password you type. That's the whole point of it being
one URL: whatever domain you point at this app is the only link you ever
need to share.

Everything is persisted server-side as a JSON file (see "Deploying with
Docker" below for making that survive restarts/redeploys).

## How it works

- `server.js` — Express app: one login endpoint that checks a password
  against `ADMIN_PASSWORD` and the current friend password and issues
  whichever session matches (they're still two fully independent cookies
  underneath), plus a JSON REST API for showtimes. `GET /` looks at which
  session (if either) is active and serves the editor, the reservation
  page, or the login form accordingly -- that's the whole "one URL" trick.
- `lib/store.js` — persistence: showtimes are stored as one JSON file on
  disk (`data/showtimes.json`), written atomically. No database needed at
  this scale. `claimSeat` does the friend-facing claim atomically (read,
  check, write inside one lock) so two people tapping the same seat at the
  same instant can't both win it -- verified with 10 concurrent claims
  against a single open seat (1 winner, 9 correctly rejected). Every
  showtime carries a `screen` (which auditorium/seat-map it uses, see
  `public/seat-layout.js`) -- a showtime saved before this field existed
  just reads back as IMAX at Metreon (`"amc-metreon-16"`) every time,
  forever, via a fallback in `server.js`, so nothing needed a one-time
  migration.
- `lib/sharedPassword.js` — persistence for the friend password (see
  below). No password saved means friend login is off.
- `lib/textSetting.js` — generic version of the same idea:
  `createTextSettingStore(name)` gives each named setting its own file in
  `DATA_DIR`. Used for the Venmo and Cash App handles (see "Payment
  handles" below) — `sharedPassword.js` predates this and could arguably
  be rewritten on top of it, left alone since it already works.
- `lib/auth.js` — one small password-session helper, instantiated twice
  (`canopy_admin` and `canopy_shared` cookies) so admin and friend logins
  never overlap.
- `lib/seats.js` — normalizes a stored seat entry (handles the legacy
  plain-string format from before per-seat names/paid existed) into
  `{status: 'occupied'}` or `{status: 'assigned', name, paid}`.
- `lib/uploadedImage.js` — persistence for admin-uploaded site images (the
  link-preview image, the logo): `createImageStore(name)` gives each one
  its own file in `DATA_DIR`, same durability story as `showtimes.json`.
- `public/seat-layout.js` — `SEAT_LAYOUTS`, keyed by a theater+auditorium
  id (e.g. `"amc-metreon-16"`) rather than a bare auditorium number,
  since a number alone only means something within one specific theater
  and more theaters can get added later. Each entry carries its own
  `theater`/`auditorium`/`name` fields plus the row/seat geometry (how
  many rows, seats per row, wheelchair/companion icon positions, and an
  optional `gapAfter` on a row to add breathing room -- no divider line
  -- before a stadium section starts, used for Dolby's three flat front
  rows). `getSeatLayout(screenId)` looks one up, falling back to IMAX
  for an unknown id. The one place both `admin.html` and `public.html`
  get a layout from, so they always agree on which seat IDs exist for a
  given showtime. Currently approximate, not pulled from AMC's real
  charts -- safe to correct later since a seat's identity is just its ID
  string (e.g. `"F14"`); just don't rename/renumber a seat that's
  already assigned to someone (or a screen's key, one level up). Add a
  new auditorium by adding an entry here -- the admin editor's Screen
  dropdown is built from this file at load time, grouped by theater,
  so there's nothing else to keep in sync by hand.
- `views/admin.html` — the showtime list + seat-map editor, plus (below
  the showtimes list) the friend-password field, the payment handles
  fields, and the logo/link-preview uploaders. Only served to
  authenticated admin requests.
- `views/public.html` — the friend-facing reservation page. Only served to
  authenticated shared requests. Shows each showtime's remaining spot count
  (green if any are open, red if sold out), who's already claimed a seat,
  a seat map to pick a specific open one from (hover a seat for who it's
  assigned to), and a pre-filled Venmo and/or Cash App pay button right
  after claiming for whichever handle(s) are set (see "Payment handles"
  below); doesn't expose which seats are sold-out-but-not-mine vs. simply
  not part of the block.
- `public/login.html` — the one password screen (no "admin" language --
  it doesn't know or care which password you're about to type).

## The friend password

Unlike `ADMIN_PASSWORD`, the friend/shared password is **not** an
environment variable. It's set (and can be changed any time — e.g. a
fresh password per movie, so a new round of tickets gets a new invite)
from the "Friend Password" field in the admin editor, below the showtimes
list. It's shown back to you in plain text there, on purpose — the whole
point is handing it to friends (text it, etc.), so there's nothing to
hide it from you.

If no friend password has ever been set, friend login is simply off —
nobody can reach the reservation page until you set one. Saving an empty
field clears it (turning friend access back off), which is a quick way to
close reservations once a movie's roster is final.

One limitation worth knowing: changing or clearing the password doesn't
force-log-out friends who are already signed in (sessions are independent
of the password's current value, same as `ADMIN_PASSWORD` changes don't
log out an existing admin session). Rotating the password controls new
access, not already-granted access.

## Payment handles

Like the friend password, Venmo and Cash App handles are **not**
environment variables (there used to be a `HOST_VENMO` env var for this —
it's gone; set it from the editor now instead). Set either, both, or
neither from the "Payment Handles" field in the admin editor, below the
showtimes list — a friend only sees a pay button on the reservation page
for the one(s) you've actually filled in. Store the handle without the
leading `@` (Venmo) or `$` (Cash App); it gets added back automatically
when building the pay link.

Cash App's pay links only support pre-filling an amount, not a note —
Venmo's link includes a note identifying the movie/date/seat, Cash App's
doesn't, since there's no query param for that on Cash App's side.

## Link-preview image & logo

The editor (below the showtimes list) has two image uploads, admin only:

- **Site Logo** — shown on the login screen and at the top of the editor
  and reservation pages. Assumes a PNG, ideally with a transparent
  background.
- **Link Preview Image** — becomes the image shown when the site's link is
  shared in iMessage, Facebook, Instagram, etc. Title/description for that
  preview are fixed as "Canopy Tickets" / "Reserve your seats here" and
  aren't editable from the UI (change them in `buildOgTags()` in
  `server.js` if you ever want different copy).

A few things worth knowing about how these actually work:

- Both live in `DATA_DIR`, same as `showtimes.json` — they need the same
  persistent volume (see below) to survive a redeploy.
- The Open Graph/Twitter meta tags (for the link-preview image) only
  matter on the page an unauthenticated request sees, because crawlers
  never carry your login cookie. In practice that's always the login
  page, and that's exactly where the tags are (also mirrored on the
  editor/reservation pages for consistency, but that's cosmetic). The
  logo works the same way -- injected server-side into whichever page a
  request resolves to.
- **On caching**: you already know Meta/Apple cache scraped previews per
  URL. There's no way to force that cache to expire from this app's side
  — but both image URLs include `?v=<upload time>`, which changes every
  time you upload a new image. A changed URL is what actually gets a
  platform (or a browser) to fetch fresh instead of reusing what it
  cached for the old URL. If Facebook specifically still shows something
  stale, their [Sharing Debugger](https://developers.facebook.com/tools/debug/)
  lets you force an immediate re-scrape by URL.

## Running locally

```bash
npm install
ADMIN_PASSWORD=whatever npm start
```

Then visit `http://localhost:3000`, enter `ADMIN_PASSWORD` to reach the
editor, and set a friend password (and, optionally, Venmo/Cash App
handles) from there (the reservation page has nothing to log into until
you set a friend password). If you don't set `ADMIN_PASSWORD`, the server
generates a random one and prints it to the console on startup.

## Deploying with Docker

This repo ships a `Dockerfile` and a `docker-compose.yml`, so it runs
anywhere Docker does — a VPS, a NAS, a spare machine on your network, or a
PaaS like Coolify (see the Coolify-specific section below, which is built
on this same `Dockerfile`).

### docker compose (recommended)

```bash
cp .env.example .env
# edit .env -- at minimum set ADMIN_PASSWORD, ideally SESSION_SECRET too
docker compose up -d --build
```

Visit `http://localhost:3000`, log in with `ADMIN_PASSWORD`, and set a
friend password from the editor (see "The friend password" above). The
`canopy-data` named volume declared in `docker-compose.yml` is what
persists `showtimes.json`, the friend password, and uploaded images across
restarts and rebuilds — don't remove it (`docker compose down -v` would
wipe it).

To pick up new code later: `docker compose up -d --build` again. The
volume is untouched by this.

### Plain `docker build` / `docker run`

If you'd rather not use compose:

```bash
docker build -t canopy-tickets .
docker run -d \
  --name canopy-tickets \
  -p 3000:3000 \
  -e ADMIN_PASSWORD=change-me \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -v canopy-data:/app/data \
  canopy-tickets
```

Same rule as above: `-v canopy-data:/app/data` (a named volume, or a bind
mount to a real directory on the host) is what makes data survive a
container restart or recreate. Skip it and every `docker run` starts from
an empty slate.

Either way, put this behind whatever reverse proxy/TLS setup you'd
normally use to get a real domain in front of it (Caddy, nginx, Traefik,
Coolify, etc.) — the app itself just listens on plain HTTP on `PORT`.

## Deploying on Coolify

Coolify is one specific way to run the `Dockerfile` above, with a managed
reverse proxy/TLS and a UI for volumes and env vars, which is why it gets
its own walkthrough. In Coolify's resource settings, set the build pack to
**Dockerfile** (or "Application"/"Docker" depending on your Coolify
version) — it's currently defaulted to "static," which would serve this
as static files instead of actually running the Node server.

1. In the Coolify resource settings, change the build pack from **Static**
   to **Dockerfile**.
2. Set environment variables:
   - `ADMIN_PASSWORD` — your password for the editor. Keep this one to
     yourself. (There's no env var for the friend password, or for Venmo/
     Cash App — set those from the editor after deploying; see "The
     friend password" and "Payment handles" above.)
   - `SESSION_SECRET` — a long random string (e.g. `openssl rand -hex 32`).
     Recommended, not strictly required: if unset, one is derived
     deterministically from `ADMIN_PASSWORD` instead of being randomized,
     so sessions still survive restarts/redeploys/extra replicas either
     way. Set it explicitly so that changing `ADMIN_PASSWORD` later
     doesn't also silently log everyone out.
3. Add a **persistent volume** — this is where `showtimes.json`, the
   friend password, the Venmo/Cash App handles, and the uploaded
   logo/link-preview images all live.
   Without it, every redeploy gives the container a brand-new, empty
   filesystem and all of that is gone. The `Dockerfile`'s `VOLUME` line
   does *not* do this by itself — it just marks the path as
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
   domain you actually want to hand out is bound as the app's URL — since
   there's only one URL now (no separate `/reserve`), that domain is the
   single link for both you and your friends.
6. Deploy. Visit the app URL, enter your `ADMIN_PASSWORD` to get to the
   editor, set a friend password from there, and start adding showtimes.

### Confirming persistence actually works

On every boot the server logs how many showtimes it found on disk, e.g.:

```
[canopy-tickets] DATA_DIR=/app/data (3 showtime(s) found on disk at startup)
```

Check this in Coolify's deployment logs right after a redeploy. If it says
`0` but you know you'd already added showtimes, the volume above isn't
actually attached (Storages tab is empty, wrong destination path, or it
was added but the resource hasn't been redeployed since) — fix that and
redeploy again; nothing else changes. The same volume is also what makes
the friend password, payment handles, and uploaded images survive a
redeploy, so this check covers all of it.
