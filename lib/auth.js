// Minimal admin-session auth: a single shared admin password (checked in
// server.js) gates access, and a signed, stateless cookie tracks the
// logged-in session. No session store needed since the cookie carries its
// own signature + expiry.

const crypto = require('crypto');

const COOKIE_NAME = 'canopy_admin';
const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// If SESSION_SECRET isn't set, generate one at boot. Sessions just won't
// survive a restart in that case (fine for a small friends-only app).
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn(
    '[canopy-tickets] SESSION_SECRET not set; generated a random one for this run. ' +
      'Set SESSION_SECRET in your environment so admin sessions survive restarts.'
  );
}

function sign(value) {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
  return `${value}.${hmac}`;
}

function verify(token) {
  if (!token) return false;
  const idx = token.lastIndexOf('.');
  if (idx === -1) return false;
  const value = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');

  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch (e) {
    return false;
  }
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }

  const expiry = parseInt(value.split(':')[1], 10);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function issueSessionCookie(res) {
  const expiry = Date.now() + TTL_MS;
  const token = sign(`admin:${expiry}`);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
      TTL_MS / 1000
    )}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function isAuthed(req) {
  return verify(parseCookies(req)[COOKIE_NAME]);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  // req.path is relative to the mount point, so use originalUrl here.
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.redirect('/login.html');
}

module.exports = { issueSessionCookie, clearSessionCookie, isAuthed, requireAuth };
