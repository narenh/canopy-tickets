const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const store = require('./lib/store');
const ogImage = require('./lib/ogImage');
const { createPasswordAuth } = require('./lib/auth');
const { normalizeSeats } = require('./lib/seats');

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
const SHARED_PASSWORD = requireEnvPassword('SHARED_PASSWORD', 'shared/friend');

const HOST_VENMO = process.env.HOST_VENMO || '';
if (!HOST_VENMO) {
  console.warn(
    '[canopy-tickets] HOST_VENMO not set -- the reservation page will skip showing a Venmo link. ' +
      'Set it to your Venmo username (no @) to enable one.'
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
// If SESSION_SECRET isn't set, derive a stable one from the admin/shared
// passwords instead of generating randomness -- those are already
// required to be stable across the deployment for login to work at all,
// so this can't newly introduce an inconsistency. Still recommend setting
// SESSION_SECRET explicitly (see README) so rotating a password later
// doesn't also silently invalidate every existing session.
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(`canopy-tickets:${ADMIN_PASSWORD}:${SHARED_PASSWORD}`).digest('hex');
if (!process.env.SESSION_SECRET) {
  console.warn(
    '[canopy-tickets] SESSION_SECRET not set; derived a stable one from ADMIN_PASSWORD/SHARED_PASSWORD instead. ' +
      'This works, but changing either password will also silently log everyone out -- set SESSION_SECRET ' +
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
  const meta = ogImage.getMeta();
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

// Sends a static HTML file with the `<!-- OG_META -->` placeholder in its
// <head> replaced with real tags. The tags have to be in the initial
// server response, not injected by client-side JS -- link-preview
// crawlers don't run JavaScript.
function sendPageWithOgTags(res, req, filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html.replace('<!-- OG_META -->', buildOgTags(req)));
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
    price: s.price,
    seats: blockSeats
  };
}

// ---------------- Auth (single password field, two possible outcomes) ----------------
//
// There's one login page and one password field. Which of the two
// passwords you type decides where you land -- ADMIN_PASSWORD opens the
// editor, SHARED_PASSWORD opens the reservation page -- so the page never
// has to say "admin" anywhere. The two sessions are still fully separate
// cookies underneath; typing the admin password does not also grant
// shared access or vice versa.

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'password required' });
  }
  if (checkPassword(password, ADMIN_PASSWORD)) {
    adminAuth.issueSessionCookie(res);
    return res.json({ ok: true, role: 'admin' });
  }
  if (checkPassword(password, SHARED_PASSWORD)) {
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

// ---------------- Showtimes API (admin auth required) ----------------

app.use('/api/showtimes', adminAuth.requireAuth('/'));

app.get('/api/showtimes', (req, res) => {
  const items = store.listShowtimes().sort(byShowtime);
  res.json({ showtimes: items });
});

app.get('/api/showtimes/:id', (req, res) => {
  const item = store.getShowtime(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json({ showtime: item });
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
  res.json({ venmoHandle: HOST_VENMO || null });
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
    return sendPageWithOgTags(res, req, path.join(__dirname, 'views', 'admin.html'));
  }
  if (sharedAuth.isAuthed(req)) {
    return sendPageWithOgTags(res, req, path.join(__dirname, 'views', 'public.html'));
  }
  // The unauthenticated case is the one that actually matters for link
  // previews: a crawler hitting the shared URL never has a session
  // cookie, so this is the response it sees.
  sendPageWithOgTags(res, req, path.join(__dirname, 'public', 'login.html'));
});

// /reserve was the old dedicated friend-facing URL -- keep it working as
// a redirect in case it's already been shared anywhere.
app.get('/reserve', (req, res) => res.redirect('/'));

// ---------------- Link-preview image ----------------

const ogImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter(req, file, cb) {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  }
});

app.get('/api/og-image', adminAuth.requireAuth('/'), (req, res) => {
  const meta = ogImage.getMeta();
  res.json(meta ? { uploadedAt: meta.uploadedAt, url: `/og-image?v=${meta.uploadedAt}` } : { uploadedAt: null, url: null });
});

app.post('/api/og-image', adminAuth.requireAuth('/'), ogImageUpload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'choose a PNG, JPEG, WebP, or GIF image' });
  }
  const meta = ogImage.save(req.file.buffer, req.file.mimetype);
  res.json({ ok: true, uploadedAt: meta.uploadedAt, url: `/og-image?v=${meta.uploadedAt}` });
});

// No auth -- link-preview crawlers (Facebook, iMessage, etc.) fetch this
// with no session, so it has to be reachable by anyone.
app.get('/og-image', (req, res) => {
  const meta = ogImage.getMeta();
  if (!meta) return res.status(404).end();
  res.set('Content-Type', meta.mimeType);
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(ogImage.getFilePath());
});

app.use(express.static(path.join(__dirname, 'public')));

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
