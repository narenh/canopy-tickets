const express = require('express');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const { createPasswordAuth } = require('./lib/auth');
const { normalizeSeats } = require('./lib/seats');

const app = express();
const PORT = process.env.PORT || 3000;

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

const adminAuth = createPasswordAuth('canopy_admin');
const sharedAuth = createPasswordAuth('canopy_shared');

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
    return res.sendFile(path.join(__dirname, 'views', 'admin.html'));
  }
  if (sharedAuth.isAuthed(req)) {
    return res.sendFile(path.join(__dirname, 'views', 'public.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// /reserve was the old dedicated friend-facing URL -- keep it working as
// a redirect in case it's already been shared anywhere.
app.get('/reserve', (req, res) => res.redirect('/'));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`canopy-tickets listening on port ${PORT}`);
});
