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
- Friends can come back any time and tap their reserved seat to build a
  **concession order** off the AMC menu, which ships built in and is
  editable from the editor — see "Concessions" below. The
  pay link then covers the ticket and the snacks together, and the editor
  gives you a summed shopping list to take to the counter.

There's nothing "admin-flavored" about the URL or login page — the same
link works for you and for friends, it just goes different places
depending on which password you type. That's the whole point of it being
one URL: whatever domain you point at this app is the only link you ever
need to share.

**Seat maps currently only cover AMC Metreon (San Francisco) — IMAX
(Auditorium 16) and Dolby Cinema (Auditorium 13).** Other screens/theaters
are coming soon; see `public/seat-layout.js` below for how a new one gets
added.

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
  `public/seat-layout.js`), defaulting to IMAX at Metreon
  (`"amc-metreon-16"`) via a fallback in `server.js` if unset.
  `setSeatConcessions` does the same read-check-write dance for a friend
  editing a reserved seat's concession order.
- `lib/sharedPassword.js` — persistence for the friend password (see
  below). No password saved means friend login is off.
- `lib/concessionMenu.js` — persistence for the concession menu: one
  global list of `{id, name, price, note, optionGroup}` plus the option
  groups items choose from (see "Concessions" below for why it isn't per
  showtime). Ships with the AMC menu hardcoded in `DEFAULT_ITEMS` /
  `DEFAULT_OPTION_GROUPS`, which apply while no menu has been saved; the
  host's saved menu replaces them, and `reset()` deletes it to come back.
  An item keeps its id across renames and reprices, so carts referencing
  it stay lined up with the menu.
- `lib/textSetting.js` — generic persistence for a single admin-settable
  string setting: `createTextSettingStore(name)` gives each named setting
  its own file in `DATA_DIR`. Used for the Venmo and Cash App handles
  (see "Payment handles" below).
- `lib/auth.js` — one small password-session helper, instantiated twice
  (`canopy_admin` and `canopy_shared` cookies) so admin and friend logins
  never overlap.
- `lib/seats.js` — normalizes a stored seat entry into
  `{status: 'occupied'}` or `{status: 'assigned', name, paid, concessions}`,
  where `concessions` is that seat's cart (`{itemId, name, price, qty,
  note?, options?}` per line, `options` holding one pick per unit
  ordered). A seat saved before concessions existed just normalizes to an
  empty cart, so there's no migration step.
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
  fields, the concessions menu editor, and the logo/link-preview
  uploaders. The editor also shows what friends have ordered for the
  showtime you're editing, per seat plus a summed shopping list. Only
  served to authenticated admin requests.
- `views/public.html` — the friend-facing reservation page. Only served to
  authenticated shared requests. Shows each showtime's remaining spot count
  (green if any are open, red if sold out), who's already claimed a seat,
  a seat map to pick a specific open one from (hover a seat for who it's
  assigned to), and a pre-filled Venmo and/or Cash App pay button right
  after claiming for whichever handle(s) are set (see "Payment handles"
  below); doesn't expose which seats are sold-out-but-not-mine vs. simply
  not part of the block. Each reserved seat on the list is also the way
  into that seat's concession cart (see "Concessions" below).
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

## Concessions

Friends can come back to the reservation page any time after reserving a
seat and build a concession order for it. On the list, every reserved
seat is its own tappable row showing what's on it so far ("🍿 Chicken
Tenders ×2 (BBQ Sauce, Icing Cup), Skittles — $29.97", or "No concessions
yet"); tapping it opens that seat's cart, where every menu item has a −/+
stepper, a dropdown per unit for anything that comes with a choice, and
an optional per-item note ("no ice", "extra butter"). The order is saved
against the seat, so it's there when they come back on another device or
another day.

**The menu ships filled in.** AMC's own list — drinks, the food page, and
candy as individual items — is hardcoded in `lib/concessionMenu.js` and
is what friends see on a fresh install, so there's nothing to set up
before the first order. It's fully editable from the "Concessions Menu"
panel in the admin editor: rename, reprice, add or remove any row and
save, and your version takes over from the built-ins (a "Restore AMC
menu" button appears once it has, and puts them back). It's one menu
shared by every showtime, not one per showtime — this is one person's
friend group at, in practice, one theater.

**A price is what a friend actually owes**, with nothing added on top.
You buy the whole order on your own AMC Stubs account, which waives the
$1.99-per-order service fee AMC's app charges and passes your Stubs
discount on to everyone — so there's no fee, surcharge or markup for this
app to model, and a cart total is exactly the sum of its lines.

That's also why some of these sit below the price on the board: the soda
and popcorn are discounted, the food isn't. Each item has a free-text
**note** shown under it, which is where that gets explained — "50¢ off"
is a label on an already-discounted price, not arithmetic the app
performs.

**Option groups** are named lists of choices an item comes with —
`Sauce`, `Pretzel Flavor`, `Pizza Flavor`, all transcribed from AMC's own
ordering screens. An item points at one group by id, so
a group can be shared by several items (chicken tenders, popcorn chicken
and IMPOSSIBLE nuggets all take the same sauce cups) or belong to exactly
one (a pizza's toppings) — same mechanism either way, which is what makes
"add Marinara to the sauce list" a single edit instead of one per
fried-thing. The host adds, renames and fills groups from the same panel,
and each one shows how many items use it so it's clear what a deletion
would affect.

Friends pick **one per unit ordered**: order two chicken tenders and you
get two dropdowns, because that's two sauce cups and quite possibly two
different ones. **A cart won't save while any of those picks is empty** —
Save is held closed, the unchosen dropdowns are outlined, and the footer
names what's outstanding ("Still to choose: Chicken Tenders (sauce)"),
since an order reaching you as "Chicken Tenders ×2" with no sauces named
is one you can't actually place. The pay buttons are withheld too: an
incomplete cart can't have been saved, so its total isn't one you've
agreed to. Setting the item back to zero clears the requirement, and an
item whose group the host hasn't filled in yet never triggers it.

Candy is deliberately *not* an option group — it's a flat list of
individual items, so two different candies are just two lines.

A group the host creates and hasn't filled in yet is still legal: an item
whose group has no options behaves exactly like an item with no group
until someone fills it.

**Sections** keep the list readable. An item can carry a section name,
and a named section is folded behind a collapsed header in the cart
instead of sitting inline — that's what keeps 25 candy bars from burying
the eight things people usually want. It's presentation only; a section
has no bearing on price, options or what lands in an order. A section
opens itself when it holds something already in the cart, so reopening a
cart never hides what's in it, and its header shows how much is. The
admin panel files rows the same way (a row moves to its new section on
the next save, not mid-keystroke).

**What the host sees.** Open a showtime in the editor and, under the seat
summary, there's what everyone ordered: a line per seat (with their picks
and notes), then a summed roll-up — `Chicken Tenders ×4 … $45.96`, plus a
separate tally of the choices (`BBQ Sauce ×3, Icing Cup ×1`, its own ask
at the counter) — and a total. That roll-up is the point: it's the list
you read at the counter, already added up, instead of adding up six
people's orders yourself. The seat editor overlay shows one seat's order
too, read-only, so you can see what someone asked for while you're
marking their seat paid.

**Paying.** The cart's pay button covers the whole bill — ticket plus
concessions — unless you've already marked that seat paid, in which case
it's just the concessions. The buttons only appear when what's on screen
matches what's been saved: pre-filling "pay $43.46" for an order the host
hasn't actually received yet is the one way this screen could cost
someone money, so making an edit hides them until you save.

A few things worth knowing about how this actually works:

- **Anyone can edit any seat's cart.** There's no per-friend identity in
  this app — one shared password, and a name typed free-text at claim
  time — so a cart belongs to a *seat*, not to a login. That's
  deliberate, and it's the same trust model the rest of the friend side
  already runs on: it's what makes "I'm at the counter, add a popcorn to
  Jordan's too" something you can just do.
- **Orders close 2 hours before showtime**, which is what the page has
  always promised. After that the cart still opens, but read-only, with a
  note pointing people at you. This is enforced in the page, not on the
  server, and that's not an oversight: a showtime's date/time are stored
  as bare local strings with no timezone, and the server runs in a
  container that's effectively UTC — a server-side cutoff would lock a San
  Francisco showtime's carts seven or eight hours early. The friend's own
  clock is the same wall clock the showtime was written in, so it's the
  only one that can read the cutoff correctly. As a friend-group nudge
  that's the right trade; don't mistake it for an access control.
- **Editing the menu never rewrites an order that's already placed.** A
  cart line stores the item's name, price and picks as they were when it
  was added, not a live lookup — so repricing a popcorn doesn't
  retroactively change what someone owes, and removing an item doesn't
  make it vanish from a cart that contains it (it stays, flagged "no
  longer on the menu", and can still be edited down to zero). Same for
  options: a sauce the host has since deleted still shows as the pick on
  an order that chose it.
- **Nobody sitting next to Naren is offered peanut candy.** Played for a
  laugh, built to fail safe: when a neighbouring seat in the same row is
  reserved by a Naren (matched on a word boundary, any capitalization),
  peanut items quietly drop out of that seat's menu. No banner explaining
  the bit — the people it applies to are in on it. It will *not* hide a
  peanut item already in the cart — an invisible line
  someone is still being charged for is worse than a visible one — and it
  isn't enforcement: the host still sees every order in full, which is
  the copy that matters at the counter. Only same-row neighbours count,
  because seat numbers don't line up across rows (row A is offset, see
  `padStart` in `seat-layout.js`), so "same number, next row" isn't the
  seat behind you.
- **Clearing a seat's name clears its order.** The order belonged to the
  person whose name was on the seat, so freeing the seat for someone else
  starts them from an empty cart. Fixing a typo in a name, or ticking
  "paid", keeps it.
- Orders live on the seat inside `showtimes.json`. The menu lives in
  `concession-menu.json`, which only exists once the host has saved an
  edit — no file means the built-in AMC menu is in effect. Both are in
  `DATA_DIR`, so they need the same persistent volume as everything else
  (see below).

## Payment handles

Like the friend password, Venmo and Cash App handles are **not**
environment variables. Set either, both, or neither from the "Payment
Handles" field in the admin editor, below the showtimes list — a friend
only sees a pay button on the reservation page for the one(s) you've
actually filled in. Store the handle without the leading `@` (Venmo) or
`$` (Cash App); it gets added back automatically when building the pay
link.

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
persists `showtimes.json`, the concessions menu, the friend password, and
uploaded images across restarts and rebuilds — don't remove it (`docker compose down -v` would
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
3. Add a **persistent volume** — this is where `showtimes.json` (which
   carries friends' concession orders), the concessions menu, the
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
   there's only one URL (no separate reservation link), that domain is the
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
the friend password, payment handles, concessions menu, and uploaded
images survive a redeploy, so this check covers all of it.
