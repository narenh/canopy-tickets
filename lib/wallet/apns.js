// Pass-update pushes: an empty JSON payload to each device holding a pass,
// over APNs (HTTP/2) with the Pass Type ID certificate as the TLS client
// certificate. Wallet then asks the web service what changed. Pass updates
// only go through production APNs, never the sandbox.

const http2 = require('http2');

const APNS_ORIGIN = 'https://api.push.apple.com';

// Push tokens are hex; anything else would change the request path.
const TOKEN_RE = /^[0-9a-fA-F]{16,200}$/;

function createPusher({ certPem, keyPem, topic, origin = APNS_ORIGIN, log = console.log }) {
  let session = null;

  function connect() {
    if (session && !session.closed && !session.destroyed) return session;
    const s = origin.startsWith('https:') ? http2.connect(origin, { cert: certPem, key: keyPem }) : http2.connect(origin);
    s.on('error', () => {});
    s.on('goaway', () => s.close());
    // Idle connections go after a minute; the next push opens a new one.
    s.setTimeout(60 * 1000, () => s.close());
    session = s;
    return s;
  }

  function pushOne(pushToken) {
    if (!TOKEN_RE.test(pushToken)) return Promise.resolve({ status: 0, reason: 'BadDeviceToken' });
    return new Promise((resolve) => {
      let req;
      try {
        req = connect().request({
          ':method': 'POST',
          ':path': `/3/device/${pushToken}`,
          'apns-topic': topic,
          'apns-push-type': 'background',
          'apns-priority': '5',
          'content-type': 'application/json'
        });
      } catch (e) {
        session = null;
        return resolve({ status: 0, error: String(e) });
      }
      let status = 0;
      let body = '';
      req.setTimeout(15 * 1000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on('response', (h) => { status = h[':status']; });
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let reason;
        try { reason = body ? JSON.parse(body).reason : undefined; } catch (e) { /* not JSON */ }
        resolve({ status, reason });
      });
      req.on('error', (e) => { session = null; resolve({ status: 0, error: String(e) }); });
      req.end('{}');
    });
  }

  // targets: [{ deviceId, pushToken }]. Returns each result; `gone` lists the
  // devices APNs says will never take a push again.
  async function push(targets, label) {
    const results = await Promise.all(targets.map(async (t) => ({ deviceId: t.deviceId, ...(await pushOne(t.pushToken)) })));
    results.forEach((r) => log(`[wallet] push ${label} device ${r.deviceId.slice(0, 8)}: ${r.status}${r.reason ? ' ' + r.reason : ''}${r.error ? ' ' + r.error : ''}`));
    const gone = results.filter((r) => r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered').map((r) => r.deviceId);
    return { results, gone };
  }

  return { push, close: () => session && session.close() };
}

module.exports = { createPusher, APNS_ORIGIN };
