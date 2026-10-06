// The friend side's cookie: which browser this is (a row in `devices`,
// see lib/sqliteStore.js). Movie unlocks hang off the device, and the
// device points at whoever signed in on it.
//
// Signed like lib/auth.js's cookies (HMAC under SESSION_SECRET, its own
// derived key), but carrying a device id, and good for a year from the
// last visit: every request more than a day after the cookie was issued
// gets a fresh one, so someone who comes back now and then never has to
// sign in or unlock again. (The old 30-day cookie that didn't renew is
// what locked a friend out of his own Dune seats.)

const crypto = require('crypto');

const COOKIE = 'canopy_device';
const TTL_MS = 1000 * 60 * 60 * 24 * 365;
const RENEW_AFTER_MS = 1000 * 60 * 60 * 24;
const ID_RE = /^[0-9a-f-]{36}$/;

function createDeviceAuth(sessionSecret) {
  const key = crypto.createHmac('sha256', sessionSecret).update(COOKIE).digest();
  const sign = (value) => crypto.createHmac('sha256', key).update(value).digest('hex');

  function read(req) {
    const header = req.headers.cookie || '';
    const pair = header.split(';').map((p) => p.trim()).find((p) => p.startsWith(COOKIE + '='));
    if (!pair) return null;
    const token = decodeURIComponent(pair.slice(COOKIE.length + 1));
    const [id, expiry, sig] = token.split('.');
    if (!id || !expiry || !sig || !ID_RE.test(id)) return null;
    const expected = sign(`${id}.${expiry}`);
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const exp = parseInt(expiry, 10);
    if (!Number.isFinite(exp) || Date.now() >= exp) return null;
    return { id, expiry: exp };
  }

  function issue(res, id) {
    const expiry = Date.now() + TTL_MS;
    const value = `${id}.${expiry}`;
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.append(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(`${value}.${sign(value)}`)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
        TTL_MS / 1000
      )}${secure}`
    );
  }

  // Re-issue once a day, so the year counts from the last visit.
  function needsRenewal(cookie) {
    return cookie.expiry - Date.now() < TTL_MS - RENEW_AFTER_MS;
  }

  return { read, issue, needsRenewal };
}

module.exports = { createDeviceAuth };
