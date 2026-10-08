// Who gets in: the real server in a child process on a scratch DATA_DIR,
// against a fake account service whose sessions the tests set.
//
// Run with `npm test`.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const CALENDAR_SECRET = 'test-calendar-secret';
const VERIFIED = 'v'.repeat(43);    // Vera, email confirmed
const QUICK = 'q'.repeat(43);       // Quinn, a quick sign-up, not confirmed (yet)

// token -> what /api/session answers for it.
const sessions = new Map();
// token -> how many times /api/session was asked about it.
const asked = new Map();

const vera = { id: 'p-vera', email: 'vera@example.com', emailVerified: true, firstName: 'Vera', lastName: 'V', shortName: 'Vera V.', photoUrl: null, findable: true, venmo: null, phone: null, instagram: null, cashapp: null };
const quinn = { id: 'p-quinn', email: 'quinn@example.com', emailVerified: true, firstName: 'Quinn', lastName: 'Q', shortName: 'Quinn Q.', photoUrl: null, findable: true, venmo: null, phone: null, instagram: null, cashapp: null };

let account;
let accountUrl;
let tickets;
let base;
let output = '';
let dataDir;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

before(async () => {
  // The account service's /api/session, as it answers a site that doesn't
  // let unverified accounts in: { person: null, unverified: true } for them.
  account = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/session')) {
      const token = req.headers['x-canopy-session'];
      asked.set(token, (asked.get(token) || 0) + 1);
      return res.end(JSON.stringify(sessions.get(token) || { person: null }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => account.listen(0, '127.0.0.1', resolve));
  accountUrl = `http://127.0.0.1:${account.address().port}`;
  sessions.set(VERIFIED, { person: vera });
  sessions.set(QUICK, { person: null, unverified: true });

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-tickets-test-'));
  tickets = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      CANOPY_ACCOUNT_URL: accountUrl,
      CANOPY_ACCOUNT_KEY: 'cnp_test',
      CANOPY_CALENDAR_SECRET: CALENDAR_SECRET
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  tickets.stdout.on('data', (d) => { output += d; });
  tickets.stderr.on('data', (d) => { output += d; });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      await fetch(`${base}/api/calendar/x`);
      break;
    } catch (e) {
      if (Date.now() > deadline) throw new Error('tickets did not start:\n' + output);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

after(() => {
  if (tickets) tickets.kill();
  if (account) account.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// A page load as a browser makes it, never following a redirect.
function page(urlPath, token) {
  return fetch(base + urlPath, {
    redirect: 'manual',
    headers: { Accept: 'text/html', ...(token ? { Cookie: `canopy_session=${token}` } : {}) }
  });
}

function api(urlPath, token, init = {}) {
  return fetch(base + urlPath, {
    redirect: 'manual',
    ...init,
    headers: { Origin: base, 'Content-Type': 'application/json', ...(token ? { Cookie: `canopy_session=${token}` } : {}), ...(init.headers || {}) }
  });
}

const attr = (html, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(html);
  return m ? m[1].replace(/&amp;/g, '&') : null;
};
const isSignInPage = (html) => html.includes('id="signInBtn"');
const isReservationPage = (html) => html.includes('id="calendarOverlay"');

test('an unverified session gets the confirm-your-email page, not a redirect', async () => {
  for (const where of ['/', '/admin']) {
    const res = await page(where, QUICK);
    assert.strictEqual(res.status, 200, `${where} answered ${res.status} ${res.headers.get('location') || ''}`);
    const html = await res.text();
    assert.ok(isSignInPage(html) && !isReservationPage(html));
    // The card that says so: Verify my email to the account service's
    // confirm step and back here, and Sign out.
    const verify = attr(html, 'data-verify');
    assert.strictEqual(verify, `${accountUrl}/profile?verify=1&return=${encodeURIComponent(base + where)}`);
    assert.ok(html.includes(`href="${verify.replace(/&/g, '&amp;')}"`), 'Verify my email links to it');
    assert.ok(html.includes(`href="${accountUrl}/signout?return=${encodeURIComponent(base + '/')}"`), 'Sign out links to the account service');
    assert.ok(html.includes('data-copy="signin.unverified"') && html.includes('data-copy="signin.verify"'));
  }
  const copy = fs.readFileSync(path.join(__dirname, '..', 'public', 'copy.js'), 'utf8');
  assert.ok(copy.includes("'You need a verified email address to use Canopy Tickets.'"));
  assert.ok(copy.includes("verify: 'Verify my email'"));
});

test("an unverified session's API calls are a 403 email_unverified with where to verify", async () => {
  const calls = [
    ['/api/public/me', {}],
    ['/api/profile', { method: 'PATCH', body: JSON.stringify({ peanutAllergy: true }) }],
    ['/api/movies', {}]
  ];
  for (const [where, init] of calls) {
    const res = await api(where, QUICK, { ...init, headers: { Referer: `${base}/` } });
    assert.strictEqual(res.status, 403, where);
    const body = await res.json();
    assert.strictEqual(body.reason, 'email_unverified', where);
    assert.strictEqual(body.verify, `${accountUrl}/profile?verify=1&return=${encodeURIComponent(base + '/')}`, where);
  }
});

test('the pages reload on email_unverified the way they do on a 401', () => {
  for (const file of ['public.html', 'admin.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', file), 'utf8');
    assert.ok(/async function handleAuthFailure\(res\)\{\s*if \(res\.status === 403\)\{[\s\S]*?'email_unverified'/.test(html), file);
  }
});

test('nobody signed in still gets the sign-in page and 401s', async () => {
  const html = await (await page('/')).text();
  assert.ok(isSignInPage(html));
  assert.strictEqual(attr(html, 'data-verify'), '');
  assert.strictEqual((await api('/api/public/me')).status, 401);
});

test('a verified person is let in, and asked about once a minute as before', async () => {
  const before = asked.get(VERIFIED) || 0;
  const res = await page('/', VERIFIED);
  assert.strictEqual(res.status, 200);
  assert.ok(isReservationPage(await res.text()));
  const me = await api('/api/public/me', VERIFIED);
  assert.strictEqual(me.status, 200);
  assert.strictEqual((await me.json()).person.id, vera.id);
  assert.strictEqual((await page('/', VERIFIED)).status, 200);
  assert.strictEqual((asked.get(VERIFIED) || 0) - before, 1, 'the cached answer is used');
});

test('once they confirm their email they get in straight away, same session', async () => {
  assert.ok(isSignInPage(await (await page('/', QUICK)).text()));
  // Confirming keeps the session: the account service just answers differently.
  sessions.set(QUICK, { person: quinn });
  const res = await page('/', QUICK);
  assert.strictEqual(res.status, 200);
  assert.ok(isReservationPage(await res.text()), 'not held out by the cached unverified answer');
  const me = await api('/api/public/me', QUICK);
  assert.strictEqual(me.status, 200);
  assert.strictEqual((await me.json()).person.id, quinn.id);
});

test('the calendar endpoint still checks the account service signature', async () => {
  const sign = (secret, personId, t) =>
    crypto.createHmac('sha256', secret).update(`canopy-calendar-v1\n${personId}\n${t}`).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  const ask = (personId, auth) => fetch(`${base}/api/calendar/${personId}`, { headers: auth ? { Authorization: auth } : {} });

  const ok = await ask(vera.id, `Canopy-Calendar t=${now}, sig=${sign(CALENDAR_SECRET, vera.id, now)}`);
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await ok.json(), { entries: [] });

  assert.strictEqual((await ask(vera.id)).status, 401);
  assert.strictEqual((await ask(vera.id, `Canopy-Calendar t=${now}, sig=${sign('wrong', vera.id, now)}`)).status, 401);
  assert.strictEqual((await ask(vera.id, `Canopy-Calendar t=${now - 600}, sig=${sign(CALENDAR_SECRET, vera.id, now - 600)}`)).status, 401);
  assert.strictEqual((await ask(vera.id, `Canopy-Calendar t=${now}, sig=${sign(CALENDAR_SECRET, 'p-someone-else', now)}`)).status, 401);
  // A session cookie or bearer token is no way in either.
  assert.strictEqual((await ask(vera.id, `Bearer ${VERIFIED}`)).status, 401);
});
