// Password-session auth. Two independent instances of this run side by
// side (admin, and the friend-facing "shared" session) -- each gated by
// its own password and its own signed, stateless cookie, so logging into
// one never implies the other. No session store needed: the cookie
// carries its own signature + expiry.

const crypto = require('crypto');

const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// If SESSION_SECRET isn't set, generate one at boot. Sessions just won't
// survive a restart in that case (fine for a small friends-only app).
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn(
    '[canopy-tickets] SESSION_SECRET not set; generated a random one for this run. ' +
      'Set SESSION_SECRET in your environment so sessions survive restarts.'
  );
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

// Builds an independent password-session helper bound to one cookie name.
// Each instance signs with its own derived key (HMAC of the cookie name
// under SESSION_SECRET) so an admin cookie and a shared cookie can never
// be swapped for one another even though they share SESSION_SECRET.
function createPasswordAuth(cookieName) {
  const key = crypto.createHmac('sha256', SESSION_SECRET).update(cookieName).digest();

  function sign(value) {
    const hmac = crypto.createHmac('sha256', key).update(value).digest('hex');
    return `${value}.${hmac}`;
  }

  function verify(token) {
    if (!token) return false;
    const idx = token.lastIndexOf('.');
    if (idx === -1) return false;
    const value = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    const expected = crypto.createHmac('sha256', key).update(value).digest('hex');

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

  // Uses res.append (not res.setHeader) for Set-Cookie: a single response
  // sometimes needs to set/clear both the admin and shared cookies at
  // once (e.g. logout clears both), and setHeader with the same header
  // name twice silently overwrites the first call instead of sending
  // both -- append is what correctly accumulates multiple Set-Cookie
  // headers on one response.
  function issueSessionCookie(res) {
    const expiry = Date.now() + TTL_MS;
    const token = sign(`session:${expiry}`);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.append(
      'Set-Cookie',
      `${cookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
        TTL_MS / 1000
      )}${secure}`
    );
  }

  function clearSessionCookie(res) {
    res.append('Set-Cookie', `${cookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  }

  function isAuthed(req) {
    return verify(parseCookies(req)[cookieName]);
  }

  // Returns a middleware that redirects browser requests to loginPagePath
  // and 401s API requests, when not authed.
  function requireAuth(loginPagePath) {
    return function (req, res, next) {
      if (isAuthed(req)) return next();
      // req.path is relative to the mount point, so use originalUrl here.
      if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      res.redirect(loginPagePath);
    };
  }

  return { issueSessionCookie, clearSessionCookie, isAuthed, requireAuth };
}

module.exports = { createPasswordAuth };
