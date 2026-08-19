const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const store = require('./lib/store');
const { createImageStore } = require('./lib/uploadedImage');
const sharedPasswordStore = require('./lib/sharedPassword');
const { createTextSettingStore } = require('./lib/textSetting');
const { createPasswordAuth } = require('./lib/auth');
const { normalizeSeats } = require('./lib/seats');

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

// Trims a showtime down to what a friend on the public/shared side should
// see: no full 377-seat auditorium map, just the block of seats the owner
// actually bought (each either claimed by a name or still open).
function publicShowtimeView(s) {
  const seats = normalizeSeats(s.seats);
  const blockSeats = {};
  Object.keys(seats).forEach((id) => {
    if (seats[id].status === 'assigned') {
      blockSeats[id] = { name: seats[id].name, paid: seats[id].paid };
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

// ---------------- Showtimes API (admin auth required) ----------------

app.use('/api/showtimes', adminAuth.requireAuth('/'));

// Read-side fallback for showtimes saved before `screen` existed -- see
// the DEFAULT_SCREEN comment above.
function withScreenFallback(item) {
  return { ...item, screen: item.screen || DEFAULT_SCREEN };
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
  const seats =
    body.seats && typeof body.seats === 'object' && !Array.isArray(body.seats) ? body.seats : existing.seats;
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
  res.json({ venmoHandle: venmoHandleStore.get(), cashappHandle: cashappHandleStore.get() });
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
