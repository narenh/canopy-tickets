# Canopy Tickets

A small tool for tracking AMC seat blocks you've bought so friends can
claim seats. One URL, one login form, two possible passwords:

- Enter **`ADMIN_PASSWORD`** and you land in the editor — create
  showtimes, pick which seats you actually bought on a real AMC seat map,
  assign seats to specific friends, and mark them paid. Friends can mark
  themselves paid too, for tickets and concessions alike.
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
  `{status: 'occupied'}` or `{status: 'assigned', name, paid, concessionsPaid,
  concessions}`,
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
- `views/public.html` — the friend-facing reservation page. Claiming a
  seat offers an **Add to calendar** link first (see below), served as a
  real `.ics` by `server.js`. Only served to
  authenticated shared requests. Shows each showtime's remaining spot count
  (green if any are open, red if sold out), who's already claimed a seat,
  a seat map to pick a specific open one from (hover or tap a taken seat
  for who it's assigned to), and a pre-filled Venmo and/or Cash App pay button right
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

## Add to calendar

The confirmation card after a claim asks one thing at a time — settle up,
then put it in the calendar, then order something — each with its own way
out, and skipping one moves to the next rather than dismissing the lot. A
step that can't do anything is never offered: no payment handles set, no
usable date to build an event from, no menu to order off. That's what the
"Step 2 of 3" line is for, so Skip doesn't look like Close.

The **Add to calendar** step points at
`/api/public/showtimes/:id/calendar.ics?seat=G15`, which builds a real
`.ics` on the fly: title, theater as the location, and the seat, format
and price in the description.

A served `text/calendar` file rather than a `data:` URI or a Google
Calendar link — it's the one thing every phone knows what to do with, and
it doesn't assume anyone's calendar lives at a particular provider. The
`UID` is stable per seat, so adding it twice replaces the event rather
than leaving someone with two of them.

Times are resolved against **San Francisco's own clock** and written as
real UTC instants, so a January showtime lands on PST and a July one on
PDT without anyone picking which — the zone's rules decide, from `Intl`'s
timezone data. That's a two-pass conversion (the offset needed to do the
conversion depends on the result), which gets the hour either side of a
DST change right rather than approximately right. `SHOWTIME_TIMEZONE` in
`server.js` is a constant today because every screen this app knows about
is at Metreon; when that stops being true, a showtime will need to carry
its own zone.

The event is a flat **3 hours**. Nothing here knows a film's real runtime,
and what the block on someone's calendar is for is trailers, the film and
getting out.

## Concessions

Friends can come back to the reservation page any time after reserving a
seat and build a concession order for it. On the list, every reserved
seat is its own tappable row showing only a count — "🍿 5 items", or "No
concessions". Spelling out four people's orders in full turned the
showtime list into a wall of sauces; whoever wants the detail is one tap
away, and you have the itemised copy in the editor. Tapping the row opens
that seat's cart. The order is saved
against the seat, so it's there when they come back on another device or
another day.

**The cart is a catalog and a list.** The scrolling part is the menu:
each item shows its price and a single **+**, nothing else. Tapping it
drops a line into **Your order**, which sits just above the totals and
stays in view while the catalog scrolls. One tap, one line — there's no
quantity control anywhere, deliberately. A quantity can only carry one
idea of what an order is, and "popcorn chicken with ranch and another
with bbq" is two ideas. Two taps, two lines, two sauces.

The order list is compact and read-only: item, its pick, the price, and
an **×** to remove it. Changing your mind is remove-and-re-add, which is
what keeps it a list you can read at a glance instead of a dozen rows of
dropdowns and text boxes.

**The menu can't be squeezed.** The catalog and the order are two scroll
regions sharing one card, and a long order used to crush the menu down to
a couple of rows — on a small phone, to about 17 pixels. The menu now has
a floor the layout won't go below; past that the order panel is the thing
that gives up room, scrolling inside whatever it has. Its header ("Your
order · 11 items") collapses it entirely, handing the whole card back to
the menu, and the count stays visible while collapsed so nothing is lost
by doing it. Adding an item re-opens it, so **+** always visibly does
something.

**The menu ships filled in.** AMC's own list — drinks, the food page, and
candy as individual items — is hardcoded in `lib/concessionMenu.js` and
is what friends see on a fresh install, so there's nothing to set up
before the first order. It's fully editable from the "Concessions Menu"
panel in the admin editor: rename, reprice, add or remove any row and
save, and your version takes over from the built-ins (a "Restore AMC
menu" button appears once it has, and puts them back). It's one menu
shared by every showtime, not one per showtime — this is one person's
friend group at, in practice, one theater.

**There is no Save button.** Every add and removal writes straight
through: with the pick made before a line exists, every state the cart
can be in is already a valid order, so confirming it was ceremony — and a
fourth full-width button in a footer that was crowding out the menu.
Rapid taps are debounced into one request and writes are serialised, so
they can't land out of order; closing the card flushes anything still
pending. A failed write says so and offers a retry, because silent loss
is the one thing autosave must not do.

**The host owes nothing.** A seat whose name matches `HOST_SEAT_NAME` in
`lib/seats.js` reads as paid everywhere and its cart drops the "You owe"
line, the pay buttons and the "mark as paid" control entirely —
they buy every ticket and every tray on their own card, so there's nobody
for them to pay, and the reservation page stops offering to send them
money. It's derived rather than stored, so it holds however the name got
onto the seat: claimed from the reservation page, or typed into the
editor. Hardcoded to one name for now, deliberately in one place so
generalising it is a matter of replacing that constant rather than
hunting the idea through the views.

**Sales tax** is added on the concessions, at `CONCESSION_TAX_RATE` in
`lib/seats.js` — San Francisco's combined rate, served to both the cart and
the editor so the two can't drift apart. California normally exempts cold
food to go, but concessions at a cinema are the exception: food sold
where admission is charged is taxable whatever it is, so this applies to
the whole subtotal rather than trying to sort popcorn from candy. The
ticket isn't taxed (California doesn't tax admissions, and it's already
paid for). The rate is approximate and meant to be — it moves every few
years and it's one number to edit; it exists so nobody is surprised at
the counter by a bill a few dollars over what the app quoted.

**A menu price is what AMC charges before tax**, with nothing else added
on top. You buy the whole order on your own AMC Stubs account, which
waives the $1.99-per-order service fee AMC's app charges and passes your
Stubs discount on to everyone — so tax aside, there's no fee, surcharge or
markup for this app to model.

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

The pick is made **on the catalog row, before the line exists** — an
item with a group shows its picker under the **+**, and the **+** stays
disabled until something is chosen. That's the other half of the order
list being read-only: a line can't be created half-finished, so there's
nothing to go back and fix. After each add the picker resets to blank,
so two tenders with the same sauce are as explicit as two with different
ones.

That picker is a button and a list of buttons rather than a `<select>`,
and every text field on the friend side is at least 16px, because iOS
Safari zooms the whole page in when a form control with smaller text
takes focus and never zooms back out. 16px on a control that sits under
a 14px item name would dwarf it, so the control stopped being a form
control instead.

Orders saved before this existed can still be short a pick (a line from
the old quantity UI, or an item that gained a group afterwards). Those
show in red as "no sauce", and the footer says what to do — "Remove and
re-add to pick a sauce for Popcorn Chicken". They do *not* block writing:
that line is already on the server in that state, and holding the cart
hostage would mean you couldn't remove anything else until you'd dealt
with it. What they do withhold is the pay buttons, since an order the
host can't place isn't one to pay for. An item whose group the host
hasn't filled in yet never triggers any of this.

Per-item notes ("no ice") are no longer editable from the cart — that was
the cost of making the list compact — but any note saved earlier still
shows on its line and still reaches you.

Candy is deliberately *not* an option group — it's a flat list of
individual items, so two different candies are just two lines.

A group the host creates and hasn't filled in yet is still legal: an item
whose group has no options behaves exactly like an item with no group
until someone fills it.

**Sections** keep the list readable. An item can carry a section name,
and a named section is folded behind a collapsed header in the cart
instead of sitting inline — that's what keeps 25 candy bars from burying
the two things nearly every order has. Out of the box it's **Popcorn &
Soda**, **More Drinks**, **Hot Food**, **Packaged Snacks** and **Candy**.
Popcorn & Soda and Hot Food start expanded (`DEFAULT_OPEN_SECTIONS` in
`lib/concessionMenu.js`, matched by name), which puts popcorn, a soda and
the chicken tenders on screen the moment the cart opens — most of what
most orders are — with the rest one tap away rather than in the way.

A section renders where its *first* item falls in the menu, so the order
in `DEFAULT_ITEMS` is the order on screen.

On a phone the cart is a **full-screen sheet** rather than a card
floating on a dimmed page: at that size the margins were costing rows of
menu. It closes from an **×** in the corner as well as the button at the
foot — on a full-screen sheet the bottom button is a scroll away from
wherever a thumb is — and the page behind is pinned while it's open, so
the menu is the only thing on screen that scrolls.

A section header is its own card: a gold uppercase label (nothing else in
the list is gold except the **+** buttons, so a header can't be mistaken
for an item), a chevron, and a count that turns gold when
something in that section is already in the order. An open section's
header sticks to the top of the scrolling menu, because the point where a
25-row section is most confusing is the middle of it. The editor's menu
panel uses the same treatment, so sections read the same way on both
sides.

It's presentation only; a section has no bearing on price, options or
what lands in an order. A section opens itself when it holds something
already in the cart, so reopening a cart never hides what's in it, and
its header shows how much is. The admin panel files rows the same way (a
row moves to its new section on the next save, not mid-keystroke).

**What the host sees.** Open a showtime in the editor and, under the seat
summary, there's what everyone ordered: a line per seat (with their picks
and notes), then a summed roll-up — `Chicken Tenders ×4 … $45.96`, plus a
separate tally of the choices (`BBQ Sauce ×3, Icing Cup ×1`, its own ask
at the counter) — and a total. That roll-up is the point: it's the list
you read at the counter, already added up, instead of adding up six
people's orders yourself. The seat editor overlay shows one seat's order
too, read-only, so you can see what someone asked for while you're
marking their seat paid.

**Paying.** The cart's pay button covers whatever the seat still owes —
the ticket, the concessions, or both. The buttons only appear when what's
on screen matches what's been saved: pre-filling "pay $43.46" for an
order the host hasn't actually received yet is the one way this screen
could cost someone money, so making an edit hides them until you save.

**Marking yourself paid.** A payment link hands off to Venmo or Cash App
and nothing comes back — neither has a callback that could tell this app
the money arrived — so somebody saying so is the only signal that exists.
Under the pay buttons is **I've paid $X**, which settles whatever the
seat can currently settle; the post-claim card offers the same thing as
**I've already paid** next to the pay links, since the moment you've just
sent the money is the moment you remember to record it. Any friend can mark
any seat and undo it again, same as they can edit any seat's cart, and
the host can overrule all of it from the editor.

**The ticket and the food are two bills that come due at different
times**, which is why they're tracked separately. A ticket costs what it
costs the moment the seat is claimed, so it can be settled right away.
A cart can't be, because it's a draft until the host closes it and goes
to place the order: people decide what they want on the day — am I
hungry, do I have dinner plans — so carts typically get filled in hours
before the show and change several times while they are. Paying against a draft
means paying the wrong number.

So while the cart is open it shows what you'll owe in total but the pay
buttons and "I've paid" offer the **ticket alone**, with a line underneath
saying why: *Concessions settle after order is placed.* Once you close
the cart the food total is final, and both cover the lot. That gap is deliberate: if the buttons offered the draft total and
someone sent it, the app's record and the actual payment would disagree
the moment the cart changed.

On the list, a seat is tagged **unpaid** while it owes anything at all,
ticket or food — an unpaid cart is unpaid even while its total is still a
draft. The editor spells out what each seat owes and lets the host tick
either half by hand.

A few things worth knowing about how this actually works:

- **Anyone can edit any seat's cart.** There's no per-friend identity in
  this app — one shared password, and a name typed free-text at claim
  time — so a cart belongs to a *seat*, not to a login. That's
  deliberate, and it's the same trust model the rest of the friend side
  already runs on: it's what makes "I'm at the counter, add a popcorn to
  Jordan's too" something you can just do.
- **Orders close when you close them**, from the **Close cart** button
  under the roll-up in the editor. After that the cart still opens, but
  read-only, with a note pointing people at you; **Reopen cart** puts it
  back. It writes immediately rather than waiting for Save Showtime,
  because it's you saying "I'm at the counter now" and it must not ride
  along with a seats object the editor may have been holding since before
  somebody's last order.

  It used to be a clock — two hours before showtime — which was wrong
  twice over. It could only ever guess at when the order actually gets
  placed, and it had to run in the browser, because a showtime's date and
  time are stored as bare local strings with no timezone and the server
  runs somewhere effectively UTC, so a server-side cutoff would have
  locked a San Francisco showtime's carts seven or eight hours early. A
  flag you set has neither problem, so **the server enforces this one**:
  a page that was open when you closed the cart gets its next save
  refused (409) and locks itself, instead of slipping an order in behind
  you at the counter. The page still says orders usually close about two
  hours before the show, since that's about when you'll press it.
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
  starts them from an empty cart — and clears what they'd settled with
  it. Fixing a typo in a name, or ticking "paid", keeps both.
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
