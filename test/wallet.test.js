// The movie pass (lib/wallet/): what it says in each state, and Apple's
// web service end to end -- a device registers, something changes, a push
// goes out, the device gets the new pass.
//
// Run with `npm test`.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const http2 = require('http2');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { buildPass } = require('../lib/wallet/passContent');

const H = 60 * 60 * 1000;
const DAY = 24 * H;

// ---------------- What the pass says ----------------

// A showtime `inMs` from `now`, its date and time read in San Francisco.
function showAt(now, inMs, extra = {}) {
  const at = now + inMs;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return {
    id: 'show-1', title: 'The Rings of Power', date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`,
    screen: 'amc-metreon-13', price: 17.49, ordersClosed: false, aListSwap: false,
    seats: {
      F8: { status: 'assigned', name: 'Ana Alvarez', personId: 'p-ana', paid: false, concessions: [] },
      F9: { status: 'assigned', name: 'Sam', personId: 'p-ana', guest: true, paid: false, concessions: [] }
    },
    ...extra,
    startsAt: at
  };
}

const AMC = { seats: ['F8', 'F9'], ticketCount: 2, barcode: { format: 'PKBarcodeFormatQR', message: '1122707601-1' } };

function pass(showtime, { now, passes = [], person = { id: 'p-ana', amcAList: false }, hasPoster = true } = {}) {
  return buildPass({
    passTypeIdentifier: 'pass.com.canopysf.tickets', teamIdentifier: 'TEAM', serialNumber: 's', authenticationToken: 't'.repeat(32),
    webServiceURL: 'https://tix.example/', siteUrl: 'https://tix.example/', siteHost: 'tix.example', venmoHandle: 'hal',
    person, next: showtime ? { showtime, seatIds: Object.keys(showtime.seats), startsAt: showtime.startsAt } : null,
    passes, upcoming: [], hasPoster, now
  });
}
const fieldOf = (json, key) => {
  const t = json.eventTicket;
  return [...(t.headerFields || []), ...(t.primaryFields || []), ...(t.secondaryFields || []), ...(t.auxiliaryFields || []), ...(t.backFields || [])].find((f) => f.key === key);
};

test('nothing booked: a classic pass that says so, with View Schedule', () => {
  const { poster, json } = pass(null, { now: Date.now() });
  assert.strictEqual(poster, false);
  assert.strictEqual(fieldOf(json, 'title').value, 'Nothing booked');
  assert.deepStrictEqual(json.featuredActions.map((a) => a.type), ['viewSchedule']);
  assert.ok(!json.barcodes && !json.preferredStyleSchemes);
});

// Wallet rejects (today: warns about) a pass with two fields on one key.
function assertUniqueKeys(json) {
  const t = json.eventTicket;
  const keys = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields'].flatMap((k) => (t[k] || []).map((f) => f.key));
  assert.deepStrictEqual(keys.filter((k, i) => keys.indexOf(k) !== i), [], 'duplicate field keys');
}

test('colours come from the poster, neutral without one', async () => {
  const now = Date.UTC(2026, 10, 1, 20);
  const show = showAt(now, 20 * DAY);
  const neutral = pass(show, { now }).json;
  assert.strictEqual(neutral.labelColor, 'rgb(220,220,220)');
  const tinted = buildPass({ ...{ passTypeIdentifier: 'p', teamIdentifier: 't', serialNumber: 's', authenticationToken: 'a'.repeat(32), webServiceURL: 'https://x/', siteUrl: 'https://x/', siteHost: 'x' },
    person: { id: 'p-ana' }, next: { showtime: show, seatIds: ['F8'], startsAt: show.startsAt }, passes: [], upcoming: [], hasPoster: true, now,
    colors: { label: 'rgb(175,205,233)', background: 'rgb(15,26,36)' } }).json;
  assert.strictEqual(tinted.labelColor, 'rgb(175,205,233)');
  assert.strictEqual(tinted.backgroundColor, 'rgb(15,26,36)');
  // A blue poster gives a light blue label; an orange one a light orange.
  const sharp = require('sharp');
  const { posterImages } = require('../lib/wallet/images');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-colors-'));
  const blue = path.join(dir, 'blue.png');
  await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: 20, g: 60, b: 160 } } }).png().toFile(blue);
  const c = (await posterImages({ getMetaByKey: () => ({ uploadedAt: 1 }), getFilePathByKey: (k) => k }, blue)).colors;
  const [r, g, b] = c.label.match(/\d+/g).map(Number);
  assert.ok(b > r && b > 200, c.label);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('during a deploy only the newer server updates passes', async () => {
  const { createWallet } = require('../lib/wallet/service');
  let recorded = null;
  const writerStore = { get: () => recorded, set: (v) => { recorded = v; } };
  const writes = [];
  const store = {
    getPerson: () => ({ id: 'p-ana', amcAList: false }), seatsOf: () => [], passesFor: () => [],
    setWalletContent: (serial, hash) => { writes.push(hash); return { serial, contentHash: hash, updatedAt: 1 }; }
  };
  const make = () => createWallet({ store, posterStore: {}, showtimeInstantMs: () => null, venmoHandle: () => null,
    siteOrigin: 'https://tix.example', writerStore, env: {}, log: () => {} });
  const old = make();
  await new Promise((r) => setTimeout(r, 5));
  const fresh = make();
  const wp = { serial: 's', personId: 'p-ana', authToken: 'a'.repeat(32), contentHash: 'stale', updatedAt: 1 };
  assert.strictEqual((await old.refresh(wp, Date.now())).changed, false);
  assert.strictEqual(writes.length, 0);
  assert.strictEqual((await fresh.refresh(wp, Date.now())).changed, true);
  assert.strictEqual(writes.length, 1);
});

test('the Wallet background fills both backgrounds; the poster stays the thumbnail', () => {
  const { passImages } = require('../lib/wallet/images');
  const r = (tag) => Object.fromEntries(['artwork@2x.png', 'artwork@3x.png', 'background@2x.png', 'thumbnail@2x.png', 'thumbnail@3x.png'].map((n) => [n, Buffer.from(tag + n)]));
  const poster = r('poster:'), art = r('art:');
  const both = passImages(poster, art, true);
  assert.strictEqual(String(both['thumbnail@2x.png']), 'poster:thumbnail@2x.png');
  assert.strictEqual(String(both['background@2x.png']), 'art:background@2x.png');
  assert.strictEqual(String(both['artwork@3x.png']), 'art:artwork@3x.png');
  assert.ok(both['primaryLogo@2x.png']);
  // No Wallet background: the poster does both jobs. Classic: no artwork.
  assert.strictEqual(String(passImages(poster, null, false)['background@2x.png']), 'poster:background@2x.png');
  assert.ok(!passImages(poster, art, false)['artwork@2x.png']);
});

test('early access: an alerting field with the movie, on an empty pass the front too', () => {
  const now = Date.UTC(2026, 10, 1, 20);
  const ea = { earlyAccess: { title: 'Godzilla x Kong: Supernova' } };
  const empty = buildPass({ passTypeIdentifier: 'p', teamIdentifier: 't', serialNumber: 's', authenticationToken: 'a'.repeat(32), webServiceURL: 'https://x/', siteUrl: 'https://x/', siteHost: 'x', person: { id: 'p' }, next: null, now, ...ea }).json;
  const f = fieldOf(empty, 'earlyAccess');
  assert.strictEqual(f.value, 'Godzilla x Kong: Supernova tickets available. Tap "View Schedule" to reserve a seat.');
  assert.strictEqual(f.changeMessage, '%@');
  assert.strictEqual(fieldOf(empty, 'title').value, 'Godzilla x Kong: Supernova');
  // Without any: the field's still there (so the alert is a change of value), silent.
  const none = fieldOf(pass(null, { now }).json, 'earlyAccess');
  assert.strictEqual(none.value, 'None right now');
  assert.strictEqual(none.changeMessage, undefined);
  // Booked for something else: on the back.
  const show = showAt(now, 20 * DAY);
  const booked = buildPass({ passTypeIdentifier: 'p', teamIdentifier: 't', serialNumber: 's', authenticationToken: 'a'.repeat(32), webServiceURL: 'https://x/', siteUrl: 'https://x/', siteHost: 'x', person: { id: 'p-ana' }, next: { showtime: show, seatIds: ['F8'], startsAt: show.startsAt }, passes: [], upcoming: [], now, ...ea }).json;
  assert.strictEqual(fieldOf(booked, 'earlyAccess').changeMessage, '%@');
  // The notification's title, fixed.
  assert.strictEqual(empty.organizationName, 'Canopy Tickets');
  assert.strictEqual(booked.organizationName, 'Canopy Tickets');
  assertUniqueKeys(booked);
});

test('field keys are unique in every state', () => {
  const now = Date.UTC(2026, 10, 1, 20);
  const paid = showAt(now, 2 * H);
  paid.seats.F8.paid = true;
  paid.seats.F9.paid = true;
  [pass(null, { now }), pass(showAt(now, 20 * DAY), { now }), pass(showAt(now, 3 * H), { now, passes: [AMC] }), pass(paid, { now, passes: [AMC] })]
    .forEach(({ json }) => assertUniqueKeys(json));
});

test('booked, weeks out: classic, Unpaid, seats as F8 and F9, no alert, Order while orders are open', () => {
  const now = Date.UTC(2026, 10, 1, 20);
  const { poster, json } = pass(showAt(now, 20 * DAY), { now, passes: [AMC] });
  assert.strictEqual(poster, false);
  assert.ok(!json.barcodes, 'no QR before the day');
  assert.strictEqual(fieldOf(json, 'ticket').value, 'Unpaid');
  assert.deepStrictEqual(json.semantics.seats, [{ seatNumber: 'F8' }, { seatNumber: 'F9' }]);
  assert.strictEqual(json.semantics.eventType, 'PKEventTypeMovie');
  assert.ok(!json.locations, 'lock screen by time, not place');
  assert.strictEqual(Date.parse(json.relevantDates[0].startDate), Date.parse(json.semantics.eventStartDate) - 1.5 * H);
  assert.strictEqual(fieldOf(json, 'reminder').changeMessage, undefined);
  assert.deepStrictEqual(json.featuredActions.map((a) => a.type), ['order', 'viewSchedule']);
});

test('reminders alert a week out and 24 hours out, and only then', () => {
  const now = Date.UTC(2026, 10, 1, 20);
  const week = fieldOf(pass(showAt(now, 7 * DAY - 60 * 1000), { now }).json, 'reminder');
  assert.match(week.value, /a week away/);
  assert.strictEqual(week.changeMessage, '%@');
  const day = fieldOf(pass(showAt(now, DAY - 60 * 1000), { now }).json, 'reminder');
  assert.match(day.value, /is tomorrow at .*\. Tap "Order" to order concessions\.$/);
  // A-List: food from AMC, and no alert when the cart closes.
  const alist = { now, person: { id: 'p-ana', amcAList: true } };
  assert.match(fieldOf(pass(showAt(now, DAY - 60 * 1000), alist).json, 'reminder').value, /is tomorrow at .*\. Order food in the AMC app\.$/);
  const closed = showAt(now, 3 * DAY, { ordersClosed: true });
  closed.seats.F8.concessions = [{ name: 'Popcorn', price: 9.99, qty: 1 }];
  assert.strictEqual(fieldOf(pass(closed, alist).json, 'concessions').changeMessage, undefined);
  // Booked three days out: "coming up", not "a week away".
  assert.match(fieldOf(pass(showAt(now, 3 * DAY), { now }).json, 'reminder').value, /is coming up: /);
  assert.strictEqual(day.changeMessage, '%@');
  const between = fieldOf(pass(showAt(now, 7 * DAY + H), { now }).json, 'reminder');
  assert.strictEqual(between.changeMessage, undefined);
});

test('4 hours out and still owing: the pay reminder, You owe, Pay for Ticket on the back', () => {
  const show = showAt(Date.UTC(2026, 10, 1, 20), 3 * H);
  const now = Date.UTC(2026, 10, 1, 20);
  const { json } = pass(show, { now, passes: [AMC] });
  assert.ok(!json.barcodes, 'no QR while owing');
  const r = fieldOf(json, 'reminder');
  assert.strictEqual(r.value, 'Reminder: Unpaid ticket. Tap "Order Delivery" to pay.');
  // The button it names is there while something's owed, even with food orders open or closed.
  assert.ok(json.featuredActions.some((a) => a.type === 'order'));
  assert.strictEqual(r.changeMessage, '%@');
  assert.strictEqual(fieldOf(json, 'owe').value, '$34.98');
  assert.match(fieldOf(json, 'pay').attributedValue, /<a href="https:\/\/venmo\.com\/hal\?txn=pay&amount=34\.98&note=[^"]+">Pay for Ticket<\/a>/);
});

test('day of, paid, AMC pass in: the poster style with the QR (no digits)', () => {
  const now = Date.UTC(2026, 10, 1, 20);
  const show = showAt(now, 2 * H);
  show.seats.F8.paid = true;
  show.seats.F9.paid = true;
  const { poster, json } = pass(show, { now, passes: [AMC] });
  assert.strictEqual(poster, true);
  assert.deepStrictEqual(json.preferredStyleSchemes, ['posterEventTicket', 'eventTicket']);
  assert.strictEqual(json.semantics.venueName, 'AMC Metreon 16 \u00b7 Aud 13', 'the poster face shows the auditorium');
  assert.deepStrictEqual(json.barcodes, [{ format: 'PKBarcodeFormatQR', message: '1122707601-1', messageEncoding: 'iso-8859-1' }]);
  assert.strictEqual(fieldOf(json, 'paid').value, 'Paid ✓');
  // No poster uploaded: still the QR, on the classic pass.
  const plain = pass(show, { now, passes: [AMC], hasPoster: false });
  assert.strictEqual(plain.poster, false);
  assert.ok(plain.json.barcodes && !plain.json.preferredStyleSchemes);
});

test('day of, paid, no AMC pass yet: Available Soon', () => {
  const now = Date.UTC(2026, 10, 1, 20);
  const show = showAt(now, 2 * H);
  show.seats.F8.paid = true;
  show.seats.F9.paid = true;
  const { poster, json } = pass(show, { now });
  assert.strictEqual(poster, false);
  assert.strictEqual(fieldOf(json, 'ticket').value, 'Available Soon');
});

test('food: $x ✓ while open; Concessions Ordered alert once the order is final', () => {
  const now = Date.UTC(2026, 10, 1, 20);
  const show = showAt(now, 3 * DAY);
  show.seats.F8.concessions = [{ name: 'Popcorn', price: 9.99, qty: 1 }];
  assert.strictEqual(fieldOf(pass(show, { now }).json, 'food').value, '$10.85 ✓');
  show.ordersClosed = true;
  const { json } = pass(show, { now });
  const c = fieldOf(json, 'concessions');
  assert.strictEqual(c.value, 'Concessions ordered. Tap "Order Delivery" to pay.');
  assert.strictEqual(c.changeMessage, '%@');
  // Food owed: the order button stays, since the alert says to pay with it.
  assert.deepStrictEqual(json.featuredActions.map((a) => a.type), ['order', 'viewSchedule']);
});

test('an A-List swap seat: A-List Swap, no QR for it', () => {
  const now = Date.UTC(2026, 10, 1, 20);
  const show = showAt(now, 2 * H, { aListSwap: true });
  delete show.seats.F9;
  const { json } = pass(show, { now, passes: [AMC], person: { id: 'p-ana', amcAList: true } });
  assert.strictEqual(fieldOf(json, 'ticket').value, 'A-List Swap');
  assert.ok(!json.barcodes);
});

// ---------------- The web service, end to end ----------------

let haveOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch (e) { haveOpenssl = false; }

let account, apns, tickets, base, dataDir, output = '';
const pushes = [];
const TOKEN = 'w'.repeat(43);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

before(async () => {
  if (!haveOpenssl) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-wallet-test-'));
  // A throwaway certificate: the web service doesn't care who signed.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=test', '-days', '1',
    '-keyout', path.join(dataDir, 'k.pem'), '-out', path.join(dataDir, 'c.pem')], { stdio: 'ignore' });

  const wendy = { id: 'p-wendy', email: 'w@example.com', emailVerified: true, firstName: 'Wendy', lastName: 'W', shortName: 'Wendy W.', photoUrl: null, findable: true, venmo: null, phone: null, instagram: null, cashapp: null };
  account = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/session')) return res.end(JSON.stringify(req.headers['x-canopy-session'] === TOKEN ? { person: wendy } : { person: null }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => account.listen(0, '127.0.0.1', r));
  apns = http2.createServer((req, res) => { pushes.push({ path: req.url, topic: req.headers['apns-topic'] }); res.writeHead(200); res.end(); });
  await new Promise((r) => apns.listen(0, '127.0.0.1', r));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const cert = fs.readFileSync(path.join(dataDir, 'c.pem'), 'utf8');
  tickets = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir,
      CANOPY_ACCOUNT_URL: `http://127.0.0.1:${account.address().port}`, CANOPY_ACCOUNT_KEY: 'cnp_test',
      WALLET_CERT_PEM: cert, WALLET_KEY_PEM: fs.readFileSync(path.join(dataDir, 'k.pem'), 'utf8'), WALLET_WWDR_PEM: cert,
      WALLET_APNS_ORIGIN: `http://127.0.0.1:${apns.address().port}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  tickets.stdout.on('data', (d) => { output += d; });
  tickets.stderr.on('data', (d) => { output += d; });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { await fetch(`${base}/api/calendar/x`); break; } catch (e) {
      if (Date.now() > deadline) throw new Error('tickets did not start:\n' + output);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

after(() => {
  if (tickets) tickets.kill();
  if (account) account.close();
  if (apns) apns.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// pass.json out of a .pkpass (a zip, entries deflated or stored).
function passJsonOf(buf) {
  for (let i = 0; i + 30 < buf.length; ) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8), size = buf.readUInt32LE(i + 18), nameLen = buf.readUInt16LE(i + 26), extra = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString();
    const data = buf.slice(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    if (name === 'pass.json') return JSON.parse((method === 8 ? zlib.inflateRawSync(data) : data).toString());
    i += 30 + nameLen + extra + size;
  }
  throw new Error('no pass.json');
}

test('add the pass, register a device, change something, the device is pushed and gets the new pass', { skip: !haveOpenssl && 'needs openssl' }, async () => {
  const cookie = { Cookie: `canopy_session=${TOKEN}` };
  const cfg = await (await fetch(`${base}/api/public/config`, { headers: cookie })).json();
  assert.strictEqual(cfg.walletPass, true);
  assert.strictEqual(cfg.walletPassAdded, false);

  const res = await fetch(`${base}/api/public/wallet-pass.pkpass`, { headers: cookie });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'application/vnd.apple.pkpass');
  const json = passJsonOf(Buffer.from(await res.arrayBuffer()));
  assert.strictEqual(json.eventTicket.primaryFields[0].value, 'Nothing booked');
  const { serialNumber: serial, authenticationToken: auth, passTypeIdentifier: type } = json;
  const lastModified = res.headers.get('last-modified');
  // Kept on disk, ready for the next request.
  assert.ok(fs.readdirSync(path.join(dataDir, 'wallet-passes')).some((f) => f.startsWith(serial + '.') && f.endsWith('.pkpass')));

  const reg = (token, deviceToken = 'abcdef0123456789abcd') => fetch(`${base}/v1/devices/dev-1/registrations/${type}/${serial}`, {
    method: 'POST', headers: { Authorization: `ApplePass ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pushToken: deviceToken })
  });
  assert.strictEqual((await reg('wrong')).status, 401);
  assert.strictEqual((await reg(auth)).status, 201);
  assert.strictEqual((await reg(auth)).status, 200);
  assert.strictEqual((await (await fetch(`${base}/api/public/config`, { headers: cookie })).json()).walletPassAdded, true);

  const unchanged = await fetch(`${base}/v1/passes/${type}/${serial}`, { headers: { Authorization: `ApplePass ${auth}`, 'If-Modified-Since': lastModified } });
  assert.strictEqual(unchanged.status, 304);
  const list = await fetch(`${base}/v1/devices/dev-1/registrations/${type}?passesUpdatedSince=${Math.floor(Date.parse(lastModified) / 1000)}`);
  assert.strictEqual(list.status, 204);

  // Wendy is the first person, so the admin: she makes a showtime and takes
  // a seat in it. A few seconds later her device is pushed.
  const api = (p, method, body) => fetch(base + p, { method, headers: { ...cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const movie = (await (await api('/api/movies', 'POST', { title: 'Wallet Test' })).json()).movie;
  const d = new Date(Date.now() + 10 * DAY);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const show = (await (await api(`/api/movies/${movie.id}/showtimes`, 'POST', { date, time: '19:30', price: 17.49 })).json()).showtime;
  assert.strictEqual((await api(`/api/showtimes/${show.id}/seats/F8`, 'PUT', { name: 'Wendy W', personId: 'p-wendy' })).status, 200);

  const deadline = Date.now() + 10000;
  while (!pushes.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(pushes[0], { path: '/3/device/abcdef0123456789abcd', topic: 'pass.com.canopysf.tickets' });

  const changed = await fetch(`${base}/v1/devices/dev-1/registrations/${type}?passesUpdatedSince=${Math.floor(Date.parse(lastModified) / 1000)}`);
  assert.strictEqual(changed.status, 200);
  assert.deepStrictEqual((await changed.json()).serialNumbers, [serial]);
  const fresh = await fetch(`${base}/v1/passes/${type}/${serial}`, { headers: { Authorization: `ApplePass ${auth}`, 'If-Modified-Since': lastModified } });
  assert.strictEqual(fresh.status, 200);
  const updated = passJsonOf(Buffer.from(await fresh.arrayBuffer()));
  assert.strictEqual(updated.eventTicket.primaryFields[0].value, 'Wallet Test');
  assert.deepStrictEqual(updated.semantics.seats, [{ seatNumber: 'F8' }]);

  // Taken out of Wallet: the device goes.
  const del = await fetch(`${base}/v1/devices/dev-1/registrations/${type}/${serial}`, { method: 'DELETE', headers: { Authorization: `ApplePass ${auth}` } });
  assert.strictEqual(del.status, 200);
  assert.strictEqual((await (await fetch(`${base}/api/public/config`, { headers: cookie })).json()).walletPassAdded, false);
});
