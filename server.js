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
const { createDeviceAuth } = require('./lib/deviceAuth');
const photoStore = require('./lib/photoStore');
const { normalizeSeats, isHostSeat, CONCESSION_TAX_RATE } = require('./lib/seats');
const webauthn = require('@simplewebauthn/server');

const ogImageStore = createImageStore('og');
const logoImageStore = createImageStore('logo');

// Replaces the old HOST_VENMO env var: like the friend password, these are
// admin-settable from the admin's Settings tab instead of
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

// There's no friend password any more: each movie has its own (set on
// the movie's page in the admin), and friends sign in by email. The old
// friend password is only read once, to give the movies that existed then
// a password friends already know -- see seedMovieAccess in
// lib/sqliteStore.js.

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

const deviceAuth = createDeviceAuth(SESSION_SECRET);

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

// Same-origin, cache-busted URL of the link-preview image, or '' if none
// has been uploaded. The friend login page uses it as its backdrop.
function ogImageUrl() {
  const meta = ogImageStore.getMeta();
  return meta ? `/og-image?v=${meta.uploadedAt}` : '';
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
// how the passkey library went missing on an iPhone the day it shipped
// (the sign-in page's script then died before wiring up its buttons), so
// it's inlined too. Cropper.js has been around long enough to stay a file.
const INLINE_SCRIPTS = [
  'copy.js', 'seat-layout.js', 'photo-crop.js', 'vendor/simplewebauthn-browser-14.0.0/index.umd.min.js'
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
function renderHtmlPage(res, req, filePath) {
  const logoTag = buildLogoImgTag();
  let html = fs.readFileSync(filePath, 'utf8')
    .replace('<!-- OG_META -->', buildOgTags(req))
    // Every one: the sign-in page has a logo on more than one card.
    .replaceAll('<!-- LOGO_IMG -->', () => logoTag)
    .replace('__OG_IMAGE_URL__', ogImageUrl());
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

// The JSON fallback store (see lib/store.js) predates movies, so it
// has no poster keys: there, posters are still found by title.
function posterUrlFor(showtime) {
  if (showtime.posterKey) return posterUrlForKey(showtime.posterKey);
  return showtime.title ? posterUrlForKey(posterStore.keyFor(showtime.title)) : null;
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

function photoUrlFor(person) {
  return person && person.photoAt ? `/photo/${person.id}?v=${person.photoAt}` : null;
}

// Trims a showtime down to what a friend on the public/shared side should
// see: no full 377-seat auditorium map, just the block of seats the owner
// actually bought (each either claimed by a name or still open).
//
// `viewer` is the signed-in person, so their own seats can say so.
// `onlySeatIds`, when given, limits the seats to those (a movie this
// device hasn't unlocked shows its viewer their own seats and nobody
// else's).
function publicShowtimeView(s, viewer, onlySeatIds, lookup) {
  const person = lookup || peopleLookup();
  const seats = normalizeSeats(s.seats);
  const blockSeats = {};
  Object.keys(seats).forEach((id) => {
    if (onlySeatIds && !onlySeatIds.has(id)) return;
    if (seats[id].status === 'assigned') {
      const raw = (s.seats && s.seats[id]) || {};
      const owner = person(raw.personId);
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
        mine: !!(viewer && raw.personId && raw.personId === viewer.id),
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
    posterUrl: posterUrlFor(s),
    // Set by the host when they go and place the order -- see the
    // orders-closed route below for why it isn't a clock.
    ordersClosed: !!s.ordersClosed,
    seats: blockSeats
  };
}

// ---------------- Admin auth ----------------
//
// The admin is a profile like any friend's, and signs in the same way:
// with its passkey. Which profile is the admin is stored in meta
// (admin_person_id); it's also the host (see lib/seats.js).
//
// There is never an account without an admin. With no admin (a brand-new
// install), the sign-in page at / is only the setup password
// (ADMIN_PASSWORD), and the server refuses every other sign-in and
// sign-up until it's been entered; whoever then signs up on that browser
// is the admin. ADMIN_RECOVERY=1 reopens the setup password for an admin
// who's lost their passkey -- it lets the admin's own profile add a new
// one and nothing else -- and needs access to the server's settings to
// turn on, which is the right bar for the keys to everything.

const ADMIN_RECOVERY = process.env.ADMIN_RECOVERY === '1';
const ADMIN_SETUP_MS = 15 * 60 * 1000;

function adminSetupOpen() {
  return store.kind === 'sqlite' && (ADMIN_RECOVERY || !store.getAdminPersonId());
}

function isAdmin(req) {
  return store.kind === 'sqlite' && !!req.person && req.person.id === store.getAdminPersonId();
}

// This browser entered the setup password recently, and setup is open.
function hasAdminSetupGrant(req) {
  const at = req.device && req.device.admin_setup_at;
  return adminSetupOpen() && !!at && Date.now() - at < ADMIN_SETUP_MS;
}

// The setup password lets a profile add a passkey without a movie
// password: any profile on first run (it's about to be the admin), only
// the admin's own in recovery.
function canEnrollViaSetup(req, personId) {
  if (!hasAdminSetupGrant(req)) return false;
  const adminId = store.getAdminPersonId();
  return !adminId || personId === adminId;
}

// No admin yet: nothing but the setup password until it's been entered
// here. Sends the refusal itself and returns false.
function accountsOpen(req, res) {
  if (store.kind !== 'sqlite' || store.getAdminPersonId() || hasAdminSetupGrant(req)) return true;
  res.status(403).json({ error: 'set up the admin account first', reason: 'setup_required' });
  return false;
}

// For every admin API: signed in, as the admin.
function requireAdmin(req, res, next) {
  attachDevice(false)(req, res, () => {
    if (isAdmin(req)) return next();
    res.status(401).json({ error: 'unauthorized' });
  });
}

// ---------------- Payment handles (admin auth required) ----------------
//
// Replaces HOST_VENMO. Both are optional and independent -- leaving one
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
  if (store.kind === 'sqlite') store.pruneAllFavorites((f) => cleanFavorites(f, saved));
  res.json({ ok: true, ...saved, taxRate: CONCESSION_TAX_RATE });
});

// Throws away the saved menu so the built-in AMC list takes over again
// (see DEFAULT_ITEMS in lib/concessionMenu.js). Doesn't touch
// anyone's existing orders -- those carry their own copy of whatever
// they were placed against.
app.post('/api/concession-menu/reset', requireAdmin, (req, res) => {
  const menu = concessionMenuStore.reset();
  if (store.kind === 'sqlite') store.pruneAllFavorites((f) => cleanFavorites(f, menu));
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

// Movies need the SQLite store; the JSON fallback (lib/store.js) only
// exists to keep friends reserving if the migration ever fails.
function requireSqlite(req, res, next) {
  if (store.kind === 'sqlite') return next();
  res.status(503).json({ error: 'the database is unavailable -- see the server log' });
}
app.use('/api/movies', requireSqlite);

// Read-side fallback for showtimes saved before `screen` existed -- see
// the DEFAULT_SCREEN comment above. Also attaches posterUrl.
function withScreenFallback(item) {
  return { ...item, screen: item.screen || DEFAULT_SCREEN, posterUrl: posterUrlFor(item) };
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

app.use('/api/people', requireAdmin, requireSqlite);

app.get('/api/people', (req, res) => {
  res.json({
    people: store.listPeople().map((p) => ({ ...p, photoUrl: photoUrlFor(p) })),
    adminPersonId: store.getAdminPersonId()
  });
});

app.patch('/api/people/:id', (req, res) => {
  const names = cleanNames(req.body || {});
  if (names.error) return res.status(400).json({ error: names.error });
  const result = store.renamePerson(req.params.id, names.firstName, names.lastName);
  if (!result.ok) return sendResult(res, result);
  res.json({ person: { ...result.person, photoUrl: photoUrlFor(result.person) } });
});

// Lost phone: their passkeys go and they're signed out everywhere. They
// set up a new one with any movie's password, like the first time.
app.post('/api/people/:id/reset-passkeys', (req, res) => {
  // Your own would lock you out of here; that's ADMIN_RECOVERY's job.
  if (req.params.id === store.getAdminPersonId()) return res.status(409).json({ error: 'not the admin', reason: 'is_admin' });
  sendResult(res, store.resetPasskeys(req.params.id));
});

// Their seats stay reserved under the names on them; they just stop
// belonging to anyone. For a typo'd duplicate, mostly.
app.delete('/api/people/:id', (req, res) => {
  if (req.params.id === store.getAdminPersonId()) return res.status(409).json({ error: 'not the admin', reason: 'is_admin' });
  if (!store.deletePerson(req.params.id)) return res.status(404).json({ error: 'not found' });
  try { photoStore.remove(req.params.id); } catch (e) {}
  res.json({ ok: true });
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

app.patch('/api/showtimes/:id', requireSqlite, (req, res) => {
  const { fields, error } = showtimeFields(req.body || {});
  if (error) return res.status(400).json({ error });
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'nothing to change' });
  const result = store.patchShowtime(req.params.id, fields);
  if (!result.ok) return sendResult(res, result);
  res.json({ showtime: withScreenFallback(result.showtime) });
});

app.post('/api/showtimes/:id/duplicate', requireSqlite, (req, res) => {
  const result = store.duplicateShowtime(req.params.id);
  if (!result.ok) return sendResult(res, result);
  res.status(201).json({ showtime: withScreenFallback(result.showtime) });
});

// One seat in your block: who it's for and whether they've paid. Their
// concession order isn't the editor's to change and stays on the seat
// unless the name is cleared (see setSeat in lib/sqliteStore.js).
app.put('/api/showtimes/:id/seats/:seatId', requireSqlite, (req, res) => {
  if (!SEAT_ID_RE.test(req.params.seatId)) return res.status(400).json({ error: 'bad seat id' });
  const body = req.body || {};
  const result = store.setSeat(req.params.id, req.params.seatId, {
    name: typeof body.name === 'string' ? body.name : '',
    paid: !!body.paid,
    concessionsPaid: !!body.concessionsPaid
  });
  if (!result.ok) return sendResult(res, result);
  res.json({ showtime: withScreenFallback(result.showtime) });
});

app.delete('/api/showtimes/:id/seats/:seatId', requireSqlite, (req, res) => {
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
app.post('/api/showtimes/:id/orders-closed', requireSqlite, (req, res) => {
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

// ---------------- Friends: devices, sign-in, profiles ----------------
//
// Friends sign in with a passkey (WebAuthn: Face ID / Touch ID / the
// phone's screen lock), and nothing else -- there are no friend passwords
// to store or forget. The browser's device cookie is the session once a
// passkey has been verified on it.
//
// Getting a first passkey:
//   - a new email: name and photo, then the passkey; the profile is only
//     created once the passkey exists;
//   - an existing profile with no passkey (everyone, the first time after
//     passkeys arrived, or after the admin resets theirs): the password
//     of ANY movie first, then the passkey.
// A profile that already has a passkey can only be signed into with it;
// a lost phone is the admin's "Reset passkeys".
//
// Movie unlocks belong to the PERSON (person_unlocks) and follow them to
// every device.

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
// Across everyone, per movie (or 'setup' for "any movie's password"): the
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

// Finds this browser's device (from its cookie), making one if `create`
// is set. Puts req.device, req.person and req.unlocked (the person's
// movie ids) on the request.
function attachDevice(create) {
  return (req, res, next) => {
    req.unlocked = new Set();
    req.person = null;
    if (store.kind !== 'sqlite') return next();
    const cookie = deviceAuth.read(req);
    let device = cookie ? store.getDevice(cookie.id) : null;
    if (!device && create) device = store.createDevice();
    if (!device) return next();
    if (!cookie || cookie.id !== device.id || deviceAuth.needsRenewal(cookie)) {
      deviceAuth.issue(res, device.id);
      store.touchDevice(device.id);
    }
    req.device = device;
    req.person = device.person_id ? store.getPerson(device.person_id) : null;
    req.unlocked = req.person ? store.personUnlockedMovieIds(req.person.id) : new Set();
    next();
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function cleanEmail(raw) {
  const email = String(raw || '').trim().toLowerCase().slice(0, 200);
  return EMAIL_RE.test(email) ? email : null;
}

function cleanNames(body) {
  const firstName = String(body.firstName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const lastName = String(body.lastName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!firstName || !lastName) return { error: 'first and last name are both required' };
  return { firstName, lastName };
}

// A Venmo username: letters, digits, - or _, at most 30. A leading @ is
// dropped in case one gets pasted in. Empty clears it (null); anything
// else invalid is false.
function cleanVenmo(raw) {
  const v = String(raw == null ? '' : raw).trim().replace(/^@+/, '');
  if (!v) return null;
  return /^[A-Za-z0-9_-]{1,30}$/.test(v) ? v : false;
}

function meView(req) {
  return {
    person: req.person ? { ...req.person, photoUrl: photoUrlFor(req.person), isAdmin: isAdmin(req) } : null,
    unlockedMovieIds: Array.from(req.unlocked)
  };
}

// The cropped photo the welcome page makes is a few dozen KB; this is
// only a ceiling.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
  }
});

app.get('/api/me', attachDevice(false), (req, res) => {
  res.json(meView(req));
});

// ---------------- Passkeys ----------------

const PASSKEY_RP_NAME = 'Canopy Tickets';
const PASSKEY_CEREMONY_MS = 5 * 60 * 1000;

// Passkeys belong to a domain (the "relying party"). Made for
// canopysf.com, they work on tix.canopysf.com and any other subdomain, so
// the app can move to another subdomain without everyone starting over.
// PASSKEY_RP_ID overrides; anywhere else (localhost in development) uses
// the page's own host. Null when this host can't use passkeys at all.
//
// The expected origin is always https outside localhost: browsers only
// offer passkeys on secure pages, and behind Cloudflare and Coolify's
// proxy req.protocol may well read http.
function passkeyRp(req) {
  const host = String(req.hostname || '').toLowerCase();
  const rpID = process.env.PASSKEY_RP_ID ||
    (host === 'canopysf.com' || host.endsWith('.canopysf.com') ? 'canopysf.com' : host);
  if (!host || (host !== rpID && !host.endsWith('.' + rpID))) return null;
  const local = host === 'localhost' || host === '127.0.0.1';
  return { rpID, origin: `${local ? req.protocol : 'https'}://${req.get('host')}` };
}

function requirePasskeyRp(req, res) {
  if (store.kind !== 'sqlite') { res.status(503).json({ error: 'unavailable' }); return null; }
  const rp = passkeyRp(req);
  if (!rp) res.status(400).json({ error: 'passkeys are not available on this address' });
  return rp;
}

async function registrationOptions(req, rp, { userId, email, displayName, existing }) {
  return webauthn.generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID: rp.rpID,
    userID: new TextEncoder().encode(userId),
    userName: email,
    userDisplayName: displayName,
    attestationType: 'none',
    excludeCredentials: (existing || []).map((k) => ({ id: k.id, transports: k.transports })),
    // Discoverable, so signing in needs no email: the phone offers the
    // passkeys it has for this site.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
  });
}

// What the sign-in page should open with: the setup password while
// there's no admin yet (or in recovery), unless this browser already
// entered it.
// adminExists false: the sign-in page is only the setup step. True with
// adminSetup (recovery): a small "Admin setup" link friends can ignore.
app.get('/api/auth/state', attachDevice(false), (req, res) => {
  res.json({
    adminExists: store.kind === 'sqlite' && !!store.getAdminPersonId(),
    adminSetup: adminSetupOpen(),
    adminSetupGranted: hasAdminSetupGrant(req)
  });
});

app.post('/api/auth/admin-setup', attachDevice(true), (req, res) => {
  if (!adminSetupOpen()) return res.status(409).json({ error: 'there is already an admin', reason: 'closed' });
  const password = String((req.body || {}).password || '');
  const outcome = checkMovieGuess(req, req.device.id, 'admin-setup', () => checkPassword(password, ADMIN_PASSWORD));
  if (outcome !== 'ok') return sendGuessRefusal(res, outcome);
  store.grantAdminSetup(req.device.id);
  res.json({ ok: true });
});

// A passkey just checked out for personId: sign this browser in. On
// first run (the setup password entered here, no admin yet) they're the
// admin now; in recovery the admin stays who it was.
function finishSignIn(req, personId) {
  const granted = hasAdminSetupGrant(req);
  store.signInDevice(req.device.id, personId);
  if (granted) {
    store.takeAdminSetup(req.device.id);
    if (!store.getAdminPersonId()) store.setAdminPersonId(personId);
  }
  req.person = store.getPerson(personId);
  req.unlocked = store.personUnlockedMovieIds(personId);
}

// What's on the other end of an email. 'new': no profile yet. 'setup': a
// profile with no passkey (first time since passkeys, or reset by the
// admin) -- takes any movie's password. 'passkey': sign in with it.
app.post('/api/auth/lookup', attachDevice(true), (req, res) => {
  if (store.kind !== 'sqlite') return res.status(503).json({ error: 'unavailable' });
  if (!accountsOpen(req, res)) return;
  const email = cleanEmail((req.body || {}).email);
  if (!email) return res.status(400).json({ error: 'enter a valid email' });
  const person = store.getPersonByEmail(email);
  if (!person) return res.json({ state: 'new', email });
  const state = store.passkeysOf(person.id).length ? 'passkey' : 'setup';
  // After the setup password, an existing profile can add a passkey with
  // no movie password -- and even if it has one (a lost phone, in recovery).
  res.json({ state, email, firstName: person.firstName, canEnroll: canEnrollViaSetup(req, person.id) });
});

// A new profile: its details wait on this browser until the passkey
// exists (register/verify creates both). The photo is uploaded after.
app.post('/api/auth/register/new', attachDevice(true), async (req, res) => {
  const rp = requirePasskeyRp(req, res);
  if (!rp || !accountsOpen(req, res)) return;
  const body = req.body || {};
  const email = cleanEmail(body.email);
  if (!email) return res.status(400).json({ error: 'enter a valid email' });
  const names = cleanNames(body);
  if (names.error) return res.status(400).json({ error: names.error });
  if (store.getPersonByEmail(email)) return res.status(409).json({ error: 'that email already has a profile', reason: 'conflict' });
  // Optional; checked now so a bad one is said before the passkey prompt.
  const venmo = cleanVenmo(body.venmoHandle);
  if (venmo === false) return res.status(400).json({ error: 'a Venmo username is letters, numbers, - and _ only', reason: 'bad_venmo' });
  const id = crypto.randomUUID();
  const options = await registrationOptions(req, rp, {
    userId: id, email, displayName: `${names.firstName} ${names.lastName}`
  });
  store.setPending(req.device.id, {
    challenge: options.challenge, kind: 'register', profile: { id, email, ...names, venmo }
  });
  res.json({ options });
});

// First passkey for an existing profile: proves membership with the
// password of any movie (the movie is unlocked for them once the passkey
// is made).
app.post('/api/auth/register/setup', attachDevice(true), async (req, res) => {
  const rp = requirePasskeyRp(req, res);
  if (!rp || !accountsOpen(req, res)) return;
  const body = req.body || {};
  const person = store.getPersonByEmail(cleanEmail(body.email) || '');
  if (!person) return res.status(404).json({ error: 'not found' });
  const viaSetup = canEnrollViaSetup(req, person.id);
  const existing = store.passkeysOf(person.id);
  if (existing.length && !viaSetup) {
    return res.status(409).json({ error: 'this profile already has a passkey', reason: 'has_passkey' });
  }
  let movie = null;
  if (!viaSetup) {
    const password = String(body.moviePassword || '');
    const outcome = checkMovieGuess(req, req.device.id, 'setup', () => {
      movie = store.listMovies().find((m) => m.password && checkPassword(password, m.password)) || null;
      return !!movie;
    });
    if (outcome !== 'ok') return sendGuessRefusal(res, outcome);
  }
  const options = await registrationOptions(req, rp, {
    userId: person.id, email: person.email, displayName: `${person.firstName} ${person.lastName}`, existing
  });
  store.setPending(req.device.id, {
    challenge: options.challenge, kind: 'register', personId: person.id,
    profile: { unlockMovieId: movie ? movie.id : null, viaSetup }
  });
  res.json({ options });
});

app.post('/api/auth/register/verify', attachDevice(true), async (req, res) => {
  const rp = requirePasskeyRp(req, res);
  // Checked again here: the setup password may have expired since.
  if (!rp || !accountsOpen(req, res)) return;
  const pending = store.takePending(req.device.id);
  if (!pending || pending.kind !== 'register' || Date.now() - pending.at > PASSKEY_CEREMONY_MS) {
    return res.status(400).json({ error: 'start again', reason: 'expired' });
  }
  let result;
  try {
    result = await webauthn.verifyRegistrationResponse({
      response: (req.body || {}).response,
      expectedChallenge: pending.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false
    });
  } catch (e) {
    return res.status(400).json({ error: 'that passkey could not be verified', reason: 'not_verified' });
  }
  if (!result.verified) return res.status(400).json({ error: 'that passkey could not be verified', reason: 'not_verified' });
  const cred = {
    ...result.registrationInfo.credential,
    deviceType: result.registrationInfo.credentialDeviceType,
    backedUp: result.registrationInfo.credentialBackedUp
  };

  let personId;
  if (pending.personId) {
    // Someone else may have set one up in the meantime. (After the setup
    // password, adding another is the point.)
    const viaSetup = !!(pending.profile && pending.profile.viaSetup) && canEnrollViaSetup(req, pending.personId);
    if (!viaSetup && store.passkeysOf(pending.personId).length) {
      return res.status(409).json({ error: 'this profile already has a passkey', reason: 'has_passkey' });
    }
    store.addPasskey(pending.personId, cred);
    personId = pending.personId;
    if (pending.profile && pending.profile.unlockMovieId) store.unlockMovieForPerson(personId, pending.profile.unlockMovieId);
  } else if (pending.profile && pending.profile.email) {
    const made = store.createPersonWithPasskey(pending.profile, cred);
    if (!made.ok) return res.status(409).json({ error: 'that email already has a profile', reason: 'conflict' });
    personId = made.person.id;
  } else {
    return res.status(400).json({ error: 'start again', reason: 'expired' });
  }
  finishSignIn(req, personId);
  res.status(201).json(meView(req));
});

// Sign in: no email -- the phone offers whichever passkey it has here.
app.post('/api/auth/login/options', attachDevice(true), async (req, res) => {
  const rp = requirePasskeyRp(req, res);
  if (!rp || !accountsOpen(req, res)) return;
  const options = await webauthn.generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred' });
  store.setPending(req.device.id, { challenge: options.challenge, kind: 'login' });
  res.json({ options });
});

app.post('/api/auth/login/verify', attachDevice(true), async (req, res) => {
  const rp = requirePasskeyRp(req, res);
  if (!rp || !accountsOpen(req, res)) return;
  const pending = store.takePending(req.device.id);
  if (!pending || pending.kind !== 'login' || Date.now() - pending.at > PASSKEY_CEREMONY_MS) {
    return res.status(400).json({ error: 'start again', reason: 'expired' });
  }
  const response = (req.body || {}).response;
  const passkey = store.getPasskey(response && response.id);
  // Deleted by a reset, or made for a profile that's since gone.
  if (!passkey) return res.status(400).json({ error: 'that passkey is no longer linked to a profile', reason: 'unknown_passkey' });
  let result;
  try {
    result = await webauthn.verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: { id: passkey.id, publicKey: passkey.publicKey, counter: passkey.counter, transports: passkey.transports },
      requireUserVerification: false
    });
  } catch (e) {
    return res.status(400).json({ error: 'that passkey could not be verified', reason: 'not_verified' });
  }
  if (!result.verified) return res.status(400).json({ error: 'that passkey could not be verified', reason: 'not_verified' });
  store.usePasskey(passkey.id, result.authenticationInfo.newCounter);
  finishSignIn(req, passkey.personId);
  res.json(meView(req));
});

app.patch('/api/profile', attachDevice(false), (req, res) => {
  if (!req.person) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body || {};
  const names = cleanNames(body);
  if (names.error) return res.status(400).json({ error: names.error });
  // Optional, and only touched when sent.
  let venmo;
  if (body.venmoHandle !== undefined) {
    venmo = cleanVenmo(body.venmoHandle);
    if (venmo === false) return res.status(400).json({ error: 'a Venmo username is letters, numbers, - and _ only', reason: 'bad_venmo' });
  }
  req.person = store.renamePerson(req.person.id, names.firstName, names.lastName).person;
  if (venmo !== undefined) req.person = store.setPersonVenmo(req.person.id, venmo);
  res.json(meView(req));
});

app.post('/api/profile/photo', attachDevice(false), photoUpload.single('photo'), (req, res) => {
  if (!req.person) return res.status(401).json({ error: 'unauthorized' });
  if (!req.file) return res.status(400).json({ error: 'choose a photo' });
  photoStore.save(req.person.id, req.file.buffer);
  req.person = store.setPersonPhoto(req.person.id, Date.now());
  res.json(meView(req));
});

// Signs the person out of this browser. Their unlocks are theirs and go
// with them.
app.post('/api/signout', attachDevice(false), (req, res) => {
  if (req.device) store.setDevicePerson(req.device.id, null);
  res.json({ ok: true });
});

// Photos are for signed-in friends and the host, not the open web.
app.get('/photo/:personId', attachDevice(false), (req, res) => {
  if (!req.person) return res.status(404).end();
  let file = null;
  try { file = photoStore.pathFor(req.params.personId); } catch (e) {}
  if (!file) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});

// ---------------- Public API (signed-in friends) ----------------

app.use('/api/public', attachDevice(false), (req, res, next) => {
  if (store.kind !== 'sqlite') return res.status(503).json({ error: 'unavailable' });
  if (!req.person) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/api/public/config', (req, res) => {
  res.json({
    venmoHandle: venmoHandleStore.get(),
    cashappHandle: cashappHandleStore.get(),
    concessionTaxRate: CONCESSION_TAX_RATE
  });
});

app.get('/api/public/me', (req, res) => res.json(meView(req)));

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
// shows the same thing My showtimes does to anyone signed in as them --
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

// The "Subscribe to your showtimes" banner on My showtimes: dismissed, or
// its Subscribe tapped. Either way it stops showing for this person.
app.post('/api/public/calendar-prompt-done', (req, res) => {
  store.markCalendarPromptDone(req.person.id);
  res.json({ ok: true });
});

app.get('/calendar/feed/:token.ics', (req, res) => {
  if (store.kind !== 'sqlite') return res.status(404).end();
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
// / is where everyone signs in, the admin included (and the first-run
// setup password): the reservation page for a browser someone's signed in
// on, otherwise the welcome page. /admin is just a shortcut to the editor
// for the admin's session; anyone else is sent to /.
//
// admin.html, public.html and welcome.html live outside /public so they
// can never be fetched directly, bypassing the checks below.
app.get('/', attachDevice(false), (req, res) => {
  if (req.person) {
    return renderHtmlPage(res, req, path.join(__dirname, 'views', 'public.html'));
  }
  // The signed-out case is the one that actually matters for link
  // previews: a crawler hitting the shared URL never has a cookie, so
  // this is the response it sees.
  renderHtmlPage(res, req, path.join(__dirname, 'views', 'welcome.html'));
});

app.get('/admin', attachDevice(false), (req, res) => {
  if (isAdmin(req)) return renderHtmlPage(res, req, path.join(__dirname, 'views', 'admin.html'));
  res.redirect('/');
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
