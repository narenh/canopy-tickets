# Canopy Tickets

A small tool for tracking AMC seat blocks you've bought so friends can
claim seats.

- Everyone signs in with their **Canopy account**
  (`account.canopysf.com`), the same one every Canopy site uses: see
  "Signing in" below. Signed in as the admin, **Manage** (or `/admin`)
  opens the editor — add
  movies and their showtimes, pick which seats you actually bought on a
  real AMC seat map, give each movie a password, assign seats to specific
  friends, and mark them paid. Friends can mark themselves paid too, for
  tickets and concessions alike.
- At **`/`**, friends get two tabs: **My Showtimes** (their seats,
  and guests they booked) and **All Movies**. Friends see each other as
  "Matt G", with the name and photo from their Canopy account. A movie is locked until its
  **password** is typed in, once per person; after that they see its
  showtimes, pick an open seat off a seat map, reserve it for themselves
  or for someone they're bringing, and get a one-tap Venmo and/or Cash App
  link pre-filled with the price (whichever you've set up — see "Payment
  handles" below). You still confirm the payment actually landed manually
  on the admin side.
- Friends can come back any time and tap their reserved seat to build a
  **concession order** off the AMC menu, which ships built in and is
  editable from the editor — see "Concessions" below. The
  pay link then covers the ticket and the snacks together, and the editor
  gives you a summed shopping list to take to the counter.

The domain root is the only link you hand out. Someone who isn't signed
in is sent to `account.canopysf.com` to sign in (or make an account),
and comes straight back. See "Signing in" and "The admin" below.

**Seat maps currently only cover AMC Metreon (San Francisco) — IMAX
(Auditorium 16) and Dolby Cinema (Auditorium 13).** Other screens/theaters
are coming soon; see `public/seat-layout.js` below for how a new one gets
added.

Everything is persisted server-side in one SQLite file plus a few small
files and images (see "Storage & backups" below).

## How it works

- `server.js` — Express app: who's signed in (`attachPerson`, asking
  Canopy accounts), the Origin check, per-movie unlocks, and the JSON
  APIs for both sides. `GET /` serves the reservation page to someone
  signed in, and anyone else a tiny page that sends them on to sign in;
  `GET /admin` serves the editor to the admin, sends anyone else signed in
  to `/`, and anyone signed out to sign in and back. `GET /signout` hands
  over to the account service's sign-out.
- `lib/store.js` — persistence: movies, showtimes, seats and people live
  in one SQLite file, `data/canopy.db` (`lib/sqliteStore.js`; see
  "Storage & backups" below). `claimSeat` does the friend-facing claim in one
  transaction, so two people tapping the same seat at the same instant
  can't both win it. Every
  showtime carries a `screen` (which auditorium/seat-map it uses, see
  `public/seat-layout.js`), defaulting to IMAX at Metreon
  (`"amc-metreon-16"`) via a fallback in `server.js` if unset.
  `setSeatConcessions` does the same read-check-write dance for a friend
  editing a reserved seat's concession order.
- `lib/canopyAccount.js` — the account service's
  `client/canopy-account.js`, copied in unchanged apart from its header
  comment. To update it, copy that file in again.
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
- `lib/seats.js` — normalizes a stored seat entry into
  `{status: 'occupied'}` or `{status: 'assigned', name, paid, concessionsPaid,
  concessions}`,
  where `concessions` is that seat's cart (`{itemId, name, price, qty,
  note?, options?}` per line, `options` holding one pick per unit
  ordered).
- `lib/uploadedImage.js` — persistence for admin-uploaded site images (the
  link-preview image, the logo): `createImageStore(name)` gives each one
  its own file in `DATA_DIR`, same durability story as `canopy.db`.
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
- `views/admin.html` — the admin ("Ticket Manager"), in three tabs. **Movies**: a poster
  grid (past movies collapsed underneath); a movie's page has its title
  (rename in place), poster (tap to replace) and showtimes; a showtime
  opens the seat-map editor, which also shows what friends have ordered,
  per seat plus a summed shopping list. **Food & Drink**: the concessions menu
  editor. **People**: everyone who's signed in here, for seat assignment
  (photo, name, email, reservations), with anyone whose Canopy account is
  gone marked **Former member**. **Settings**: payment handles, logo and link-preview image.
  A movie's page also has its password, which saves as you type. The screen is in the URL hash (`#/movie/<id>`,
  `#/showtime/<id>`, ...), so back and reload work. There's no Save
  button on a showtime: each field and each seat saves as it's changed,
  and a pill at the bottom says whether it has (tap it to retry a save
  that failed). Tapping a seat in your block opens the seat editor:
  **Person** links it to someone's profile — their own seat (named as
  friends see them, one per showtime) or, with **A guest they're
  bringing**, a guest's under the name you type — and it shows on their
  My Showtimes. "No profile" keeps it a plain name. The menu still has
  an explicit Save. Only served to authenticated admin requests.
- `views/public.html` — the friend-facing reservation page. Only served
  to a signed-in browser. Two
  tabs: **My Showtimes** and **All Movies**, a poster grid where a locked
  movie takes its password over its own (blurred) poster; tapping an
  unlocked one lists that film's showtimes. Shows each showtime's remaining spot count
  (green if any are open, red if sold out), who's already claimed a seat,
  a seat map to pick a specific open one from (hover or tap a taken seat
  for who it's assigned to), and a pre-filled Venmo and/or Cash App pay button right
  after claiming for whichever handle(s) are set (see "Payment handles"
  below); doesn't expose which seats are sold-out-but-not-mine vs. simply
  not part of the block. Your own reserved seats (and your
  guests') on the list are also the way into that seat's concession cart
  (see "Concessions" below); other people's are just who's sitting there.
- `public/copy.js` — every sentence the app says, in one object. See
  "Editing the copy" below.

## Editing the copy

All the wording lives in **`public/copy.js`**. Change the text between
the quotes, save, reload — there's no build step, the file is served
straight to the browser and read at load time (and cache-busted from its
mtime, same as `seat-layout.js`, so an edit can't be hidden behind a
stale copy in someone's browser).

`{braces}` are placeholders the code fills in. Keep the name spelled the
way it appears (`{amount}`, `{seat}`, `{count}`) or it'll show through to
the page verbatim; move it anywhere in the sentence, or drop it if you
don't want it said. Keys ending `One`/`Many` are singular and plural of
the same line.

Two ways a line reaches the page. Static markup names its key —
`<p data-copy="friend.intro"></p>` — and `applyCopy()` fills every one of
those at load. Everything built in JS asks at the point of use:
`t('friend.claim.title', { seat: 'G17' })`. A key that doesn't exist
renders as the key path itself rather than `undefined`, so a typo shows
up on the page as the thing to go fix.

Three things are deliberately *not* in there: one- and two-word button
labels (Save, Close, Edit, Reserve, Skip), which read better next to the
buttons they name; the concessions menu, which is data — edit it in the
menu editor, or `lib/concessionMenu.js` for the built-in list it starts
from; and anything only a developer sees. The one other page, the
few words a signed-out visitor sees for a moment on the way to sign in,
is in `sendSignedOutPage()` in `server.js`.

## Signing in

**Tickets has no sign-in of its own.** People, passkeys, sign-in and
sign-out, and everyone's name, photo and Venmo belong to the Canopy
account service at `https://account.canopysf.com` (its own repo,
`canopy-account-service`). Its cookie, `canopy_session`, is set for all of
`canopysf.com`, so the browser sends it to `tix.canopysf.com` too, and
tickets asks the account service, server to server, who it belongs to
(`lib/canopyAccount.js`).

- **Signed out**, `/` and `/admin` show tickets' own sign-in page
  (`views/signin.html`), with its logo, backdrop and Open Graph tags (a
  link-preview crawler gets this page too; see "Link-preview image &
  logo").
- **Sign in with passkey** works right on that page. The page calls the
  account service's two sign-in endpoints itself
  (`/api/auth/login/options` and `/verify`, which allow Canopy pages to
  call them across sites), the phone signs, and the session cookie that
  comes back is the one every Canopy site reads. Then the page reloads,
  signed in. The passkey library is vendored in
  `public/vendor/simplewebauthn-browser-*` and inlined into the page.
- **Continue with email** goes to `account.canopysf.com` with `?return=`
  back here: an email and a 6-digit code there either signs in (with a
  new passkey on this phone) or makes a new account, with name, photo and
  an optional Venmo. Then the browser comes straight back to tickets.
- **Sign out** in the profile menu goes to `/signout`, which hands over to
  the account service's sign-out. That signs the browser out of every
  Canopy site, then comes back to `/`, the sign-in page.
- **Same ids.** Everyone in tickets was imported into the account service
  with the id they had here, so tickets' `people` rows, seats, unlocks
  and favorites all still line up. Tickets keeps its `people` row for each
  person as its own record (see `syncPerson` in `lib/sqliteStore.js`).
  On each visit it's brought up to date from the account: a new Canopy
  member gets a row, and a new email, name, photo or Venmo is copied in.
  A rename keeps the old rule: their own seats follow it, guests' seats
  keep the guest's name.
- **Changes show on tickets the next time that person visits tickets.**
  The account service's answer for each visitor is cached for **60
  seconds**, so a new name or photo (or a sign-out elsewhere) can take up
  to a minute to show here. If the account service can't be reached, a
  cached answer up to 15 minutes old stands in; past that, pages answer
  503 "Canopy accounts could not be reached".
- **Photos load straight from the account service**:
  `https://account.canopysf.com/photo/<id>?v=<photo time>` in an `<img>`.
  The browser sends the account cookie along, because it counts
  `account.canopysf.com` as the same site as `tix.canopysf.com`, so
  tickets never fetches or stores a photo itself.
- **Nobody is ever deleted here.** Someone deleted at the account service
  is a former member: their row, seats and history stay, and the admin's
  People tab marks them.

**What you'll need for it:** two settings, `CANOPY_ACCOUNT_URL` (default
`https://account.canopysf.com`) and `CANOPY_ACCOUNT_KEY`, this site's key
from the account admin's **Sites** tab (site name `tickets`). Without the
key, the server logs a loud warning at startup and treats everyone as
signed out; the page says signing in isn't working rather than sending
people round in circles.

**The Origin check.** The account cookie goes to every `*.canopysf.com`
site, so on its own it can't tell a request from tickets' pages from one
made by a page on another Canopy subdomain. So anything here that
changes something (not GET, HEAD or OPTIONS) has to carry an `Origin`
header for tickets' own address (`https://tix.canopysf.com`, worked out
from the request, with `trust proxy` on), or it's refused with a 403
(`"reason": "bad_origin"`). Browsers send `Origin` on every POST, PUT,
PATCH and DELETE, and the pages' fetches are all relative URLs, so tickets'
own pages always pass. The calendar feed is a GET and stays cookie-less.

**Movie preferences** (in the menu under your photo) shows
your name, photo and email, links to your Canopy account for name, photo, phone and payment
handles (`account.canopysf.com/profile`), and holds what's tickets' own:
**Peanut allergy**. Settings only tickets cares about go here, never in
the account service; anything every Canopy site would use goes there.

**After the switch, everyone signs in once more**, at
`account.canopysf.com`, with the same passkey they already had for
tickets (one tap: passkeys belong to `canopysf.com`, not to either site).
Tickets' old sign-in cookie does nothing any more. Someone who never made
a passkey here, or whose phone doesn't have it, uses their email and a
code there instead.

**What's left of tickets' old sign-in.** The `devices` and `passkeys`
tables are still in `canopy.db`, unread and unwritten. They weren't
dropped and the schema version didn't change, so nothing about the
switch is irreversible. Profile photos tickets used to store are still in
`DATA_DIR/photos/` on the volume too, and nothing reads them either.

## Movie passwords

**Movie passwords** gate everything inside a movie:

- **Each movie has its own password**, set on the movie's page in the
  admin and shown there in plain text (it's for handing out). A friend
  types it once and the movie stays unlocked **for them, on every device**
  (`person_unlocks`).
- **Reserving, concession orders and marking paid** need the movie
  unlocked.
- **A seat's order and payment are its owner's**: your own seat and the
  guests you booked. Other people's seats show who's sitting there and
  can't be opened; the server refuses writes to them too.
- **Claiming a seat reserved before profiles always takes that movie's
  password, typed in the claim itself**, even if it's unlocked. Seats
  picked across several movies ask for one password at a time.
- **Wrong movie passwords are limited**: 8 tries per movie per person,
  40 per network address, per 15 minutes,
  and 100 per movie per hour across everyone, as a backstop. The address
  is Cloudflare's `CF-Connecting-IP` when present — `X-Forwarded-For`
  keeps whatever the visitor sent first, so it can't be trusted for this.

A movie without a password can't be unlocked by anyone; the admin's
movie grid flags those. Changing a movie's password doesn't re-lock
people who already unlocked it.

Unlocks belong to the person, not the browser: a friend types each
movie's password once. On their first visit to tickets as a Canopy
member (tickets made their row just now, and `/api/public/me` says
`firstVisit` once), a friend is offered the seats reserved under their
name before profiles existed ("Are any of these yours?"); the same list
is under **Claim existing seats** later.

Tapping your photo in the header opens a menu: **Movie preferences**,
**Calendar feed**, **Claim existing seats**, **Sign out**.

## The admin

The admin is a person like any friend, with the same Canopy account and
the same sign-in, marked in `meta` as `admin_person_id`. That's the same
id as the account service's admin. Signed in as the admin, the tab bar
has **Manage** at its right end, and `/admin` is a shortcut to it
(anyone else signed in is sent to `/`, and anyone signed out to sign in
and back). The admin is also the host (below).

- **Accounts aren't managed here.** Renaming someone, resetting a lost
  passkey, sending a setup link or deleting an account all happen in the
  account service's admin, at `account.canopysf.com/admin`. Tickets' People
  tab is only tickets': who's here, for assigning seats, and who's a
  former member.
- **A brand-new tickets database** (no people at all, and no
  `admin_person_id`) makes the very first person to sign in the admin,
  and logs who. Only then: a database that has people but somehow lost
  its admin stays without one, rather than handing the editor to
  whichever friend signs in next. The live database
  already has its admin, so this only matters for a fresh install or
  running locally: sign in first yourself.
- **A lost passkey** is the account service's business too: an email and
  a code there makes a new one.

## Calendar feed

Each person has a subscribe-once calendar of every showtime they have a
seat in (theirs and their guests'), at `/calendar/feed/<token>.ics`.
**Calendar feed** in the profile menu offers "Subscribe in Calendar" (the
`webcal://` link, which phones hand to their calendar app) and Copy link,
and a banner at the top of My Showtimes points at it until it's tapped or
dismissed. Calendar apps fetch it without cookies, so the random
per-person token in the URL is the key.

The confirmation card after a claim asks one thing at a time — settle up,
then order something — each with its own way out; skipping one moves to
the next rather than dismissing the lot, and a step that can't do
anything (no payment handles, no menu) is never offered.

Times are resolved against **San Francisco's own clock** and written as
real UTC instants, so a January showtime lands on PST and a July one on
PDT without anyone picking which — the zone's rules decide, from `Intl`'s
timezone data. That's a two-pass conversion (the offset needed to do the
conversion depends on the result), which gets the hour either side of a
DST change right rather than approximately right. `SHOWTIME_TIMEZONE` in
`server.js` is a constant today because every screen this app knows about
is at Metreon; when that stops being true, a showtime will need to carry
its own zone.

Each event is a flat **3 hours**. Nothing here knows a film's real
runtime, and what the block on someone's calendar is for is trailers, the
film and getting out.

## Concessions

Friends can come back to the reservation page any time after reserving a
seat and build a concession order for it. On the list, each of your
reserved seats (and your guests') is its own tappable row showing only a count — "🍿 5 items", or "No
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

**The host owes nothing.** The host is the admin's own profile (see
"The admin" above; `meta.admin_person_id`). That person's own seats —
not their guests' — come out of the store with `host: true`, read as
paid everywhere, and their cart drops the pay buttons and the "mark as
paid" control entirely — they buy every ticket
and every tray on their own card, so there's nobody for them to pay. A
seat reserved before profiles counts once the host claims it ("Claim
existing seats").

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

**Paying.** The ticket is paid from the pay button on My Showtimes (and
the post-claim card). The concessions cart only ever asks for the food,
and only once the host has closed orders — before that it shows what the
seat owes but has no pay button. The buttons only appear when what's
on screen matches what's been saved: pre-filling "pay $43.46" for an
order the host hasn't actually received yet is the one way this screen
could cost someone money, so making an edit hides them until you save.

**Marking yourself paid.** A payment link hands off to Venmo or Cash App
and nothing comes back — neither has a callback that could tell this app
the money arrived — so somebody saying so is the only signal that exists.
Beside the cart's pay button is **I've paid**, which marks the food
settled; the post-claim card offers the same thing as
**I've already paid** next to the pay links, since the moment you've just
sent the money is the moment you remember to record it. Any friend can mark
any seat and undo it again, same as they can edit any seat's cart, and
the host can overrule all of it from the editor.

**The ticket and the food are two bills that come due at different
times**, which is why they're tracked separately. A ticket costs what it
costs the moment the seat is claimed, so it can be settled right away.
A cart can't be, because it's a draft until the host finalizes it and
goes to place the order: people decide what they want on the day — am I
hungry, do I have dinner plans — so carts typically get filled in hours
before the show and change several times while they are. Paying against a draft
means paying the wrong number.

So while the cart is open it shows what you'll owe in total but the pay
buttons and "I've paid" offer the **ticket alone**, with a line underneath
saying why: *Concessions settle after order is placed.* Once you finalize
the order the food total is final, and both cover the lot. That gap is deliberate: if the buttons offered the draft total and
someone sent it, the app's record and the actual payment would disagree
the moment the cart changed.

On the list, a seat is tagged **unpaid** while it owes anything at all,
ticket or food — an unpaid cart is unpaid even while its total is still a
draft. The editor spells out what each seat owes and lets the host tick
either half by hand.

A few things worth knowing about how this actually works:

- **Anyone with the movie unlocked can edit any seat's cart**, not just
  their own. That's deliberate: it's what makes "I'm at the counter, add
  a popcorn to Jordan's too" something you can just do. Now that seats
  have owners, limiting carts to your own seats and guests is possible
  later.
- **Orders close when you finalize them**, from the **Finalize Order**
  button under the roll-up in the editor. After that the cart opens as
  a receipt — no menu, just what was ordered, the total and the pay
  buttons — under "This order has been placed and can no longer be
  changed or refunded." A change someone was in the middle of when you
  pressed it is dropped, and their receipt shows what was saved.
  **Reopen Order** puts it back. It takes effect the moment you press it.

  It used to be a clock — two hours before showtime — which was wrong
  twice over. It could only ever guess at when the order actually gets
  placed, and it had to run in the browser, because a showtime's date and
  time are stored as bare local strings with no timezone and the server
  runs somewhere effectively UTC, so a server-side cutoff would have
  locked a San Francisco showtime's carts seven or eight hours early. A
  flag you set has neither problem, so **the server enforces this one**:
  a page that was open when you finalized gets its next save refused
  (409) and locks itself, instead of slipping an order in behind you at
  the counter. The page still says orders usually close about two
  hours before the show, since that's about when you'll press it.
- **Editing the menu never rewrites an order that's already placed.** A
  cart line stores the item's name, price and picks as they were when it
  was added, not a live lookup — so repricing a popcorn doesn't
  retroactively change what someone owes, and removing an item doesn't
  make it vanish from a cart that contains it (it stays, flagged "no
  longer on the menu", and can still be edited down to zero). Same for
  options: a sauce the host has since deleted still shows as the pick on
  an order that chose it.
- **Nobody sitting next to someone with a peanut allergy is offered peanut
  items.** Anyone can tick **Peanut allergy** in Movie preferences ("Peanut items
  will be hidden for adjacent seats."). When a neighbouring seat in the same
  row is their own (not a guest's they booked), peanut items quietly drop
  out of that seat's menu. The server works this out and only tells each
  friend about their own seats, so nobody's allergy is shown to anyone
  else. It will *not* hide a
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
- Orders live on the seat, in `canopy.db`. The menu lives in
  `concession-menu.json`, which only exists once the host has saved an
  edit — no file means the built-in AMC menu is in effect. Both are in
  `DATA_DIR`, so they need the same persistent volume as everything else
  (see below).


### Favorites and "your usual"

Profile menu → **Favorites**. A favorite is an item **and** its option
(tenders with buffalo and tenders with ranch are two), in an order you set
(↑ ↓); "your usual" is a whole order's worth of such lines. Both are kept
on the account (`people.favorites` / `people.usual`) and added
from the same menu and option picker as the cart.

When either exists, the cart opens with a **Favorites** section at the
top — the only open section — led by "Your usual" (its "+" adds every
line), then each favorite (one tap, option already chosen). Whenever the
host saves or resets the menu, a favorite whose item or option is gone is
deleted; for the usual only that line goes. Reads are checked against the
current menu too.

When a line of someone's usual goes, `people.usual_gone` is
set and My Showtimes leads with a red **Item discontinued** banner ("Update
order" opens Favorites), and the cart's "Your usual" row says so too. It
clears once they open Favorites, save them, or tap ×.

Someone with a showtime but no favorites and no usual gets a **Pick your
favorite concessions** banner on My Showtimes until they tap "Add
favorites" or × (`people.favorites_prompt_done`). The cart's
Favorites header has an **Edit** button that opens the same sheet over the
cart. The claim banner (no showtimes, unclaimed seats waiting) always
shows on its own.

## Payment handles

Like movie passwords, Venmo and Cash App handles are **not**
environment variables. Set either, both, or neither from the "Payment
Handles" field on the admin's Settings tab — a friend
only sees a pay button on the reservation page for the one(s) you've
actually filled in. Store the handle without the leading `@` (Venmo) or
`$` (Cash App); it gets added back automatically when building the pay
link.

Cash App's pay links only support pre-filling an amount, not a note —
Venmo's link includes a note identifying the movie/date/seat, Cash App's
doesn't, since there's no query param for that on Cash App's side.

On My Showtimes, a friend who owes gets that pay button under the poster
(Venmo, or Cash App if it's the only handle) for their seat and their
guests' together, with a ⋯ menu holding Cash App (when both are set) and
"I've already paid". Not shown to the admin, who sees every unpaid seat
marked instead.

### Releasing a reservation

The same ⋯ menu offers **Release seat** for each seat a friend can still
give back: unpaid (ticket and food), reserved by them in the last 24
hours (`seats.reserved_at`), and the showtime more than 24 hours away.
It asks once, then the seat goes back to being an open seat in the
block. An old seat claimed into an account keeps its reservation time.

## Link-preview image & logo

The admin's Settings tab has two image uploads:

- **Site Logo** — shown at the top of the editor and reservation pages.
  (The sign-in page is the account service's, with its own logo.) Assumes a PNG, ideally with a transparent
  background.
- **Link Preview Image** — becomes the image shown when the site's link is
  shared in iMessage, Facebook, Instagram, etc. Title/description for that
  preview are fixed as "Canopy Tickets" / "Reserve your seats here" and
  aren't editable from the UI (change them in `buildOgTags()` in
  `server.js` if you ever want different copy).

A few things worth knowing about how these actually work:

- Both live in `DATA_DIR`, same as `canopy.db` — they need the same
  persistent volume (see below) to survive a redeploy.
- The Open Graph/Twitter meta tags (for the link-preview image) only
  matter on the page an unauthenticated request sees, because crawlers
  never carry anyone's cookie. In practice that's always the signed-out
  page that sends people on to sign in, and that's exactly where the tags
  are (also mirrored on the editor/reservation pages for consistency, but
  that's cosmetic). The logo is injected server-side the same way.
- **On caching**: you already know Meta/Apple cache scraped previews per
  URL. There's no way to force that cache to expire from this app's side
  — but both image URLs include `?v=<upload time>`, which changes every
  time you upload a new image. A changed URL is what actually gets a
  platform (or a browser) to fetch fresh instead of reusing what it
  cached for the old URL. If Facebook specifically still shows something
  stale, their [Sharing Debugger](https://developers.facebook.com/tools/debug/)
  lets you force an immediate re-scrape by URL.

## Running locally

Tickets needs the account service running too (the
`canopy-account-service` repo). Both on `localhost`, on different ports:
cookies aren't kept per port, so signing in on one counts on the other,
and outside production the account service is happy to send people back
to an `http://localhost` address.

```bash
# in canopy-account-service
npm install
ADMIN_PASSWORD=whatever PORT=4100 npm start
```

Visit `http://localhost:4100`, enter `ADMIN_PASSWORD` as the setup
password and make the first account (that's its admin). In its admin's
**Sites** tab, add a site called `tickets` and copy the key. Then:

```bash
# in canopy-tickets
npm install
CANOPY_ACCOUNT_URL=http://localhost:4100 CANOPY_ACCOUNT_KEY=cnp_... npm start
```

Visit `http://localhost:3000`. You're sent to the account service to sign
in and straight back. On a new database the first person to sign in is
tickets' admin, so do that first yourself. Add a movie and give it a
password (and, optionally, set Venmo/Cash App handles), then make another
account at `http://localhost:4100` in another browser to see the friend
side. With no `SMTP_HOST`, the account service prints sign-in codes in
its own console.

## Deploying with Docker

This repo ships a `Dockerfile` and a `docker-compose.yml`, so it runs
anywhere Docker does — a VPS, a NAS, a spare machine on your network, or a
PaaS like Coolify (see the Coolify-specific section below, which is built
on this same `Dockerfile`).

### docker compose (recommended)

```bash
cp .env.example .env
# edit .env -- set CANOPY_ACCOUNT_KEY (and CANOPY_ACCOUNT_URL if it isn't
# https://account.canopysf.com)
docker compose up -d --build
```

Visit it, sign in (the first person to sign in on a new database is the
admin), and add a movie with a password. The `canopy-data` named volume declared in
`docker-compose.yml` is what persists the database, the
concessions menu, and uploaded images across restarts and rebuilds — don't remove it (`docker compose down -v` would
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
  -e CANOPY_ACCOUNT_KEY=cnp_... \
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
The domain has to be under `canopysf.com`, or the account cookie never
reaches it and nobody can sign in.

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
   - `CANOPY_ACCOUNT_KEY` — this site's key for the account service, from
     the account admin's **Sites** tab (site name `tickets`). It's shown
     once, when it's made; **New key** there replaces it, and the old one
     stops working right away.
   - `CANOPY_ACCOUNT_URL` — leave unset: it defaults to
     `https://account.canopysf.com`. It has to be the public address, not
     Coolify's internal one, because browsers are sent there to sign in
     and load photos from it.
   - (There's no env var for movie passwords or for Venmo/Cash App — set
     those from the editor after deploying.)
   - `ADMIN_PASSWORD`, `ADMIN_RECOVERY` and `SESSION_SECRET` are from
     before Canopy accounts and do nothing now. Delete them.
3. Add a **persistent volume** — this is where `canopy.db` (showtimes,
   seats, tickets' record of each person, and concession orders), the
   concessions menu, the Venmo/Cash App handles, and the uploaded
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
   the domain root is the link friends get, and `/admin` on the same
   domain is the editor. It has to be under `canopysf.com`
   (`https://tix.canopysf.com`): the account cookie only reaches
   `canopysf.com` and its subdomains.
6. Deploy. The log should **not** have the `CANOPY_ACCOUNT_KEY is not
   set` warning. Visit `<app URL>`: you're sent to the account service to
   sign in, and back.

### Switching over from tickets' own sign-in

In this order:

1. **The account service is live with everyone in it**, imported from
   tickets with the same ids (its README, "Importing from tickets").
   Tickets' admin is its admin.
2. **Make tickets' key.** At `account.canopysf.com/admin`, **Sites**, add a
   site named `tickets`, and copy the key it shows (only shown once).
3. **Set tickets' environment** in Coolify: add `CANOPY_ACCOUNT_KEY` with
   that key. Delete `ADMIN_PASSWORD`, `ADMIN_RECOVERY` and
   `SESSION_SECRET`.
4. **Deploy tickets.** Check the log for the startup line with the right
   showtime count, and no `CANOPY_ACCOUNT_KEY` warning.
5. **Check it** in a private window: `tix.canopysf.com` sends you to
   `account.canopysf.com`; your passkey signs you in and you're back on
   tickets, with **Manage** in the tab bar.

What everyone sees: the next time they open tickets, they're sent to
`account.canopysf.com` once, sign in with the same passkey (one tap), and
are back where they were, with their seats, unlocked movies and
favorites as before. From then on their name, photo and Venmo are changed
at their Canopy account (Movie preferences links there), and show on tickets
the next time they visit it, within a minute. New people make an account
there.

Going back is a redeploy of the previous commit, with `ADMIN_PASSWORD`
and `SESSION_SECRET` set again: its `devices` and `passkeys` tables are
untouched. Anyone who joined through Canopy accounts in between has a
`people` row but no passkey there, so they'd set one up there with any
movie's password.

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
tickets' people records, payment handles, the concessions menu, and uploaded
images survive a redeploy, so this check covers all of it.

## Storage & backups

Showtimes, seats and orders are in `DATA_DIR/canopy.db` (SQLite). The
other settings and the uploaded images are still files next to it.

**Schema version.** A new `canopy.db` is created with the whole current
schema. An existing one is upgraded on start from version 16 onward
(`UPGRADES` in `lib/sqliteStore.js`); the app refuses to start on anything
older rather than run with columns missing. That only matters for a
database from before version 16, such as an old snapshot below; start it
once under commit `f50b354`, which still has the earlier upgrade steps,
and it's brought up to date.

`showtimes.json`, `shared-password.json` and `backups/pre-sqlite-*/` may
still be on the volume from before SQLite, and `photos/` from before
Canopy accounts. Nothing reads them any more.

**Backups.** Two layers:

- The app writes a consistent copy of the database to
  `backups/sqlite/canopy-YYYY-MM-DD.db` at startup and daily, keeping 14.
  Restore from these: copy one over `canopy.db` with the app stopped and
  delete `canopy.db-wal` / `canopy.db-shm`.
- In Coolify, on this application: **Backups → Scheduled Backups → Add**,
  target the `/app/data` volume, frequency `daily`. That archives the
  whole volume (database snapshots, settings, images); **Backup Now**
  runs one on demand. Archives stay on the server unless you add
  S3-compatible storage. Coolify's archive of the live `canopy.db` itself
  may be inconsistent if it's taken mid-write, which is why the snapshots
  above exist.
