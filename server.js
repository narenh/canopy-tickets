const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const store = require('./lib/store');
const { createImageStore } = require('./lib/uploadedImage');
const posterStore = require('./lib/posterStore');
const concessionMenuStore = require('./lib/concessionMenu');
const { createTextSettingStore } = require('./lib/textSetting');
const createCanopyAccount = require('./lib/canopyAccount');
const { normalizeSeats, isHostSeat, CONCESSION_TAX_RATE } = require('./lib/seats');

const ogImageStore = createImageStore('og');
const logoImageStore = createImageStore('logo');

// Admin-settable from the admin's Settings tab, and
// either/both/neither can be set -- the
// reservation page only shows a pay button for the one(s) that are.
const venmoHandleStore = createTextSettingStore('venmo-handle');
const cashappHandleStore = createTextSettingStore('cashapp-handle');
// The admin's phone, copied from their Canopy account whenever they visit
// (see attachPerson): A-List members text it to set up a swap.
const adminPhoneStore = createTextSettingStore('admin-phone');

const app = express();
const PORT = process.env.PORT || 3000;

// Coolify (or any reverse proxy) terminates TLS in front of this
// container, so the request Express sees is plain HTTP. Trusting the
// proxy makes req.protocol correctly report "https" from
// X-Forwarded-Proto -- needed so the Open Graph tags below don't
// accidentally advertise an http:// URL for a site that's actually https,
// and so "come back here after signing in" says https (the account
// service won't send anyone back to an http address).
app.set('trust proxy', true);

// ---------------- Canopy accounts ----------------
//
// Signing in and out, and everyone's name, photo and Venmo, belong to the
// Canopy account service (account.canopysf.com), shared by every Canopy
// site. Its cookie is for all of canopysf.com, so it reaches this site
// too, and lib/canopyAccount.js asks the service who it belongs to.
// Tickets keeps its own row per person (people, same id) for everything
// that's tickets' business: seats, unlocks, favorites, the peanut setting.
//
// CANOPY_ACCOUNT_KEY is this site's key, from the account admin's Sites
// tab. Without it nobody can be signed in, so the server says so loudly
// and treats everyone as signed out rather than refusing to start.
const CANOPY_ACCOUNT_URL = (process.env.CANOPY_ACCOUNT_URL || 'https://account.canopysf.com').replace(/\/+$/, '');
const CANOPY_ACCOUNT_KEY = process.env.CANOPY_ACCOUNT_KEY || '';
// With no key, the placeholder only feeds signInUrl/signOutUrl: attach
// and people are swapped out below, so it's never sent anywhere.
const canopy = createCanopyAccount({ url: CANOPY_ACCOUNT_URL, key: CANOPY_ACCOUNT_KEY || 'unset' });
if (!CANOPY_ACCOUNT_KEY) {
  console.error('\n[canopy-tickets] ****************************************************************');
  console.error('[canopy-tickets] CANOPY_ACCOUNT_KEY is not set. NOBODY CAN SIGN IN until it is.');
  console.error("[canopy-tickets] Make one in the account admin's Sites tab (site name: tickets),");
  console.error('[canopy-tickets] set it in this server\'s environment and redeploy.');
  console.error('[canopy-tickets] ****************************************************************\n');
  canopy.attach = (req, res, next) => { req.person = null; next(); };
  canopy.people = async () => { throw new Error('CANOPY_ACCOUNT_KEY is not set'); };
}

app.disable('x-powered-by');

// Anything that changes something (not GET, HEAD or OPTIONS) has to come
// from one of this site's own pages. The account cookie goes to every
// *.canopysf.com site, and its SameSite=Lax treats all of them as the
// same site, so a page on any other Canopy subdomain could otherwise
// send a signed-in POST here. Browsers put Origin on every POST, PUT,
// PATCH and DELETE (the pages' fetches are all relative URLs), so a
// missing one is refused too. `https://` + this host also counts, in
// case the proxy in front ever reports the request as plain http.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const host = req.get('host');
  if (origin && (origin === `${req.protocol}://${host}` || origin === `https://${host}`)) return next();
  res.status(403).json({ error: 'that request did not come from this site', reason: 'bad_origin' });
});
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

// CONCESSION_TAX_RATE lives in lib/seats.js now, because settling a cart
// needs its tax-inclusive total and that calculation belongs next to the
// subtotal it builds on. The reasoning for the number is there.
//
// California normally exempts cold food to go -- a candy bar or a bottled
// drink from a shop isn't taxed. Concessions at a cinema are the
// exception: food sold where admission is charged is taxable regardless
// of what it is or whether it's hot (Reg. 1603). So it applies to the
// whole concessions subtotal rather than trying to sort popcorn from
// candy, which is both simpler and closer to what the receipt says. The
// ticket itself isn't in it -- California doesn't tax admissions, and the
// price on a showtime is what the host already paid AMC anyway.

// Every showtime needs an auditorium/seat-map now, keyed by a
// theater+auditorium id (see public/seat-layout.js -- SEAT_LAYOUTS keys
// look like "amc-metreon-16", since a bare auditorium number only means
// something within one specific theater). This constant is kept in sync
// by hand with the same-named one there, since that file is browser-only
// and can't be required from here.
//
// DEFAULT_SCREEN is IMAX at Metreon -- a showtime with no screen saved
// (made before this field existed, or without one picked) is treated as
// that wherever it's read (see the `|| DEFAULT_SCREEN` fallbacks below).
const DEFAULT_SCREEN = 'amc-metreon-16';
function normalizeScreenInput(raw) {
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 60);
  return DEFAULT_SCREEN;
}

// Optional free-text note about one showing -- "Japanese Spoken", "Open
// Caption", "Fan event" -- shown to friends on the showtime's card. Blank
// is the normal case and means nothing gets shown.
function normalizeInfoInput(raw) {
  return typeof raw === 'string' ? raw.trim().slice(0, 120) : '';
}

// Builds the Open Graph / Twitter Card <meta> tags for the link-preview
// shown by iMessage, Facebook, Instagram, etc. when tix.canopysf.com gets
// shared. Same title/description everywhere on purpose -- there's one
// link, this is its identity regardless of which page an anonymous
// request happens to resolve to (in practice, always the signed-out page
// that sends people on to sign in, since crawlers never carry a cookie).
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
// Same-origin, cache-busted URL of the link-preview image, or '' if none
// has been uploaded. The sign-in page uses it as its backdrop.
function ogImageUrl() {
  const meta = ogImageStore.getMeta();
  return meta ? `/og-image?v=${meta.uploadedAt}` : '';
}

function buildLogoImgTag() {
  const meta = logoImageStore.getMeta();
  if (!meta) return '';
  return `<img src="/logo-image?v=${meta.uploadedAt}" alt="Canopy Tickets" class="site-logo">`;
}

// The app's own scripts go inside each page rather than being fetched
// from separate URLs, so a page and its scripts always come from the same
// copy of the app.
//
// Fetching them separately kept going stale. Cloudflare sits in front of
// the site and gives .js files a 4-hour browser cache whatever this server
// says (it answers `max-age=14400` to the app's `no-cache`). Versioned
// URLs mostly got around that, until a deploy: for a few seconds the new
// container serves pages asking for the new version while the old one is
// still answering, a phone gets the OLD file under the NEW url, and keeps
// it for four hours -- which is how a sign-up page came up showing
// "welcome.tagline" instead of its text. Inlined, there's no second
// request to land on the wrong container or sit in anyone's cache.
//
// Read once at startup (they only change with a deploy). Anything else
// that loads them (a stale page, a bookmark) still gets the files from
// /public as before.
//
// A versioned vendor path can't be the wrong version, but it can be
// MISSING: a brand-new file asked for during a deploy can land on the old
// container, 404, and that 404 is kept for the same four hours. That's
// how the passkey library went missing on an iPhone the day it shipped,
// back when sign-in was here. So a new vendored script belongs in this
// list too.
const INLINE_SCRIPTS = [
  'copy.js', 'seat-layout.js', 'vendor/simplewebauthn-browser-14.0.0/index.umd.min.js'
].map((name) => {
  // `</script` inside the source would end the inline tag early.
  const source = fs.readFileSync(path.join(__dirname, 'public', name), 'utf8').replace(/<\/script/gi, '<\\/script');
  return { tag: `<script src="/${name}"></script>`, inline: `<script>/* ${name} */\n${source}\n</script>` };
});

// Sends a static HTML file with its `<!-- OG_META -->` (in <head>) and
// `<!-- LOGO_IMG -->` (in <body>, wherever the page wants the logo to
// appear) placeholders replaced with the real thing, and the app's own
// scripts inlined (see INLINE_SCRIPTS above). The OG tags in particular
// have to be in the initial server response, not injected by client-side
// JS -- link-preview crawlers don't run JavaScript.
//
// The page itself is sent `no-store`: it's rendered fresh server-side on
// every request anyway (session-gated, never the same for two visitors).
// (Cloudflare doesn't cache HTML, so this one is honored.)
//
// `values` fills `__NAME__` placeholders, attribute-escaped (the sign-in
// page's account URLs).
function renderHtmlPage(res, req, filePath, values = {}) {
  const logoTag = buildLogoImgTag();
  let html = fs.readFileSync(filePath, 'utf8')
    .replace('<!-- OG_META -->', buildOgTags(req))
    .replaceAll('<!-- LOGO_IMG -->', () => logoTag);
  Object.entries(values).forEach(([name, value]) => {
    html = html.replaceAll(`__${name}__`, () => escapeAttr(value));
  });
  INLINE_SCRIPTS.forEach(({ tag, inline }) => {
    // A function, so `$` in a script isn't read as a replacement pattern.
    html = html.replace(tag, () => inline);
  });
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(html);
}

// A poster belongs to a movie (movies.poster_key, see lib/sqliteStore.js),
// so every showtime of the movie shows it, and renaming the movie keeps
// it. Returns null (not a broken-image URL) if the movie has none yet --
// both admin.html and public.html treat a null posterUrl as "no poster".
function posterUrlForKey(key) {
  if (!key) return null;
  const meta = posterStore.getMetaByKey(key);
  if (!meta) return null;
  return `/poster-image?key=${key}&v=${meta.uploadedAt}`;
}

// Looks people up at most once per request -- a showtime's seats name the
// same few people over and over.
function peopleLookup() {
  const cache = new Map();
  return (id) => {
    if (!id) return null;
    if (!cache.has(id)) cache.set(id, store.getPerson(id));
    return cache.get(id);
  };
}

// Photos live at the account service. An <img> on this site loads them
// from there: the browser sends the account cookie along, since it counts
// account.canopysf.com as the same site. photoAt is the photo's ?v= there,
// so the URL changes whenever the photo does.
function photoUrlFor(person) {
  return person && person.photoAt ? `${CANOPY_ACCOUNT_URL}/photo/${person.id}?v=${person.photoAt}` : null;
}

// Trims a showtime down to what a friend on the public/shared side should
// see: no full 377-seat auditorium map, just the block of seats the owner
// actually bought (each either claimed by a name or still open).
//
// `viewer` is the signed-in person, so their own seats can say so.
// `onlySeatIds`, when given, limits the seats to those (a movie this
// person hasn't unlocked shows its viewer their own seats and nobody
// else's).
// A friend can give back a seat they reserved while all of these hold:
// nothing on it is paid, they reserved it in the last 24 hours, and the
// showtime is still more than 24 hours off. Seats from before
// reservations were timed (no reservedAt) never qualify.
const RELEASE_WINDOW_MS = 24 * 60 * 60 * 1000;

function canReleaseSeat(show, raw, viewer, now) {
  if (!viewer || !raw || raw.personId !== viewer.id) return false;
  if (raw.paid || raw.concessionsPaid || !raw.reservedAt) return false;
  if (now - raw.reservedAt > RELEASE_WINDOW_MS) return false;
  const start = showtimeInstantMs(show.date, show.time);
  return start !== null && start - now > RELEASE_WINDOW_MS;
}

// Seats either side of this one in the same row. Deliberately NOT the
// rows in front or behind: seat numbers don't line up across rows (row A
// is offset -- see padStart in seat-layout.js), so "same number, next
// row" is not the seat behind you, and guessing wrong here would be
// worse than the narrower answer.
function neighborSeatIds(seatId) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(seatId || '');
  if (!m) return [];
  const n = Number(m[2]);
  return [m[1] + (n - 1), m[1] + (n + 1)];
}

// Whether someone with a peanut allergy (ticked in their profile) sits in
// a seat next to this one -- their own seat, not a guest's they booked.
function nextToPeanutAllergy(s, seatId, person) {
  return neighborSeatIds(seatId).some((id) => {
    const raw = s.seats && s.seats[id];
    if (!raw || raw.status !== 'assigned' || !raw.personId || raw.guest) return false;
    const owner = person(raw.personId);
    return !!(owner && owner.peanutAllergy);
  });
}

function publicShowtimeView(s, viewer, onlySeatIds, lookup) {
  const person = lookup || peopleLookup();
  const now = Date.now();
  const seats = normalizeSeats(s.seats);
  const blockSeats = {};
  Object.keys(seats).forEach((id) => {
    if (onlySeatIds && !onlySeatIds.has(id)) return;
    if (seats[id].status === 'assigned') {
      const raw = (s.seats && s.seats[id]) || {};
      const owner = person(raw.personId);
      const mine = !!(viewer && raw.personId && raw.personId === viewer.id);
      // Carts ride along with the seat list rather than sitting behind
      // their own endpoint: the reservation page shows every reserved
      // seat's order inline on the list, so a separate fetch per seat
      // would just be the same data in N round-trips.
      blockSeats[id] = {
        name: seats[id].name,
        paid: seats[id].paid,
        // Dollars of concessions already settled, so the page can work
        // out what's still owed on a cart that grew after being paid for.
        concessionsPaid: seats[id].concessionsPaid,
        // The host's own seat owes nothing at all -- not the ticket and
        // not the concessions -- because they're the one paying for the
        // lot. `paid` alone only covers the ticket.
        host: isHostSeat(raw),
        concessions: seats[id].concessions,
        // Whose it is, without handing out ids: theirs, a guest someone
        // booked (and who), and the owner's photo for their own seat.
        mine,
        // Yours, and still yours to give back (see canReleaseSeat).
        canRelease: canReleaseSeat(s, raw, viewer, now),
        // Peanut items come off this seat's menu. Only worked out for your
        // own seats -- the cart is only ever yours -- so nobody's allergy
        // is handed to anyone else.
        nextToPeanutAllergy: mine && nextToPeanutAllergy(s, id, person),
        guest: !!raw.guest,
        via: raw.guest && owner ? owner.shortName : null,
        photoUrl: !raw.guest ? photoUrlFor(owner) : null
      };
    }
  });
  return {
    id: s.id,
    movieId: s.movieId,
    title: s.title,
    theater: s.theater,
    date: s.date,
    time: s.time,
    format: s.format,
    screen: s.screen || DEFAULT_SCREEN,
    price: s.price,
    info: s.info || '',
    posterUrl: posterUrlForKey(s.posterKey),
    // Set by the host when they go and place the order -- see the
    // orders-closed route below for why it isn't a clock.
    ordersClosed: !!s.ordersClosed,
    // A-List members swap into this one rather than paying for the ticket.
    aListSwap: !!s.aListSwap,
    seats: blockSeats
  };
}

// ---------------- Admin auth ----------------
//
// The admin is a person like any friend, signed in the same way, with
// the same id as the account service's admin. Which person it is lives in
// meta (admin_person_id); it's also the host (see lib/seats.js).

// Written only when it changes, so the admin's visits don't each write.
function rememberAdminPhone(phone) {
  const value = typeof phone === 'string' ? phone.trim() : '';
  if (value !== (adminPhoneStore.get() || '')) adminPhoneStore.set(value);
}

function adminFirstName() {
  const id = store.getAdminPersonId();
  const admin = id ? store.getPerson(id) : null;
  return admin ? admin.firstName : '';
}

function isAdmin(req) {
  return !!req.person && req.person.id === store.getAdminPersonId();
}

// For every admin API: signed in, as the admin.
function requireAdmin(req, res, next) {
  attachPerson(req, res, (err) => {
    if (err) return next(err);
    if (isAdmin(req)) return next();
    res.status(401).json({ error: 'unauthorized' });
  });
}

// ---------------- Payment handles (admin auth required) ----------------
//
// Both are optional and independent -- leaving one
// blank just means the reservation page won't show a button for it.
// Stored without a leading @ (Venmo) or $ (Cash App), same convention as
// how each service's own share sheets display a handle; the leading
// character gets added back only when building the pay link/URL.

app.get('/api/payment-handles', requireAdmin, (req, res) => {
  res.json({ venmo: venmoHandleStore.get(), cashapp: cashappHandleStore.get() });
});

app.post('/api/payment-handles', requireAdmin, (req, res) => {
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

app.get('/api/concession-menu', requireAdmin, (req, res) => {
  // The rate rides along with the menu rather than getting an endpoint of
  // its own: the editor already fetches this at load, and the only thing
  // it needs the rate for is the order roll-up's total.
  res.json({ ...concessionMenuStore.get(), taxRate: CONCESSION_TAX_RATE });
});

app.post('/api/concession-menu', requireAdmin, (req, res) => {
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
  const saved = concessionMenuStore.set(items || [], optionGroups || []);
  // A favorite whose item or option just left the menu goes for good.
  store.pruneAllFavorites((f) => cleanFavorites(f, saved));
  res.json({ ok: true, ...saved, taxRate: CONCESSION_TAX_RATE });
});

// Throws away the saved menu so the built-in AMC list takes over again
// (see DEFAULT_ITEMS in lib/concessionMenu.js). Doesn't touch
// anyone's existing orders -- those carry their own copy of whatever
// they were placed against.
app.post('/api/concession-menu/reset', requireAdmin, (req, res) => {
  const menu = concessionMenuStore.reset();
  store.pruneAllFavorites((f) => cleanFavorites(f, menu));
  res.json({ ok: true, ...menu, taxRate: CONCESSION_TAX_RATE });
});

// Image uploads (posters, logo, link preview): in memory, 5MB, images only.
const siteImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter(req, file, cb) {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ---------------- Movies & showtimes API (admin auth required) ----------------
//
// The editor saves as you go: a field at a time (PATCH a showtime) and a
// seat at a time (PUT/DELETE one seat). It used to send the whole
// showtime, seats and all, on Save -- which meant an editor opened before
// a friend's order could write that order back off the seat. Writing one
// seat can't touch any other, so that whole class of problem is gone.

app.use('/api/showtimes', requireAdmin);
app.use('/api/movies', requireAdmin);

// A showtime with no screen picked gets DEFAULT_SCREEN's -- see the
// comment there. Also attaches posterUrl.
function withScreenFallback(item) {
  return { ...item, screen: item.screen || DEFAULT_SCREEN, posterUrl: posterUrlForKey(item.posterKey) };
}

function movieView(m) {
  return { ...m, posterUrl: posterUrlForKey(m.posterKey) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const SEAT_ID_RE = /^[A-Za-z]{1,3}\d{1,3}$/;

// Validates the showtime fields present in `body` and returns them in
// stored form, or { error } for the first one that's wrong. Fields not in
// `body` are left out, so the same function serves a one-field PATCH and
// a whole new showtime.
function showtimeFields(body) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (has('theater')) out.theater = String(body.theater || '').trim().slice(0, 200);
  if (has('date')) {
    const d = String(body.date || '');
    if (d && !DATE_RE.test(d)) return { error: 'date must be YYYY-MM-DD' };
    out.date = d;
  }
  if (has('time')) {
    const t = String(body.time || '');
    if (t && !TIME_RE.test(t)) return { error: 'time must be HH:MM' };
    out.time = t;
  }
  if (has('format')) out.format = String(body.format || '').slice(0, 100);
  if (has('screen')) out.screen = normalizeScreenInput(body.screen);
  if (has('price')) out.price = parsePrice(body.price);
  if (has('info')) out.info = normalizeInfoInput(body.info);
  if (has('aListSwap')) {
    if (typeof body.aListSwap !== 'boolean') return { error: 'aListSwap must be a boolean' };
    out.aListSwap = body.aListSwap;
  }
  return { fields: out };
}

function sendResult(res, result, key) {
  if (result.ok) return res.json(key ? { [key]: result[key] } : { ok: true });
  const status = { not_found: 404, conflict: 409, has_showtimes: 409 }[result.reason] || 400;
  res.status(status).json({ error: result.reason, reason: result.reason });
}

app.get('/api/movies', (req, res) => {
  res.json({ movies: store.listMovies().map(movieView) });
});

app.get('/api/movies/:id', (req, res) => {
  const movie = store.getMovie(req.params.id);
  if (!movie) return res.status(404).json({ error: 'not found' });
  res.json({ movie: { ...movieView(movie), showtimes: movie.showtimes.map(withScreenFallback) } });
});

app.post('/api/movies', (req, res) => {
  const result = store.createMovie((req.body || {}).title);
  if (!result.ok) return sendResult(res, result);
  res.status(result.existed ? 200 : 201).json({ movie: movieView(result.movie), existed: result.existed });
});

// A title or a password, whichever is sent. A movie's password is shown
// back in plain text on purpose: it exists to be handed to friends.
app.patch('/api/movies/:id', (req, res) => {
  const body = req.body || {};
  let movie = null;
  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    const result = store.renameMovie(req.params.id, body.title);
    if (!result.ok) return sendResult(res, result);
    movie = result.movie;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'password')) {
    movie = store.setMoviePassword(req.params.id, body.password);
    if (!movie) return res.status(404).json({ error: 'not found' });
  }
  if (!movie) return res.status(400).json({ error: 'nothing to change' });
  res.json({ movie: movieView(movie) });
});

// ---------------- People (admin) ----------------
//
// Everyone tickets has a row for, to assign seats to. Names, photos and
// accounts themselves are managed at the account service, not here.
// Someone the account service no longer has is a former member: their
// row and seats stay, marked as such. If it can't be reached, nobody is
// marked rather than everybody.

app.use('/api/people', requireAdmin);

app.get('/api/people', async (req, res) => {
  const people = store.listPeople();
  let current = null;
  try {
    current = await canopy.people(people.map((p) => p.id));
  } catch (err) {
    console.warn(`[canopy-tickets] couldn't ask Canopy accounts who's still a member: ${err.message}`);
  }
  res.json({
    people: people.map((p) => {
      const former = !!current && !current.has(p.id);
      // A former member's photo went with their account.
      return { ...p, former, photoUrl: former ? null : photoUrlFor(p) };
    }),
    adminPersonId: store.getAdminPersonId()
  });
});

app.delete('/api/movies/:id', (req, res) => {
  sendResult(res, store.deleteMovie(req.params.id));
});

// A movie's own poster. Stored under a key made from the movie's id, so
// it doesn't matter what the movie is called now or later.
app.post('/api/movies/:id/poster', siteImageUpload.single('image'), (req, res) => {
  const movie = store.getMovie(req.params.id);
  if (!movie) return res.status(404).json({ error: 'not found' });
  if (!req.file) return res.status(400).json({ error: 'choose a PNG, JPEG, WebP, or GIF image' });
  const key = posterStore.keyFor(`movie:${movie.id}`);
  posterStore.saveByKey(key, req.file.buffer, req.file.mimetype, movie.title);
  res.json({ movie: movieView(store.setMoviePosterKey(movie.id, key)) });
});

app.post('/api/movies/:id/showtimes', (req, res) => {
  const { fields, error } = showtimeFields(req.body || {});
  if (error) return res.status(400).json({ error });
  const result = store.createShowtime(req.params.id, fields);
  if (!result.ok) return sendResult(res, result);
  res.status(201).json({ showtime: withScreenFallback(result.showtime) });
});

app.get('/api/showtimes', (req, res) => {
  const items = store.listShowtimes().sort(byShowtime).map(withScreenFallback);
  res.json({ showtimes: items });
});

app.get('/api/showtimes/:id', (req, res) => {
  const item = store.getShowtime(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json({ showtime: withScreenFallback(item) });
});

app.patch('/api/showtimes/:id', (req, res) => {
  const { fields, error } = showtimeFields(req.body || {});
  if (error) return res.status(400).json({ error });
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'nothing to change' });
  const result = store.patchShowtime(req.params.id, fields);
  if (!result.ok) return sendResult(res, result);
  res.json({ showtime: withScreenFallback(result.showtime) });
});

app.post('/api/showtimes/:id/duplicate', (req, res) => {
  const result = store.duplicateShowtime(req.params.id);
  if (!result.ok) return sendResult(res, result);
  res.status(201).json({ showtime: withScreenFallback(result.showtime) });
});

// One seat in your block: who it's for and whether they've paid. Their
// concession order isn't the editor's to change and stays on the seat
// unless the name is cleared (see setSeat in lib/sqliteStore.js).
app.put('/api/showtimes/:id/seats/:seatId', (req, res) => {
  if (!SEAT_ID_RE.test(req.params.seatId)) return res.status(400).json({ error: 'bad seat id' });
  const body = req.body || {};
  // personId: a profile id, null for a plain name, or left out to keep
  // whoever has the seat (see setSeat in lib/sqliteStore.js).
  if (body.personId !== undefined && body.personId !== null && typeof body.personId !== 'string') {
    return res.status(400).json({ error: 'personId must be a string or null' });
  }
  const result = store.setSeat(req.params.id, req.params.seatId, {
    name: typeof body.name === 'string' ? body.name : '',
    paid: !!body.paid,
    concessionsPaid: !!body.concessionsPaid,
    personId: body.personId,
    guest: !!body.guest
  });
  if (!result.ok) {
    if (result.reason === 'already_have_seat') return res.status(409).json({ error: result.reason, reason: result.reason });
    return sendResult(res, result);
  }
  res.json({ showtime: withScreenFallback(result.showtime) });
});

app.delete('/api/showtimes/:id/seats/:seatId', (req, res) => {
  if (!SEAT_ID_RE.test(req.params.seatId)) return res.status(400).json({ error: 'bad seat id' });
  const result = store.releaseSeat(req.params.id, req.params.seatId);
  if (!result.ok) return sendResult(res, result);
  res.json({ showtime: withScreenFallback(result.showtime) });
});

// Closing the cart is the host saying "I'm at the counter now" -- after
// this, friends can look at their orders but not change them.
//
// Deliberately a switch the host throws, not a clock. It used to be a
// cutoff two hours before showtime, which was wrong twice over: it could
// only ever be a guess at when the order actually gets placed, and it had
// to be evaluated in the browser, because a showtime's date and time are
// stored as bare local strings and this process runs somewhere
// effectively UTC -- so the server couldn't have enforced it honestly
// even if it wanted to. A flag it owns, it can.
app.post('/api/showtimes/:id/orders-closed', (req, res) => {
  const { closed } = req.body || {};
  if (typeof closed !== 'boolean') {
    return res.status(400).json({ error: 'closed must be a boolean' });
  }
  const result = store.patchShowtime(req.params.id, { ordersClosed: closed });
  if (!result.ok) return sendResult(res, result);
  res.json({ showtime: withScreenFallback(result.showtime) });
});

app.delete('/api/showtimes/:id', async (req, res) => {
  const existed = await store.deleteShowtime(req.params.id);
  if (!existed) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ---------------- Friends: who's signed in, and profiles ----------------
//
// Who someone is comes from their Canopy account (see the top of this
// file). Signing in, out, and changing a name, photo or Venmo all happen
// at the account service; what's left here is tickets' own: movie
// unlocks, which belong to the PERSON (person_unlocks) and follow them to
// every device, and the peanut allergy and AMC A-List settings.

// Too many tries at something, per key, per window. In memory: a restart
// forgives everyone, which is fine at this scale.
function attemptLimiter(max, windowMs) {
  const hits = new Map();
  return {
    blocked(key) {
      const h = hits.get(key);
      return !!h && Date.now() < h.reset && h.n >= max;
    },
    fail(key) {
      const now = Date.now();
      let h = hits.get(key);
      if (!h || now >= h.reset) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
      h.n++;
      if (hits.size > 10000) hits.forEach((v, k) => { if (now >= v.reset) hits.delete(k); });
    }
  };
}
const unlockLimiter = attemptLimiter(8, 15 * 60 * 1000);
const unlockIpLimiter = attemptLimiter(40, 15 * 60 * 1000);
// Across everyone, per movie: the
// backstop when the per-person and per-address limits are dodged with
// fresh profiles and addresses. Trips for everyone, which is the point.
const movieGuessLimiter = attemptLimiter(100, 60 * 60 * 1000);

// The visitor's address. Cloudflare puts the real one in CF-Connecting-IP
// and overwrites anything the visitor sent; X-Forwarded-For (what req.ip
// reads, with trust proxy on) keeps whatever the visitor put first, so
// limiting on req.ip alone could be dodged by sending a fake one.
function clientIp(req) {
  return req.get('cf-connecting-ip') || req.ip;
}

// Checks a movie password against every limit. 'ok', 'wrong' or
// 'limited'. `who` is the person (or browser) trying.
function checkMovieGuess(req, who, scope, isRight) {
  const key = `${who}:${scope}`;
  const ip = clientIp(req);
  if (unlockLimiter.blocked(key) || unlockIpLimiter.blocked(ip) || movieGuessLimiter.blocked(scope)) return 'limited';
  if (isRight()) return 'ok';
  unlockLimiter.fail(key);
  unlockIpLimiter.fail(ip);
  movieGuessLimiter.fail(scope);
  return 'wrong';
}

function sendGuessRefusal(res, outcome) {
  if (outcome === 'limited') return res.status(429).json({ error: 'too many tries -- wait a few minutes', reason: 'rate_limited' });
  // 403, not 401: the page reads a 401 as "you've been signed out".
  return res.status(403).json({ error: 'wrong password', reason: 'wrong_password' });
}

// Puts req.person (tickets' record of the signed-in visitor, or null) and
// req.unlocked (their movie ids) on the request. Each visit brings
// tickets' row up to date with their account: a new Canopy member gets
// one made (req.firstVisit), and a new name, photo or Venmo is copied in
// (lib/sqliteStore.js syncPerson). The account answer is cached for a
// minute (lib/canopyAccount.js), so a change there shows here within one.
//
// A database with no admin yet (a brand-new install) makes the first
// person to sign in the admin. On the live site the admin came across
// with everyone else, so this never happens there.
function attachPerson(req, res, next) {
  canopy.attach(req, res, (err) => {
    if (err) return next(err);
    const account = req.person;
    req.person = null;
    req.unlocked = new Set();
    req.firstVisit = false;
    if (!account) return next();
    try {
      const { person, created } = store.syncPerson(account, photoAtFrom(account.photoUrl));
      if (created) rememberFirstVisit(person.id);
      // A brand-new install's first person ever is its admin. Only then:
      // if the admin were somehow unset on a database with people in it,
      // the next friend to sign in must not become the admin.
      if (created && !store.getAdminPersonId() && store.listPeople().length === 1) {
        store.setAdminPersonId(person.id);
        console.warn(`[canopy-tickets] new install: ${person.email} is the first person here, so they're the admin`);
      }
      if (person.id === store.getAdminPersonId()) rememberAdminPhone(account.phone);
      req.person = person;
      req.firstVisit = created;
      req.unlocked = store.personUnlockedMovieIds(person.id);
    } catch (e) {
      return next(e);
    }
    next();
  });
}

// The ?v= on an account photoUrl (when the photo last changed), or null
// for someone with no photo.
function photoAtFrom(photoUrl) {
  if (!photoUrl) return null;
  try {
    const v = Number(new URL(photoUrl).searchParams.get('v'));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch (e) {
    return null;
  }
}

// A new Canopy member's first visit here is offered the seats reserved
// under their name before profiles ("Are any of these yours?"). Their row
// is usually made by the page load itself (GET /), a moment before the
// page asks /api/public/me who it is, so that's remembered here until
// /api/public/me reports it once. In memory: a restart in between just
// means no prompt, and "Claim existing seats" is still in the menu.
const FIRST_VISIT_MS = 10 * 60 * 1000;
const firstVisits = new Map();
function rememberFirstVisit(personId) {
  const now = Date.now();
  firstVisits.forEach((at, id) => { if (now - at > FIRST_VISIT_MS) firstVisits.delete(id); });
  firstVisits.set(personId, now);
}
function takeFirstVisit(personId) {
  const at = firstVisits.get(personId);
  firstVisits.delete(personId);
  return !!at && Date.now() - at < FIRST_VISIT_MS;
}

function meView(req) {
  return {
    person: req.person ? { ...req.person, photoUrl: photoUrlFor(req.person), isAdmin: isAdmin(req) } : null,
    unlockedMovieIds: Array.from(req.unlocked),
    firstVisit: !!req.firstVisit
  };
}

// Only what's tickets' own. Name, photo and Venmo are changed at the
// account service (the profile sheet links there).
app.patch('/api/profile', attachPerson, (req, res) => {
  if (!req.person) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  for (const key of ['peanutAllergy', 'amcAList']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      return res.status(400).json({ error: `${key} must be a boolean` });
    }
  }
  if (body.peanutAllergy !== undefined) req.person = store.setPersonPeanutAllergy(req.person.id, body.peanutAllergy);
  if (body.amcAList !== undefined) req.person = store.setPersonAmcAList(req.person.id, body.amcAList);
  res.json(meView(req));
});

// ---------------- Public API (signed-in friends) ----------------

app.use('/api/public', attachPerson, (req, res, next) => {
  if (!req.person) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/api/public/config', (req, res) => {
  res.json({
    venmoHandle: venmoHandleStore.get(),
    cashappHandle: cashappHandleStore.get(),
    concessionTaxRate: CONCESSION_TAX_RATE,
    // Where name, photo and Venmo are changed (the profile sheet's link).
    accountUrl: CANOPY_ACCOUNT_URL,
    // Who A-List members text to set up a swap, and the number to text.
    adminFirstName: adminFirstName(),
    adminPhone: adminPhoneStore.get() || ''
  });
});

// firstVisit: their row was made on this request or the page load just
// before it (see rememberFirstVisit). Reported once.
app.get('/api/public/me', (req, res) => {
  if (takeFirstVisit(req.person.id)) req.firstVisit = true;
  res.json(meView(req));
});

// Every movie with something scheduled, locked or not -- a locked one is
// its poster and title and nothing else.
app.get('/api/public/movies', (req, res) => {
  const movies = store.listMovies()
    .filter((m) => m.showtimeCount > 0)
    .map((m) => ({
      id: m.id,
      title: m.title,
      posterUrl: posterUrlForKey(m.posterKey),
      unlocked: req.unlocked.has(m.id),
      showtimeCount: m.showtimeCount,
      dates: m.dates
    }));
  res.json({ movies });
});

app.post('/api/public/movies/:id/unlock', (req, res) => {
  const movie = store.getMovie(req.params.id);
  if (!movie) return res.status(404).json({ error: 'not found' });
  if (req.unlocked.has(movie.id)) return res.json(meView(req));
  const { password } = req.body || {};
  const outcome = checkMovieGuess(req, req.person.id, movie.id,
    () => !!movie.password && checkPassword(String(password || ''), movie.password));
  if (outcome !== 'ok') return sendGuessRefusal(res, outcome);
  store.unlockMovieForPerson(req.person.id, movie.id);
  req.unlocked.add(movie.id);
  res.json(meView(req));
});

// Showtimes of the movies the signed-in person has unlocked.
app.get('/api/public/showtimes', (req, res) => {
  const lookup = peopleLookup();
  const items = store.listShowtimes()
    .filter((s) => req.unlocked.has(s.movieId))
    .sort(byShowtime)
    .map((s) => publicShowtimeView(s, req.person, null, lookup));
  res.json({ showtimes: items });
});

// The signed-in person's seats, theirs and their guests', in every movie
// -- read-only where they haven't unlocked the movie, and then only their
// own seats are included.
app.get('/api/public/mine', (req, res) => {
  const lookup = peopleLookup();
  const items = store.seatsOf(req.person.id).map(({ showtime, seatIds }) => {
    const unlocked = req.unlocked.has(showtime.movieId);
    return {
      unlocked,
      seatIds,
      showtime: publicShowtimeView(showtime, req.person, unlocked ? null : new Set(seatIds), lookup)
    };
  }).sort((a, b) => byShowtime(a.showtime, b.showtime));
  res.json({ items });
});

// A seat's order and payment are its owner's: your own seat, or a guest
// you booked. A seat reserved before profiles belongs to nobody until
// its person claims it (claim-existing), so nobody can change it here.
// Sends the refusal itself and returns false when it isn't yours.
function ownSeat(req, res, show) {
  const raw = (show.seats || {})[req.params.seatId];
  if (raw && raw.personId && raw.personId === req.person.id) return true;
  res.status(403).json({ error: 'that seat is not yours', reason: 'not_yours' });
  return false;
}

// Anything that changes a showtime needs its movie unlocked here. Sends
// the refusal itself and returns null when it doesn't.
function unlockedShowtime(req, res) {
  const show = store.getShowtime(req.params.id);
  if (!show) { res.status(404).json({ error: 'not found' }); return null; }
  if (!req.unlocked.has(show.movieId)) {
    res.status(403).json({ error: 'unlock this movie first', reason: 'locked' });
    return null;
  }
  return show;
}

// Reserves an open seat for the signed-in person, or -- with guestName --
// for someone they're bringing, which stays theirs to look after.
app.post('/api/public/showtimes/:id/claim', (req, res) => {
  if (!unlockedShowtime(req, res)) return;
  const { seatId, guestName } = req.body || {};
  if (typeof seatId !== 'string' || !seatId) {
    return res.status(400).json({ error: 'seatId required' });
  }
  const guest = typeof guestName === 'string' ? guestName.trim().slice(0, 80) : '';
  const name = guest || req.person.shortName;

  const result = store.claimSeat(req.params.id, seatId, name, { personId: req.person.id, guest: !!guest });
  if (!result.ok) {
    if (result.reason === 'not_found') return res.status(404).json({ error: 'not found' });
    if (result.reason === 'already_have_seat') {
      return res.status(409).json({ error: 'you already have a seat in this showtime -- this one needs a guest name', reason: 'already_have_seat' });
    }
    return res.status(409).json({ error: 'that seat is no longer available' });
  }
  res.json({ showtime: publicShowtimeView(result.showtime, req.person) });
});

// Does the name on an old seat look like this person? Its first word
// against their first name, ignoring case; one may be the start of the
// other ("Bob" / "Bobby") as long as the shorter is 3+ letters.
function seatNameMatches(seatName, firstName) {
  const a = String(seatName || '').trim().split(/\s+/)[0].toLowerCase();
  const b = String(firstName || '').trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

// Seats reserved before profiles existed, for "are these yours?": the
// ones under your name in ANY movie -- someone just signed up has nothing
// unlocked yet, and their old tickets are the first thing they need --
// plus every one in the movies you've unlocked, for a seat under a
// nickname. Claiming still takes each movie's password, so all this
// shows of a locked movie is that a seat under your name exists.
// anyUnclaimed: whether any such seat exists at all, for the "Claim your
// previous reservations" banner (shown to someone with no showtimes yet).
app.get('/api/public/claimable', (req, res) => {
  const all = store.claimableSeats();
  const seats = all.filter((x) => req.unlocked.has(x.movieId) || seatNameMatches(x.name, req.person.firstName));
  res.json({ seats, anyUnclaimed: all.length > 0 });
});

// Claims seats reserved before profiles, one movie per request, and
// ALWAYS with that movie's password typed right then -- even when they've
// unlocked the movie already. Taking over someone's old seat (and its
// order) is worth asking again for. Wrong passwords count against the
// same limits as unlocking.
app.post('/api/public/claim-existing', (req, res) => {
  const { movieId, password, seats } = req.body || {};
  if (typeof movieId !== 'string' || !Array.isArray(seats)) {
    return res.status(400).json({ error: 'movieId and seats are required' });
  }
  const movie = store.getMovie(movieId);
  if (!movie) return res.status(404).json({ error: 'not found' });
  const outcome = checkMovieGuess(req, req.person.id, movie.id,
    () => !!movie.password && checkPassword(String(password || ''), movie.password));
  if (outcome !== 'ok') return sendGuessRefusal(res, outcome);
  store.unlockMovieForPerson(req.person.id, movie.id);
  const items = seats.slice(0, 50).filter((x) => x && typeof x.showtimeId === 'string' && typeof x.seatId === 'string');
  // Only seats in this movie; any others in the list are skipped.
  const result = store.claimExistingSeats(req.person.id, items, new Set([movie.id]));
  if (!result.ok) return sendResult(res, result);
  res.json({ claimed: result.claimed });
});

// ---------------- Calendar (.ics) building ----------------
//
// For each person's subscribe-once calendar feed (below). Times are resolved against San Francisco's own clock, so a January
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

// One showtime as VEVENT lines, or null when it has no usable date and
// time. `seatText` goes first in the description ("Seat H4").
function icsEventLines(show, uid, seatText) {
  const instant = showtimeInstantMs(show.date, show.time);
  if (instant === null) return null;
  const details = [seatText, show.format, typeof show.price === 'number' ? `$${show.price.toFixed(2)}` : '']
    .filter(Boolean)
    .join(' \u00b7 ');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsUtcStamp(instant)}`,
    `DTEND:${icsUtcStamp(instant, CALENDAR_EVENT_MINUTES)}`,
    `SUMMARY:${icsEscape(show.title || 'Movie')}`
  ];
  if (show.theater) lines.push(`LOCATION:${icsEscape(show.theater)}`);
  if (details) lines.push(`DESCRIPTION:${icsEscape(details)}`);
  lines.push('END:VEVENT');
  return lines;
}

// A whole file around some events. `extra` is calendar-level properties
// (a feed's name and refresh interval).
function icsCalendar(eventLines, extra) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//canopy-tickets//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...(extra || []),
    ...eventLines,
    'END:VCALENDAR'
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

// ---------------- Calendar feed (per person) ----------------
//
// A calendar to SUBSCRIBE to rather than a file to import: every showtime
// the person has a seat in (theirs or a guest's), kept up to date as they
// reserve and as the host changes times -- the calendar app re-fetches it.
//
// Calendar apps fetch it without cookies, so the URL itself is the key:
// a random token per person (lib/sqliteStore.js calendarTokenFor). It
// shows the same thing My Showtimes does to anyone signed in as them --
// which showtimes and which seats -- and nothing else.
app.get('/api/public/calendar-feed', (req, res) => {
  const token = store.calendarTokenFor(req.person.id);
  if (!token) return res.status(404).json({ error: 'not found' });
  const host = req.get('host');
  // https outside development: behind the proxies req.protocol can read http.
  const local = /^(localhost|127\.0\.0\.1)$/.test(req.hostname);
  res.json({
    url: `${local ? req.protocol : 'https'}://${host}/calendar/feed/${token}.ics`,
    webcalUrl: `webcal://${host}/calendar/feed/${token}.ics`
  });
});

// The "Subscribe to your showtimes" banner on My Showtimes: dismissed, or
// its Subscribe tapped. Either way it stops showing for this person.
app.post('/api/public/calendar-prompt-done', (req, res) => {
  store.markCalendarPromptDone(req.person.id);
  res.json({ ok: true });
});

// The "Pick your favorite concessions" banner: dismissed, or its button
// tapped.
app.post('/api/public/favorites-prompt-done', (req, res) => {
  store.markFavoritesPromptDone(req.person.id);
  res.json({ ok: true });
});

app.get('/calendar/feed/:token.ics', (req, res) => {
  const person = store.personByCalendarToken(req.params.token);
  if (!person) return res.status(404).end();
  const events = [];
  store.seatsOf(person.id).forEach(({ showtime, seatIds }) => {
    const seats = showtime.seats || {};
    // "Seat H4" for just you; "Seats H4, H3 (Alex)" with guests, yours first.
    const isGuest = (id) => !!(seats[id] && seats[id].guest);
    const labels = seatIds.slice().sort((x, y) => isGuest(x) - isGuest(y))
      .map((id) => (isGuest(id) ? `${id} (${seats[id].name})` : id));
    const seatText = `${labels.length > 1 ? 'Seats' : 'Seat'} ${labels.join(', ')}`;
    const lines = icsEventLines(showtime, `feed-${showtime.id}-${person.id}@canopy-tickets`, seatText);
    if (lines) events.push(...lines);
  });
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(icsCalendar(events, [
    'X-WR-CALNAME:Canopy Tickets',
    // How often to check for changes, for the apps that read it.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ]));
});

// ---------------- Favorite concessions ----------------
//
// A favorite is an item AND its option -- tenders with buffalo and tenders
// with ranch are two favorites -- kept in the person's own order. The
// "usual" is a whole order's worth of such lines, added in one go.
// Checked against the current menu on every read and write: a favorite
// whose item or option has left the menu is gone (and the menu save
// above removes it from storage). For the usual, only the missing lines
// go; it's gone once none are left.
const MAX_FAVORITES = 40;
const MAX_USUAL_LINES = 20;

function favoriteLineValid(line, menu) {
  if (!line || typeof line.itemId !== 'string') return false;
  const item = menu.items.find((i) => i.id === line.itemId);
  if (!item) return false;
  const group = item.optionGroup ? menu.optionGroups.find((g) => g.id === item.optionGroup) : null;
  const options = group && Array.isArray(group.options) ? group.options : [];
  const option = typeof line.option === 'string' ? line.option : '';
  return options.length ? options.includes(option) : !option;
}

function cleanFavorites(f, menu) {
  const pick = (l) => ({ itemId: l.itemId, option: typeof l.option === 'string' ? l.option : '' });
  const seen = new Set();
  const favorites = (Array.isArray(f.favorites) ? f.favorites : [])
    .filter((l) => favoriteLineValid(l, menu)).map(pick)
    // One of each item+option: the same favorite twice is just clutter.
    .filter((l) => { const k = l.itemId + '\u0000' + l.option; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, MAX_FAVORITES);
  const usual = (Array.isArray(f.usual) ? f.usual : [])
    .filter((l) => favoriteLineValid(l, menu)).map(pick)
    .slice(0, MAX_USUAL_LINES);
  return { favorites, usual };
}

// usualGone: a line of their usual left the menu since they last looked
// -- the "Item discontinued" banner. Also caught here, for a menu that
// changed without a save (the built-in one, after an upgrade).
app.get('/api/public/favorites', (req, res) => {
  const stored = store.getFavorites(req.person.id) || {};
  const cleaned = cleanFavorites(stored, concessionMenuStore.get());
  let usualGone = !!stored.usualGone;
  if (cleaned.usual.length < (stored.usual || []).length) {
    store.pruneAllFavorites((f) => cleanFavorites(f, concessionMenuStore.get()));
    usualGone = true;
  }
  res.json({ ...cleaned, usualGone });
});

// Looked at their favorites (or dismissed the banner).
app.post('/api/public/favorites/reviewed', (req, res) => {
  store.setUsualGone(req.person.id, false);
  res.json({ ok: true });
});

app.put('/api/public/favorites', (req, res) => {
  const cleaned = cleanFavorites(req.body || {}, concessionMenuStore.get());
  store.setFavorites(req.person.id, cleaned);
  res.json({ ...cleaned, usualGone: false });
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

// Replaces one reserved seat's concession cart, and (below) marks a seat
// paid. Both are the seat owner's alone -- your own seat or a guest you
// booked (ownSeat). A seat reserved before profiles has no owner until
// its person claims it, so nobody can change it from here; the host can
// still change anything in the editor.
//
// Once the host closes the cart the concessions write is refused (409),
// a flag the host sets, not a time the server would have to read out of
// a bare local date string from a container in the wrong timezone.
//
// Paid is somebody saying they've settled up. There is no callback from
// Venmo or Cash App that could tell this app a payment landed, so a
// friend marking themselves paid is the only signal that exists.
//
// `ticket` and `concessions` are booleans, not amounts. What concessions
// come to is worked out in the store from what's actually saved on the
// seat, so a stale page can't settle $40 of food off a $12 view of it.
// Gives back a seat you reserved (yours or a guest's), while
// canReleaseSeat allows it. The store re-checks paid and the 24 hours
// inside its transaction.
app.post('/api/public/showtimes/:id/seats/:seatId/release', (req, res) => {
  const show = unlockedShowtime(req, res);
  if (!show || !ownSeat(req, res, show)) return;
  const now = Date.now();
  if (!canReleaseSeat(show, show.seats[req.params.seatId], req.person, now)) {
    return res.status(409).json({ error: "that seat can't be released any more", reason: 'not_releasable' });
  }
  const result = store.unclaimSeat(req.params.id, req.params.seatId, req.person.id, now - RELEASE_WINDOW_MS);
  if (!result.ok) {
    if (result.reason === 'not_found') return res.status(404).json({ error: 'not found' });
    return res.status(409).json({ error: "that seat can't be released any more", reason: 'not_releasable' });
  }
  res.json({ showtime: publicShowtimeView(result.showtime, req.person) });
});

app.put('/api/public/showtimes/:id/seats/:seatId/paid', async (req, res) => {
  const show = unlockedShowtime(req, res);
  if (!show || !ownSeat(req, res, show)) return;
  const body = req.body || {};
  const patch = {};
  if (typeof body.ticket === 'boolean') patch.ticket = body.ticket;
  if (typeof body.concessions === 'boolean') patch.concessions = body.concessions;
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'ticket and/or concessions must be booleans' });
  }

  const result = await store.setSeatPaid(req.params.id, req.params.seatId, patch);
  if (!result.ok) {
    if (result.reason === 'not_found') return res.status(404).json({ error: 'not found' });
    return res.status(409).json({ error: 'that seat is not reserved yet' });
  }
  res.json({ showtime: publicShowtimeView(result.showtime, req.person) });
});

app.put('/api/public/showtimes/:id/seats/:seatId/concessions', async (req, res) => {
  const show = unlockedShowtime(req, res);
  if (!show || !ownSeat(req, res, show)) return;
  const { items } = req.body || {};
  if (items !== undefined && !Array.isArray(items)) {
    return res.status(400).json({ error: 'items must be an array' });
  }
  // A-List members order at the counter themselves, for the points.
  if (req.person.amcAList && items && items.length) {
    return res.status(403).json({ error: 'concessions are off for AMC A-List members', reason: 'a_list' });
  }

  const result = await store.setSeatConcessions(req.params.id, req.params.seatId, items || []);
  if (!result.ok) {
    if (result.reason === 'not_found') return res.status(404).json({ error: 'not found' });
    if (result.reason === 'orders_closed') {
      return res.status(409).json({ error: 'orders are closed for this showtime', reason: 'orders_closed' });
    }
    return res.status(409).json({ error: 'that seat is not reserved yet' });
  }
  res.json({ showtime: publicShowtimeView(result.showtime, req.person) });
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
app.get('/api/amc-test', requireAdmin, async (req, res) => {
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
// / is the reservation page for anyone signed in to Canopy accounts, the
// admin included. /admin is the editor, for the admin. Signing in happens
// at the account service, which sends people back here afterwards.
//
// admin.html and public.html live outside /public so they can never be
// fetched directly, bypassing the checks below.

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Signed out: tickets' own sign-in page (views/signin.html). Its passkey
// button signs in right here, through the account service's sign-in
// endpoints; "Continue with email" goes to the account service (new
// people, a lost passkey) and comes back to the page they asked for. It's
// also what a link-preview crawler gets for the shared link, so it
// carries the Open Graph tags.
//
// With no CANOPY_ACCOUNT_KEY, signing in can't work (they'd come back
// still signed out), so the page is sent without the account URLs and
// says so.
function sendSignInPage(req, res) {
  renderHtmlPage(res, req, path.join(__dirname, 'views', 'signin.html'), {
    OG_IMAGE_URL: ogImageUrl(),
    ACCOUNT_URL: CANOPY_ACCOUNT_KEY ? CANOPY_ACCOUNT_URL : '',
    // ?email: the account page shows only the email step, since choosing
    // email here already says "new, or no passkey on this phone".
    EMAIL_SIGNIN_URL: CANOPY_ACCOUNT_KEY ? `${canopy.signInUrl(req)}&email` : ''
  });
}

app.get('/', attachPerson, (req, res) => {
  if (req.person) {
    return renderHtmlPage(res, req, path.join(__dirname, 'views', 'public.html'));
  }
  sendSignInPage(req, res);
});

// Signed in as someone else: back to the reservation page. Signed out:
// sign in, then straight back here.
app.get('/admin', attachPerson, (req, res) => {
  if (isAdmin(req)) return renderHtmlPage(res, req, path.join(__dirname, 'views', 'admin.html'));
  if (req.person) return res.redirect('/');
  sendSignInPage(req, res);
});

// Tickets' own sign-in from before Canopy accounts. A phone can keep the
// old sign-in page open in a tab for days; its buttons still call these,
// and the error it shows is whatever comes back -- so say what to do.
app.use(['/api/auth', '/api/me', '/api/signout'], (req, res) => {
  res.status(410).json({ error: 'sign-in has moved to Canopy accounts: reload this page', reason: 'moved' });
});

// "Sign out" on the pages links here. Signing out is the account
// service's: it signs this browser out of every Canopy site, then comes
// back to /, the sign-in page.
app.get('/signout', (req, res) => {
  res.redirect(canopy.signOutUrl(req));
});

// /reserve was the old dedicated friend-facing URL -- keep it working as
// a redirect in case it's already been shared anywhere.
app.get('/reserve', (req, res) => res.redirect('/'));

// ---------------- Site images (link-preview + logo) ----------------

// Wires up the GET (admin metadata)/POST (admin upload)/GET (public,
// no-auth file serve) trio for one named image store. The og-image and
// logo-image endpoints are identical apart from which store/URLs they use.
function mountImageRoutes(urlName, imageStore) {
  app.get(`/api/${urlName}`, requireAdmin, (req, res) => {
    const meta = imageStore.getMeta();
    res.json(meta ? { uploadedAt: meta.uploadedAt, url: `/${urlName}?v=${meta.uploadedAt}` } : { uploadedAt: null, url: null });
  });

  app.post(`/api/${urlName}`, requireAdmin, siteImageUpload.single('image'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'choose a PNG, JPEG, WebP, or GIF image' });
    }
    const meta = imageStore.save(req.file.buffer, req.file.mimetype);
    res.json({ ok: true, uploadedAt: meta.uploadedAt, url: `/${urlName}?v=${meta.uploadedAt}` });
  });

  // No auth -- link-preview crawlers fetch the OG image with no
  // session, and the logo is no more private than that, so both are
  // reachable by anyone.
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

// ---------------- Poster art ----------------
//
// Uploaded per movie (POST /api/movies/:id/poster above). Served with no
// auth -- posters show on the friend-facing page too, same reasoning as
// og-image/logo-image. `key` is the opaque hash already in posterUrl.
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
