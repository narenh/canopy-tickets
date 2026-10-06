# Canopy Tickets

A small tool for tracking AMC seat blocks you've bought so friends can
claim seats.

- Sign in at **`/`** with your passkey and **Ticket Manager** (or `/admin`) is the editor — add
  movies and their showtimes, pick which seats you actually bought on a
  real AMC seat map, give each movie a password, assign seats to specific
  friends, and mark them paid. Friends can mark themselves paid too, for
  tickets and concessions alike.
- At **`/`**, friends sign in with their **email**. A new email sets up a
  profile: first and last name and a photo, all required (friends see
  each other as "Matt G"). Then two tabs: **My showtimes** (their seats,
  and guests they booked) and **All movies**. A movie is locked until its
  **password** is typed in, once per phone; after that they see its
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

The domain root is the only link you hand out, and everyone — you
included — signs in there. See "Friends: sign-in and movie passwords"
and "The admin" below.

**Seat maps currently only cover AMC Metreon (San Francisco) — IMAX
(Auditorium 16) and Dolby Cinema (Auditorium 13).** Other screens/theaters
are coming soon; see `public/seat-layout.js` below for how a new one gets
added.

Everything is persisted server-side in one SQLite file plus a few small
files and images (see "Storage & backups" below).

## How it works

- `server.js` — Express app: passkey sign-in (friends and the admin
  alike), first-run admin setup (`ADMIN_PASSWORD`), profiles and photos,
  per-movie unlocks, and the JSON
  APIs for both sides. `GET /` serves the reservation page to a browser
  someone's signed in on and the sign-in page to anyone else; `GET /admin`
  serves the editor to the admin's session and redirects anyone else to `/`.
- `lib/store.js` — persistence: movies, showtimes and seats live in one
  SQLite file, `data/canopy.db` (`lib/sqliteStore.js`). On its first start
  it imports the old `data/showtimes.json` and checks every showtime and
  seat against the original before switching over (see "Storage &
  backups" below). If that check ever fails it runs on the JSON instead
  (`lib/jsonStore.js`). `claimSeat` does the friend-facing claim in one
  transaction, so two people tapping the same seat at the same instant
  can't both win it. Every
  showtime carries a `screen` (which auditorium/seat-map it uses, see
  `public/seat-layout.js`), defaulting to IMAX at Metreon
  (`"amc-metreon-16"`) via a fallback in `server.js` if unset.
  `setSeatConcessions` does the same read-check-write dance for a friend
  editing a reserved seat's concession order.
- `lib/sharedPassword.js` — the old site-wide friend password. Only read
  once now, to give the movies that existed then that password as their
  own (see "Friends: sign-in and movie passwords").
- `lib/deviceAuth.js` — the friend side's cookie: a signed id for this
  browser, good for a year from the last visit.
- `lib/photoStore.js` — profile photos (already cropped to 512px by the
  browser), served only to signed-in friends and the host.
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
- `views/admin.html` — the admin ("Ticket Manager"), in three tabs. **Movies**: a poster
  grid (past movies collapsed underneath); a movie's page has its title
  (rename in place), poster (tap to replace) and showtimes; a showtime
  opens the seat-map editor, which also shows what friends have ordered,
  per seat plus a summed shopping list. **Food & Drink**: the concessions menu
  editor. **People**: everyone who's set up a profile (fix a name, delete a
  typo'd one). **Settings**: payment handles, logo and link-preview image.
  A movie's page also has its password, which saves as you type. The screen is in the URL hash (`#/movie/<id>`,
  `#/showtime/<id>`, ...), so back and reload work. There's no Save
  button on a showtime: each field and each seat saves as it's changed,
  and a pill at the bottom says whether it has (tap it to retry a save
  that failed). The menu still has an explicit Save. Only served to
  authenticated admin requests.
- `views/public.html` — the friend-facing reservation page. Claiming a
  seat offers an **Add to calendar** link first (see below), served as a
  real `.ics` by `server.js`. Only served to a signed-in browser. Two
  tabs: **My showtimes** and **All movies**, a poster grid where a locked
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
- `views/welcome.html` — the friend door: email, and for a new one, name
  and photo. `public/photo-crop.js` frames the photo (Cropper.js 1.x,
  vendored in `public/vendor/`).
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
from; and anything only a developer sees.

## Friends: sign-in and movie passwords

**Friends sign in with a passkey** (Face ID / Touch ID / the phone's
screen lock) — no friend passwords to store, guess or forget. Passkeys are
made for `canopysf.com` (override with `PASSKEY_RP_ID`), so they keep
working if the app moves to another subdomain; on any other host
(localhost in development) they're made for that host. The server keeps
only each passkey's public key (`passkeys` table); the browser half is
SimpleWebAuthn, vendored in `public/vendor/simplewebauthn-browser-*`.

- **Sign in:** "Sign in with passkey" — no email; the phone offers the
  passkey it has for the site. iCloud Keychain / Google Password Manager
  sync it to the person's other devices.
- **New email:** first and last name and a photo (all required), then the
  phone saves a passkey. The profile is only created once the passkey
  exists.
- **Existing profile with no passkey** (everyone, the first time after
  passkeys arrived, or after a reset): the password of **any** movie, then
  the passkey. That movie gets unlocked for them too.
- **Profile that already has a passkey:** only the passkey gets in. A lost
  phone (or a switch to a phone that doesn't have it) is **Reset passkeys**
  in the admin's People tab: their passkeys are deleted, they're signed
  out everywhere, and they set up again with any movie's password.

Once signed in, the session is the browser's device cookie (a year from
the last visit). Your profile — name, photo, optional Venmo username —
is yours to edit whenever you're signed in.

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
- **Wrong movie passwords are limited**: 8 tries per movie per person (or
  browser, for first-time setup), 40 per network address, per 15 minutes,
  and 100 per movie per hour across everyone, as a backstop. The address
  is Cloudflare's `CF-Connecting-IP` when present — `X-Forwarded-For`
  keeps whatever the visitor sent first, so it can't be trusted for this.

A movie without a password can't be unlocked by anyone; the admin's
movie grid flags those. Changing a movie's password doesn't re-lock
people who already unlocked it.

**Moving over from before passkeys:** everyone was signed out once
(schema v9), and what browsers had unlocked was dropped (v10) — a friend
types each movie's password once, on their account. After setting up a
new profile, a friend is offered the seats reserved under their name
before profiles existed ("Are any of these yours?"); the same list is
under **Claim existing seats** later.

Tapping your photo in the header opens a menu: **Edit profile**,
**Calendar feed**, **Claim existing seats**, **Sign out**.

## The admin

The admin is a profile like any friend's — same passkey, same sign-in —
marked in `meta` as `admin_person_id`. Everyone signs in at `/`;
signed in as the admin, the friend-side menu has **Ticket Manager**, and
`/admin` is just a shortcut to it (anyone else is sent to `/`). The admin
is also the host (below).

- **There is never an account without an admin.** On a brand-new
  install the sign-in page at `/` is only "Enter the setup password to
  set up your admin account" (`ADMIN_PASSWORD`), and the server refuses
  every other sign-up and sign-in until it's been entered. Whoever then
  signs up on that browser, within 15 minutes, is the admin and lands in
  the editor.
- **After that** the setup password does nothing: there's no password
  login to the editor at all.
- **Lost your passkey?** Set `ADMIN_RECOVERY=1` in the server's settings
  and redeploy. The sign-in page shows a small **Admin setup** link; after
  the setup password, your email offers **Set up a new passkey**. It only
  ever adds a passkey to the admin's own profile — it can't make anyone
  else the admin or get into anyone else's account. Remove the setting afterwards.
  It takes access to the server's settings, which is the right bar for
  the keys to everything.
- In People, the admin's row is tagged **Admin** and can't be deleted or
  have its passkeys reset from there — either would lock you out.

Upgrading from "This is me" (schema v11): the profile marked that way
became the admin — or, if nobody was marked, the first profile made.

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
paid everywhere, and their cart drops the "You owe" line, the pay
buttons and the "mark as paid" control entirely — they buy every ticket
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
  button under the roll-up in the editor. After that the cart still
  opens, but read-only, with a note pointing people at you; **Reopen
  Order** puts it back. It takes effect the moment you press it.

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
- **Nobody sitting next to the host is offered peanut candy.** Played for a
  laugh, built to fail safe: when a neighbouring seat in the same row is
  the host's own (see "The host owes nothing"; hardcoded to them for now),
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
- Orders live on the seat, in `canopy.db`. The menu lives in
  `concession-menu.json`, which only exists once the host has saved an
  edit — no file means the built-in AMC menu is in effect. Both are in
  `DATA_DIR`, so they need the same persistent volume as everything else
  (see below).

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

## Link-preview image & logo

The admin's Settings tab has two image uploads:

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

Then visit `http://localhost:3000`: enter `ADMIN_PASSWORD` as the
setup password and set up your profile and passkey — that account is the
admin. Add a movie and give it a password (and, optionally, set
Venmo/Cash App handles), then sign up at `http://localhost:3000` in
another browser to see the friend side. If you don't set
`ADMIN_PASSWORD`, the server generates a random one and prints it to the
console on startup.

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

Visit `http://localhost:3000`, enter `ADMIN_PASSWORD` as the setup
password to make your admin account, and add a movie with a password. The `canopy-data` named volume declared in
`docker-compose.yml` is what persists the database, photos, the
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
   - `ADMIN_PASSWORD` — the setup password: entered once, on first run,
     to make your admin account (after that you sign in with a passkey).
     Keep it to yourself; it's also what `ADMIN_RECOVERY` asks for.
     (There's no env var for movie passwords or for Venmo/Cash App — set
     those from the editor after deploying.)
   - `ADMIN_RECOVERY` — leave unset. `1` lets the admin add a new passkey
     after losing theirs (see "The admin"); remove it again afterwards.
   - `SESSION_SECRET` — a long random string (e.g. `openssl rand -hex 32`).
     Recommended, not strictly required: if unset, one is derived
     deterministically from `ADMIN_PASSWORD` instead of being randomized,
     so sessions still survive restarts/redeploys/extra replicas either
     way. Set it explicitly so that changing `ADMIN_PASSWORD` later
     doesn't also silently log everyone out.
3. Add a **persistent volume** — this is where `canopy.db` (showtimes,
   seats, friends' profiles and concession orders), profile photos, the
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
   domain is the editor.
6. Deploy. Visit `<app URL>`, enter your `ADMIN_PASSWORD` as the
   setup password, set up your profile and passkey (that's the admin), then
   add a movie, give it a password, and add its showtimes.

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
profiles, photos, payment handles, the concessions menu, and uploaded
images survive a redeploy, so this check covers all of it.

## Storage & backups

Showtimes, seats and orders are in `DATA_DIR/canopy.db` (SQLite). The
other settings and the uploaded images are still files next to it.

**Moving off `showtimes.json`.** The first start of a version with SQLite
imports `showtimes.json` into `canopy.db`:

1. It copies `showtimes.json` to `backups/pre-sqlite-<time>/` first.
2. It imports everything into a temporary database, then reads every
   showtime back and compares it with the original, field by field and
   seat by seat. Only a database that matches exactly is moved into
   place. Any difference, and the temporary file is deleted, the problem
   is logged, and the app keeps running on `showtimes.json` exactly as
   before; the next start tries again.
3. `showtimes.json` itself is never modified, renamed or deleted. After a
   successful import it simply isn't read any more.

The log says which happened. Success looks like:

```
[canopy-tickets] Moved showtimes.json into SQLite (/app/data/canopy.db): 12 showtime(s) across 4 movie(s), ...
```

Failure is a line starting `!!! SQLite store unavailable`. If a later
start logs `!!! showtimes.json has changed since it was moved into
SQLite`, something wrote to the JSON after the import (most likely the
old container, still running during the deploy, took a reservation).
That change is not in the database, and the message says where to look.

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

**Rolling back** to a version from before SQLite is possible (it reads
`showtimes.json`, which is untouched), but anything changed since the
import exists only in `canopy.db` and won't be there.
