const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const store = require('./lib/store');
const { createImageStore } = require('./lib/uploadedImage');
const posterStore = require('./lib/posterStore');
const sharedPasswordStore = require('./lib/sharedPassword');
const concessionMenuStore = require('./lib/concessionMenu');
const { createTextSettingStore } = require('./lib/textSetting');
const { createPasswordAuth } = require('./lib/auth');
const { normalizeSeats, normalizeSeatEntry } = require('./lib/seats');

const ogImageStore = createImageStore('og');
const logoImageStore = createImageStore('logo');

// Replaces the old HOST_VENMO env var: like the friend password, these are
// admin-settable from the editor UI (below the showtimes list) instead of
// fixed at deploy time, and either/both/neither can be set -- the
// reservation page only shows a pay button for the one(s) that are.
const venmoHandleStore = createTextSettingStore('venmo-handle');
const cashappHandleStore = createTextSettingStore('cashapp-handle');

const app = express();
const PORT = process.env.PORT || 3000;

// Coolify (or any reverse proxy) terminates TLS in front of this
// container, so the request Express sees is plain HTTP. Trusting the
// proxy makes req.protocol correctly report "https" from
// X-Forwarded-Proto -- needed so the Open Graph tags below don't
// accidentally advertise an http:// URL for a site that's actually https.
app.set('trust proxy', true);

function requireEnvPassword(envVar, label) {
  let value = process.env[envVar];
  if (!value) {
    value = crypto.randomBytes(9).toString('base64url');
    console.warn(`\n[canopy-tickets] ${envVar} not set. Generated a temporary ${label} password for this run:`);
    console.warn(`[canopy-tickets]   ${value}`);
    console.warn(`[canopy-tickets] Set ${envVar} in your environment to keep a stable password.\n`);
  }
  return value;
}

const ADMIN_PASSWORD = requireEnvPassword('ADMIN_PASSWORD', 'admin');

// Unlike ADMIN_PASSWORD, the friend/shared password is NOT an env var --
// it's set from the admin editor UI (below the showtimes list) and
// persisted via sharedPasswordStore, so it can be rotated without a
// redeploy (e.g. a fresh password per movie). If it's never been set,
// friend login is simply off: the login check below only matches against
// it when sharedPasswordStore.get() returns something truthy.
if (!sharedPasswordStore.get()) {
  console.warn(
    '[canopy-tickets] No friend/shared password set yet -- friend login is off until one is set from the admin editor.'
  );
}

// This MUST be the same value on every process that ever serves this app
// -- a random-per-process fallback (what this used to do) is actively
// dangerous: any redeploy, restart, or additional replica gets its own
// secret, so a cookie signed by one process fails verification on the
// next request if it lands on another. That's not just "sessions don't
// survive a restart" -- it manifests as random login/logout redirect
// loops mid-session, because the page-serving check and an API call a
// moment later can literally be answered by two different secrets.
//
// If SESSION_SECRET isn't set, derive a stable one from ADMIN_PASSWORD
// instead of generating randomness -- that's already required to be
// stable across the deployment for login to work at all, so this can't
// newly introduce an inconsistency. (The friend/shared password is
// deliberately NOT part of this derivation -- it's meant to be rotated
// freely without side effects, and doing so would log everyone out.)
// Still recommend setting SESSION_SECRET explicitly (see README) so
// changing ADMIN_PASSWORD later doesn't also silently invalidate every
// existing session.
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.createHash('sha256').update(`canopy-tickets:${ADMIN_PASSWORD}`).digest('hex');
if (!process.env.SESSION_SECRET) {
  console.warn(
    '[canopy-tickets] SESSION_SECRET not set; derived a stable one from ADMIN_PASSWORD instead. ' +
      'This works, but changing ADMIN_PASSWORD will also silently log everyone out -- set SESSION_SECRET ' +
      'explicitly (e.g. `openssl rand -hex 32`) to decouple the two.'
  );
}

const adminAuth = createPasswordAuth('canopy_admin', SESSION_SECRET);
const sharedAuth = createPasswordAuth('canopy_shared', SESSION_SECRET);

app.disable('x-powered-by');
app.use(express.json());

// Surface whether persistence looks durable as soon as the process comes
// up -- the #1 way this app loses data is a container platform (Coolify,
// etc.) redeploying onto a fresh filesystem because no volume is mounted
// at DATA_DIR. If that's happening, this count silently resets to 0 on
// every deploy even though you keep adding showtimes.
{
  const resolvedDataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const existingCount = store.listShowtimes().length;
  console.log(`[canopy-tickets] DATA_DIR=${resolvedDataDir} (${existingCount} showtime(s) found on disk at startup)`);
  if (existingCount === 0) {
    console.log(
      '[canopy-tickets] If you expected existing showtimes here, DATA_DIR is probably NOT on a persistent ' +
        'volume -- see README.md > Deploying on Coolify > persistent volume.'
    );
  }
}

function checkPassword(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Earliest showing first -- used for both the admin list and the public
// list, so the order matches everywhere showtimes are shown.
function byShowtime(a, b) {
  return `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`);
}

// Accepts a number or numeric string (e.g. "16.49"); returns null for
// anything blank/invalid, otherwise a value rounded to the nearest cent.
function parsePrice(raw) {
  if (raw === '' || raw === undefined || raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

// California normally exempts cold food to go -- a candy bar or a bottled
// drink from a shop isn't taxed. Concessions at a cinema are the
// exception: food sold where admission is charged is taxable regardless
// of what it is or whether it's hot (Reg. 1603). So this applies to the
// whole concessions subtotal rather than trying to sort popcorn from
// candy, which is both simpler and closer to what the receipt says.
//
// The ticket itself isn't in it -- California doesn't tax admissions, and
// the price on a showtime is what the host already paid AMC anyway.
//
// APPROXIMATE, and meant to be: it's San Francisco's combined state,
// county and district rate, which moves every few years and is one number
// to edit here when it does. It exists so nobody is surprised at the
// counter by a bill a few dollars over what the app quoted, not to be an
// accounting system.
const CONCESSION_TAX_RATE = 0.08625; // San Francisco, CA

// Every showtime needs an auditorium/seat-map now, keyed by a
// theater+auditorium id (see public/seat-layout.js -- SEAT_LAYOUTS keys
// look like "amc-metreon-16", since a bare auditorium number only means
// something within one specific theater). This constant is kept in sync
// by hand with the same-named one there, since that file is browser-only
// and can't be required from here.
//
// DEFAULT_SCREEN is IMAX at Metreon -- every showtime made before this
// field existed gets treated as that wherever it's read (see the
// `|| DEFAULT_SCREEN` fallbacks below), so nothing needs a one-time
// migration: an old record with no `screen` on disk just keeps rendering
// the IMAX map it always implicitly meant, forever, unless the admin
// re-saves it with a different one.
const DEFAULT_SCREEN = 'amc-metreon-16';
function normalizeScreenInput(raw) {
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 60);
  return DEFAULT_SCREEN;
}

// Builds the Open Graph / Twitter Card <meta> tags for the link-preview
// shown by iMessage, Facebook, Instagram, etc. when tix.canopysf.com gets
// shared. Same title/description everywhere on purpose -- there's one
// link, this is its identity regardless of which page an anonymous
// request happens to resolve to (in practice, always the login page,
// since crawlers never carry a session cookie).
//
// The image URL includes `?v=<uploadedAt>`, which changes every time a
// new image is uploaded. That's a deliberate cache-bust: platforms like
// Facebook cache a scraped preview keyed by URL and can hold onto it for
// a long time (there's a manual "Sharing Debugger" to force a re-scrape,
// but nothing server-side can compel it), so re-uploading only actually
// changes what people see if the URL itself changes too.
function buildOgTags(req) {
  const pageUrl = `${req.protocol}://${req.get('host')}/`;
  const tags = [
    '<meta property="og:title" content="Canopy Tickets">',
    '<meta property="og:description" content="Reserve your seats here">',
    '<meta property="og:type" content="website">',
    `<meta property="og:url" content="${pageUrl}">`
  ];
  const meta = ogImageStore.getMeta();
  if (meta) {
    const imageUrl = `${req.protocol}://${req.get('host')}/og-image?v=${meta.uploadedAt}`;
    tags.push(
      `<meta property="og:image" content="${imageUrl}">`,
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:image" content="${imageUrl}">`
    );
  }
  return tags.join('\n  ');
}

// Builds the site logo <img>, or '' if none has been uploaded yet (in
// which case the page just shows without one -- no broken-image icon).
// Same cache-busting reasoning as the OG image: the URL changes on every
// upload so browsers can't keep showing a stale cached logo.
function buildLogoImgTag() {
  const meta = logoImageStore.getMeta();
  if (!meta) return '';
  return `<img src="/logo-image?v=${meta.uploadedAt}" alt="Canopy Tickets" class="site-logo">`;
}

// A `Cache-Control: no-cache` header on the static file itself only helps
// if the browser actually revalidates it -- and Safari (iOS and desktop
// alike) has repeatedly been caught serving straight from its cache
// without so much as a conditional GET, no-cache header or not. The only
// fix that doesn't depend on trusting Safari's cache behavior is a
// version-busted URL, same as the logo/OG images already do: change the
// URL and there's nothing left *to* revalidate, it's just a cache miss.
// Computed once at startup from the file's mtime, which changes on every
// deploy (a fresh container gets a freshly-written file), so this never
// needs a manual bump.
const SEAT_LAYOUT_JS_VERSION = fs.statSync(path.join(__dirname, 'public', 'seat-layout.js')).mtimeMs;

// Sends a static HTML file with its `<!-- OG_META -->` (in <head>) and
// `<!-- LOGO_IMG -->` (in <body>, wherever the page wants the logo to
// appear) placeholders replaced with the real thing, and its
// `seat-layout.js` reference cache-busted (see SEAT_LAYOUT_JS_VERSION
// above). The OG tags in particular have to be in the initial server
// response, not injected by client-side JS -- link-preview crawlers don't
// run JavaScript.
//
// The page itself is sent `no-store`: it's rendered fresh server-side on
// every request anyway (session-gated, never the same for two visitors),
// so there's no reason to let a browser cache it -- and caching it is
// exactly what let an old page keep pointing at a stale seat-layout.js
// URL in the first place.
function renderHtmlPage(res, req, filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(
    html
      .replace('<!-- OG_META -->', buildOgTags(req))
      .replace('<!-- LOGO_IMG -->', buildLogoImgTag())
      .replace('src="/seat-layout.js"', `src="/seat-layout.js?v=${SEAT_LAYOUT_JS_VERSION}"`)
  );
}

// Poster art is looked up by title (see lib/posterStore.js), not stored
// on the showtime itself -- so every showtime sharing a title
// automatically gets the same poster the moment one's uploaded for it.
// Returns null (not a broken-image URL) if nothing's been uploaded for
// this exact title yet -- both admin.html and public.html treat a null
// posterUrl as "no poster, don't reserve space differently for it."
function posterUrlForTitle(title) {
  if (!title) return null;
  const meta = posterStore.getMetaByTitle(title);
  if (!meta) return null;
  return `/poster-image?key=${posterStore.keyFor(title)}&v=${meta.uploadedAt}`;
}

// Trims a showtime down to what a friend on the public/shared side should
// see: no full 377-seat auditorium map, just the block of seats the owner
// actually bought (each either claimed by a name or still open).
function publicShowtimeView(s) {
  const seats = normalizeSeats(s.seats);
  const blockSeats = {};
  Object.keys(seats).forEach((id) => {
    if (seats[id].status === 'assigned') {
      // Carts ride along with the seat list rather than sitting behind
      // their own endpoint: the reservation page shows every reserved
      // seat's order inline on the list, so a separate fetch per seat
      // would just be the same data in N round-trips.
      blockSeats[id] = { name: seats[id].name, paid: seats[id].paid, concessions: seats[id].concessions };
    }
  });
  return {
    id: s.id,
    title: s.title,
    theater: s.theater,
    date: s.date,
    time: s.time,
    format: s.format,
    screen: s.screen || DEFAULT_SCREEN,
    price: s.price,
    posterUrl: posterUrlForTitle(s.title),
    seats: blockSeats
  };
}

// ---------------- Auth (single password field, two possible outcomes) ----------------
//
// There's one login page and one password field. Which of the two
// passwords you type decides where you land -- ADMIN_PASSWORD opens the
// editor, the current friend/shared password (admin-settable, see below)
// opens the reservation page -- so the page never has to say "admin"
// anywhere. The two sessions are still fully separate cookies underneath;
// typing the admin password does not also grant shared access or vice versa.

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'password required' });
  }
  if (checkPassword(password, ADMIN_PASSWORD)) {
    adminAuth.issueSessionCookie(res);
    return res.json({ ok: true, role: 'admin' });
  }
  const currentSharedPassword = sharedPasswordStore.get();
  if (currentSharedPassword && checkPassword(password, currentSharedPassword)) {
    sharedAuth.issueSessionCookie(res);
    return res.json({ ok: true, role: 'shared' });
  }
  res.status(401).json({ error: 'invalid password' });
});

app.post('/api/logout', (req, res) => {
  adminAuth.clearSessionCookie(res);
  sharedAuth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  if (adminAuth.isAuthed(req)) return res.json({ authed: true, role: 'admin' });
  if (sharedAuth.isAuthed(req)) return res.json({ authed: true, role: 'shared' });
  res.json({ authed: false, role: null });
});

// ---------------- Friend password (admin auth required) ----------------
//
// Returns/sets the plaintext password, deliberately -- unlike
// ADMIN_PASSWORD, this one exists to be read back and handed to friends
// (texted, etc.), not kept secret from the admin viewing their own editor.

app.get('/api/shared-password', adminAuth.requireAuth('/'), (req, res) => {
  res.json({ password: sharedPasswordStore.get() });
});

app.post('/api/shared-password', adminAuth.requireAuth('/'), (req, res) => {
  const { password } = req.body || {};
  const trimmed = typeof password === 'string' ? password.trim().slice(0, 200) : '';
  const saved = sharedPasswordStore.set(trimmed || null);
  res.json({ ok: true, password: saved });
});

// ---------------- Payment handles (admin auth required) ----------------
//
// Replaces HOST_VENMO. Both are optional and independent -- leaving one
// blank just means the reservation page won't show a button for it.
// Stored without a leading @ (Venmo) or $ (Cash App), same convention as
// how each service's own share sheets display a handle; the leading
// character gets added back only when building the pay link/URL.

app.get('/api/payment-handles', adminAuth.requireAuth('/'), (req, res) => {
  res.json({ venmo: venmoHandleStore.get(), cashapp: cashappHandleStore.get() });
});

app.post('/api/payment-handles', adminAuth.requireAuth('/'), (req, res) => {
  const { venmo, cashapp } = req.body || {};
  const cleanVenmo = typeof venmo === 'string' ? venmo.trim().replace(/^@/, '').slice(0, 100) : '';
  const cleanCashapp = typeof cashapp === 'string' ? cashapp.trim().replace(/^\$/, '').slice(0, 100) : '';
  const savedVenmo = venmoHandleStore.set(cleanVenmo || null);
  const savedCashapp = cashappHandleStore.set(cleanCashapp || null);
  res.json({ ok: true, venmo: savedVenmo, cashapp: savedCashapp });
});

// ---------------- Concession menu (admin auth required to change) ----------------
//
// One global menu (see lib/concessionMenu.js for why it isn't per
// showtime). The admin editor posts the whole list back every save --
// there's no add/rename/delete-one endpoint, because the editor is a
// handful of rows on screen at once and a whole-list PUT is the only
// shape where reordering, renaming and deleting are all the same
// operation.

app.get('/api/concession-menu', adminAuth.requireAuth('/'), (req, res) => {
  // The rate rides along with the menu rather than getting an endpoint of
  // its own: the editor already fetches this at load, and the only thing
  // it needs the rate for is the order roll-up's total.
  res.json({ ...concessionMenuStore.get(), taxRate: CONCESSION_TAX_RATE });
});

app.post('/api/concession-menu', adminAuth.requireAuth('/'), (req, res) => {
  const { items, optionGroups } = req.body || {};
  if (items !== undefined && !Array.isArray(items)) {
    return res.status(400).json({ error: 'items must be an array' });
  }
  if (optionGroups !== undefined && !Array.isArray(optionGroups)) {
    return res.status(400).json({ error: 'optionGroups must be an array' });
  }
  // Echoing the saved list back matters: brand-new rows get their ids
  // assigned server-side, and the editor needs them to keep editing the
  // same row instead of creating a duplicate on the next save.
  res.json({ ok: true, ...concessionMenuStore.set(items || [], optionGroups || []), taxRate: CONCESSION_TAX_RATE });
});

// Throws away the saved menu so the built-in AMC list takes over again
// (see DEFAULT_ITEMS in lib/concessionMenu.js). Doesn't touch
// anyone's existing orders -- those carry their own copy of whatever
// they were placed against.
app.post('/api/concession-menu/reset', adminAuth.requireAuth('/'), (req, res) => {
  res.json({ ok: true, ...concessionMenuStore.reset(), taxRate: CONCESSION_TAX_RATE });
});

// ---------------- Showtimes API (admin auth required) ----------------

app.use('/api/showtimes', adminAuth.requireAuth('/'));

// Read-side fallback for showtimes saved before `screen` existed -- see
// the DEFAULT_SCREEN comment above. Also attaches posterUrl (see
// posterUrlForTitle) since the admin list needs it too, not just the
// public one.
function withScreenFallback(item) {
  return { ...item, screen: item.screen || DEFAULT_SCREEN, posterUrl: posterUrlForTitle(item.title) };
}

// A friend's cart lives on the seat, and the admin editor saves the WHOLE
// seats object -- so an editor page loaded before an order was placed
// would write that order right back off the record on its next save.
//
// The editor does round-trip carts it knows about (see normalizeSeatEntry
// in views/admin.html), so an incoming seat entry with no `concessions`
// key at all means one of two things: a stale/older client that never
// saw the cart, or a deliberate clear. The editor makes the deliberate
// case explicit by sending `concessions: []`, which leaves "key absent"
// meaning only "this client doesn't know", and that's the case we keep
// the stored cart for.
//
// This narrows the window but doesn't close it: an editor that loaded
// AFTER a cart existed and then saves stale contents still wins. Same
// last-write-wins story the seat names already have here, and the same
// reason it's acceptable -- one host, editing their own showtimes.
function preserveConcessions(incomingSeats, existingSeats) {
  const out = {};
  Object.keys(incomingSeats || {}).forEach((id) => {
    const incoming = incomingSeats[id];
    if (!incoming || typeof incoming !== 'object' || incoming.status !== 'assigned') {
      out[id] = incoming;
      return;
    }
    if (Array.isArray(incoming.concessions)) {
      out[id] = incoming;
      return;
    }
    const prior = normalizeSeatEntry(existingSeats && existingSeats[id]);
    const priorCart = prior && prior.status === 'assigned' ? prior.concessions : [];
    out[id] = priorCart.length ? { ...incoming, concessions: priorCart } : incoming;
  });
  return out;
}

app.get('/api/showtimes', (req, res) => {
  const items = store.listShowtimes().sort(byShowtime).map(withScreenFallback);
  res.json({ showtimes: items });
});

app.get('/api/showtimes/:id', (req, res) => {
  const item = store.getShowtime(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json({ showtime: withScreenFallback(item) });
});

app.post('/api/showtimes', async (req, res) => {
  const body = req.body || {};
  if (!body.seats || typeof body.seats !== 'object' || Array.isArray(body.seats)) {
    return res.status(400).json({ error: 'seats must be an object' });
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const obj = {
    id,
    title: String(body.title || 'Untitled').slice(0, 200),
    theater: String(body.theater || '').slice(0, 200),
    date: String(body.date || '').slice(0, 20),
    time: String(body.time || '').slice(0, 20),
    format: String(body.format || '').slice(0, 100),
    screen: normalizeScreenInput(body.screen),
    price: parsePrice(body.price),
    seats: body.seats,
    createdAt: now,
    updatedAt: now
  };
  await store.saveShowtime(id, obj);
  res.status(201).json({ showtime: obj });
});

app.put('/api/showtimes/:id', async (req, res) => {
  const existing = store.getShowtime(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const rawSeats =
    body.seats && typeof body.seats === 'object' && !Array.isArray(body.seats) ? body.seats : existing.seats;
  const seats = preserveConcessions(rawSeats, existing.seats);
  const obj = {
    ...existing,
    title: String(body.title ?? existing.title).slice(0, 200),
    theater: String(body.theater ?? existing.theater).slice(0, 200),
    date: String(body.date ?? existing.date).slice(0, 20),
    time: String(body.time ?? existing.time).slice(0, 20),
    format: String(body.format ?? existing.format).slice(0, 100),
    screen: body.screen !== undefined ? normalizeScreenInput(body.screen) : (existing.screen || DEFAULT_SCREEN),
    price: body.price !== undefined ? parsePrice(body.price) : existing.price,
    seats,
    updatedAt: Date.now()
  };
  await store.saveShowtime(req.params.id, obj);
  res.json({ showtime: obj });
});

app.delete('/api/showtimes/:id', async (req, res) => {
  const existed = await store.deleteShowtime(req.params.id);
  if (!existed) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ---------------- Public/shared API (shared auth required) ----------------

app.use('/api/public', sharedAuth.requireAuth('/'));

app.get('/api/public/config', (req, res) => {
  res.json({
    venmoHandle: venmoHandleStore.get(),
    cashappHandle: cashappHandleStore.get(),
    concessionTaxRate: CONCESSION_TAX_RATE
  });
});

app.get('/api/public/showtimes', (req, res) => {
  const items = store.listShowtimes().sort(byShowtime).map(publicShowtimeView);
  res.json({ showtimes: items });
});

app.post('/api/public/showtimes/:id/claim', async (req, res) => {
  const { seatId, name } = req.body || {};
  if (typeof seatId !== 'string' || !seatId) {
    return res.status(400).json({ error: 'seatId required' });
  }
  const trimmedName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
  if (!trimmedName) return res.status(400).json({ error: 'name required' });

  const result = await store.claimSeat(req.params.id, seatId, trimmedName);
  if (!result.ok) {
    if (result.reason === 'not_found') return res.status(404).json({ error: 'not found' });
    return res.status(409).json({ error: 'that seat is no longer available' });
  }
  res.json({ showtime: publicShowtimeView(result.showtime) });
});

// ---------------- Calendar invite ----------------
//
// Handed out as a real .ics file from a real URL rather than a data: URI
// or a Google Calendar link: a served text/calendar file is the one thing
// every phone knows what to do with (iOS offers "Add to Calendar", Android
// hands it to whichever calendar app is installed), and it doesn't assume
// anyone's calendar lives at a particular provider.
//
// Times are resolved against San Francisco's own clock, so a January
// showtime lands on PST and a July one on PDT with nobody picking which
// -- see showtimeInstantMs below.

// Three hours: long enough for trailers, the film and getting out, which
// is what the block on someone's calendar is actually for. Nothing here
// knows a film's real runtime.
const CALENDAR_EVENT_MINUTES = 180;

// RFC 5545 escaping for a text value: backslash first, or it would escape
// the escapes it just added.
function icsEscape(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Content lines are capped at 75 octets, continued with CRLF + a space.
// Measured in bytes, not characters -- a movie title with an accent or an
// emoji in it would otherwise fold a line one byte too late.
function icsFold(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > 73) {
      out.push(current);
      current = ' ';
      bytes = 1;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n');
}

// Every screen this app knows about is at AMC Metreon in San Francisco
// (see SEAT_LAYOUTS in public/seat-layout.js). When that stops being
// true, a showtime will need to carry its own timezone and this becomes
// a per-showtime lookup rather than a constant.
const SHOWTIME_TIMEZONE = 'America/Los_Angeles';

// How far the named zone was from UTC at a given instant, in ms.
// Formatting the instant AS that zone and reading the wall-clock fields
// back is the one way to get this without shipping a timezone database:
// Intl already has one.
function zoneOffsetMs(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  // hour comes back as 24 rather than 0 at midnight under hour12:false.
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - instantMs;
}

// A showtime's date and time are a wall clock in San Francisco. Resolve
// them to the actual instant, so the file says 7pm PST in January and 7pm
// PDT in July without anyone choosing which -- the zone's own rules pick.
//
// Two passes, because the offset needed to do the conversion is itself a
// function of the result: guess using the offset at the wall time read as
// UTC, then re-read the offset at the instant that produced and correct
// if the guess landed on the other side of a DST change.
function showtimeInstantMs(date, time) {
  const d = String(date || '').split('-').map(Number);
  const t = String(time || '').split(':').map(Number);
  if (d.length < 3 || t.length < 2 || d.some((n) => !Number.isFinite(n)) || t.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const wallAsUtc = Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1], 0, 0);
  if (!Number.isFinite(wallAsUtc)) return null;
  try {
    const firstGuess = wallAsUtc - zoneOffsetMs(wallAsUtc, SHOWTIME_TIMEZONE);
    const corrected = wallAsUtc - zoneOffsetMs(firstGuess, SHOWTIME_TIMEZONE);
    return corrected;
  } catch (e) {
    // No usable timezone data in this runtime. Better a calendar entry an
    // hour out than no calendar entry at all -- the caller falls back to
    // writing the wall time as UTC, which is right for anyone in UTC and
    // wrong by the offset for everyone else.
    return wallAsUtc;
  }
}

// UTC form, with the trailing Z that tells a calendar this is a real
// instant rather than "whatever 7pm means where you're standing".
function icsUtcStamp(instantMs, addMinutes) {
  const dt = new Date(instantMs + (addMinutes || 0) * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}T${p(dt.getUTCHours())}${p(
    dt.getUTCMinutes()
  )}00Z`;
}

app.get('/api/public/showtimes/:id/calendar.ics', (req, res) => {
  const show = store.getShowtime(req.params.id);
  if (!show) return res.status(404).json({ error: 'not found' });

  const instant = showtimeInstantMs(show.date, show.time);
  if (instant === null) return res.status(400).json({ error: 'this showtime has no usable date and time' });
  const start = icsUtcStamp(instant);
  const end = icsUtcStamp(instant, CALENDAR_EVENT_MINUTES);

  const seatId = typeof req.query.seat === 'string' ? req.query.seat.trim().slice(0, 12) : '';
  const title = show.title || 'Movie';
  const details = [seatId ? `Seat ${seatId}` : '', show.format, typeof show.price === 'number' ? `$${show.price.toFixed(2)}` : '']
    .filter(Boolean)
    .join(' \u00b7 ');

  // Stable per seat, so re-adding replaces the event someone already has
  // rather than leaving them with two.
  const uid = `${show.id}${seatId ? '-' + seatId.toLowerCase() : ''}@canopy-tickets`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//canopy-tickets//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsEscape(title)}`
  ];
  if (show.theater) lines.push(`LOCATION:${icsEscape(show.theater)}`);
  if (details) lines.push(`DESCRIPTION:${icsEscape(details)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');

  const body = lines.map(icsFold).join('\r\n') + '\r\n';
  const filename = (title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'showtime').toLowerCase();

  // attachment, not inline: it's what gets iOS to offer "Add to Calendar"
  // instead of rendering the file as text in the browser.
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}.ics"`);
  res.set('Cache-Control', 'no-store');
  res.send(body);
});

// The menu a friend picks from. Read-only on this side -- only the admin
// editor changes it (see /api/concession-menu above).
app.get('/api/public/concession-menu', (req, res) => {
  const menu = concessionMenuStore.get();
  // openSections is presentation config rather than menu data -- it isn't
  // part of what the host saves, so it comes straight off the constant
  // whether or not they've edited the menu.
  res.json({
    items: menu.items,
    optionGroups: menu.optionGroups,
    openSections: concessionMenuStore.DEFAULT_OPEN_SECTIONS
  });
});

// Replaces one reserved seat's concession cart.
//
// Deliberately NOT tied to "the person who claimed this seat": there's no
// per-friend identity in this app (one shared password, names typed in
// free-text at claim time), so anyone who can see the reservation page
// can edit any cart on it. That's the same trust model the rest of the
// friend side already runs on, and it's what makes "add mine to Jordan's
// while I'm at it" work at all.
//
// The 2-hour-before-showtime cutoff the page shows is enforced in the
// page, not here. The server can't evaluate it honestly: a showtime's
// date/time are stored as bare local strings with no timezone, and this
// process runs in a container that's almost certainly UTC -- so a
// server-side cutoff would lock a San Francisco showtime's carts seven
// or eight hours early. A client-side cutoff at least uses the friend's
// own clock, which is the same wall clock the showtime is written in.
app.put('/api/public/showtimes/:id/seats/:seatId/concessions', async (req, res) => {
  const { items } = req.body || {};
  if (items !== undefined && !Array.isArray(items)) {
    return res.status(400).json({ error: 'items must be an array' });
  }

  const result = await store.setSeatConcessions(req.params.id, req.params.seatId, items || []);
  if (!result.ok) {
    if (result.reason === 'not_found') return res.status(404).json({ error: 'not found' });
    return res.status(409).json({ error: 'that seat is not reserved yet' });
  }
  res.json({ showtime: publicShowtimeView(result.showtime) });
});

// ---------------- AMC API test (admin auth required, TEMPORARY) ----------------
//
// One-off diagnostic, not wired into any page. Checks whether AMC_API_KEY
// (set in Coolify, not available to this dev environment) can reach AMC's
// public API at all, and whether it exposes anything menu/concession/
// price-related for AMC Metreon 16 (SF) -- needed before building the
// actual friend-order-building feature. The concessions/menu paths below
// are guesses (AMC's public API isn't confirmed to expose that data at
// all); this just probes them and reports back real status codes/bodies
// instead of assuming. Hit /api/amc-test directly while logged in as
// admin, read the JSON, then this whole block should come back out --
// it's a debug tool, not a feature.
app.get('/api/amc-test', adminAuth.requireAuth('/'), async (req, res) => {
  const apiKey = process.env.AMC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AMC_API_KEY not set in this environment' });

  // Masked, not the raw key -- but enough to catch the #1 cause of "valid
  // key, still rejected": a stray newline/space from pasting it into
  // Coolify's env var field (trim() below would silently hide that, so
  // report the raw length instead of trimming).
  const keyDiagnostics = {
    length: apiKey.length,
    preview: apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '(too short to preview safely)',
    hasWhitespace: /^\s|\s$/.test(apiKey) || /\s/.test(apiKey)
  };

  const base = 'https://api.amctheatres.com/v2';
  const baseV1 = 'https://api.amctheatres.com/v1';

  async function tryFetch(label, url, headers) {
    try {
      const r = await fetch(url, { headers });
      const text = await r.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 2000);
      }
      return { label, url, status: r.status, body };
    } catch (err) {
      return { label, url, error: err.message };
    }
  }

  // First run tried X-AMC-Vendor-API-Key (a guess, wrong) and got the
  // exact same "requires vendor authentication" error a garbage key
  // gets. AMC's own docs (developers.amctheatres.com/GettingStarted/
  // Authentication, read via search since the portal blocks non-browser
  // fetches) confirm the real header is X-AMC-Vendor-Key -- keep the old
  // guesses in the variant probe too, purely to double check that switch
  // was in fact the fix rather than assuming it.
  const headerVariants = [
    ['X-AMC-Vendor-Key', { 'X-AMC-Vendor-Key': apiKey, Accept: 'application/json' }],
    ['X-AMC-Vendor-API-Key', { 'X-AMC-Vendor-API-Key': apiKey, Accept: 'application/json' }],
    ['Authorization: Bearer', { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }]
  ];
  const headerVariantResults = [];
  for (const [label, headers] of headerVariants) {
    headerVariantResults.push(await tryFetch(`header variant: ${label}`, `${base}/theatres?pageSize=1`, headers));
  }

  const headers = { 'X-AMC-Vendor-Key': apiKey, Accept: 'application/json' };
  const results = [];

  // AMC's Theatres API v2 docs confirm a `name` query param filters by
  // theatre name -- kept the raw/unfiltered call too as a sanity check.
  results.push(await tryFetch('theatres?name=Metreon', `${base}/theatres?name=Metreon`, headers));
  results.push(await tryFetch('theatres (raw, first page)', `${base}/theatres?pageSize=200`, headers));

  // Pull a Metreon theatre id out of whichever of the above actually
  // returned theatre objects.
  let theatreId = null;
  for (const r of results) {
    const list = r.body && r.body._embedded && r.body._embedded.theatres;
    if (Array.isArray(list)) {
      const match = list.find((t) => typeof t.name === 'string' && t.name.toLowerCase().includes('metreon'));
      if (match) {
        theatreId = match.id;
        break;
      }
    }
  }

  if (theatreId) {
    results.push(await tryFetch('theatre detail', `${base}/theatres/${theatreId}`, headers));
    // Real Concessions API v1 paths per AMC's docs (developers.amctheatres.com/ApiReference/concessions-api-v1),
    // not guesses -- this is the actual menu-items-with-prices endpoint.
    results.push(await tryFetch('concessions categories', `${baseV1}/theatres/${theatreId}/concessions/categories`, headers));
    results.push(await tryFetch('concessions (menu items + prices)', `${baseV1}/theatres/${theatreId}/concessions`, headers));
  }

  res.json({ apiKeyPresent: true, keyDiagnostics, headerVariantResults, theatreId, results });
});

// ---------------- Pages ----------------
//
// One front door. Whoever hits the root URL gets routed by which
// password they last typed in, not by which link they clicked: the admin
// editor if their session is admin-authed, the reservation page if
// shared-authed, otherwise the single login form. This is deliberate --
// the domain you hand out to friends and the one you use yourself are the
// same URL, so there's nothing "admin-flavored" to notice at a glance.
//
// admin.html and public.html live outside /public so they can never be
// fetched directly, bypassing the checks below.
app.get('/', (req, res) => {
  if (adminAuth.isAuthed(req)) {
    return renderHtmlPage(res, req, path.join(__dirname, 'views', 'admin.html'));
  }
  if (sharedAuth.isAuthed(req)) {
    return renderHtmlPage(res, req, path.join(__dirname, 'views', 'public.html'));
  }
  // The unauthenticated case is the one that actually matters for link
  // previews: a crawler hitting the shared URL never has a session
  // cookie, so this is the response it sees.
  renderHtmlPage(res, req, path.join(__dirname, 'public', 'login.html'));
});

// /reserve was the old dedicated friend-facing URL -- keep it working as
// a redirect in case it's already been shared anywhere.
app.get('/reserve', (req, res) => res.redirect('/'));

// ---------------- Site images (link-preview + logo) ----------------

const siteImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter(req, file, cb) {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// Wires up the GET (admin metadata)/POST (admin upload)/GET (public,
// no-auth file serve) trio for one named image store. The og-image and
// logo-image endpoints are identical apart from which store/URLs they use.
function mountImageRoutes(urlName, imageStore) {
  app.get(`/api/${urlName}`, adminAuth.requireAuth('/'), (req, res) => {
    const meta = imageStore.getMeta();
    res.json(meta ? { uploadedAt: meta.uploadedAt, url: `/${urlName}?v=${meta.uploadedAt}` } : { uploadedAt: null, url: null });
  });

  app.post(`/api/${urlName}`, adminAuth.requireAuth('/'), siteImageUpload.single('image'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'choose a PNG, JPEG, WebP, or GIF image' });
    }
    const meta = imageStore.save(req.file.buffer, req.file.mimetype);
    res.json({ ok: true, uploadedAt: meta.uploadedAt, url: `/${urlName}?v=${meta.uploadedAt}` });
  });

  // No auth -- the login page shows the logo (and link-preview crawlers
  // fetch the OG image) with no session, so both have to be reachable by
  // anyone.
  app.get(`/${urlName}`, (req, res) => {
    const meta = imageStore.getMeta();
    if (!meta) return res.status(404).end();
    res.set('Content-Type', meta.mimeType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(imageStore.getFilePath());
  });
}

mountImageRoutes('og-image', ogImageStore);
mountImageRoutes('logo-image', logoImageStore);

// ---------------- Poster art (looked up/uploaded by title) ----------------
//
// Unlike og-image/logo-image (one fixed slot each), a poster is keyed by
// the showtime's title (see lib/posterStore.js) -- there's no fixed set
// of endpoints to mount, just one lookup/upload pair that takes a title,
// plus one serving route keyed by the opaque hash already embedded in
// posterUrl (see posterUrlForTitle above) rather than needing the title
// again.

app.get('/api/poster', adminAuth.requireAuth('/'), (req, res) => {
  const title = typeof req.query.title === 'string' ? req.query.title.trim() : '';
  if (!title) return res.status(400).json({ error: 'title required' });
  res.json({ url: posterUrlForTitle(title) });
});

app.post('/api/poster', adminAuth.requireAuth('/'), siteImageUpload.single('image'), (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!req.file) {
    return res.status(400).json({ error: 'choose a PNG, JPEG, WebP, or GIF image' });
  }
  posterStore.save(title, req.file.buffer, req.file.mimetype);
  res.json({ ok: true, url: posterUrlForTitle(title) });
});

// No auth -- posters show up on the friend-facing public page too, same
// reasoning as og-image/logo-image. `key` is the hash posterUrlForTitle
// already computed; this route never needs the raw title.
app.get('/poster-image', (req, res) => {
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const meta = key && posterStore.getMetaByKey(key);
  if (!meta) return res.status(404).end();
  res.set('Content-Type', meta.mimeType);
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(posterStore.getFilePathByKey(key));
});

// no-cache (not no-store) forces a conditional GET on every load instead
// of letting the browser silently reuse whatever it fetched last time --
// cheap at this app's scale, and it closes off a real bug class:
// public/seat-layout.js's shape changed across two closely-spaced
// deploys (a flat array -> a lookup keyed by number -> a lookup keyed by
// theater+auditorium), and a browser holding an old cached copy against
// the new HTML made the seat map silently render nothing, with no error
// visible anywhere -- confirmed by the same page working fine in a
// private/incognito window (no cache) when this first happened.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res) {
      res.set('Cache-Control', 'no-cache');
    }
  })
);

// Catches multer's upload errors (bad file type, over the size limit) and
// returns clean JSON instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'image is too large (5MB max)' : err.message });
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`canopy-tickets listening on port ${PORT}`);
});
