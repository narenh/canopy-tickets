// Wallet passes: reading a .pkpass, placing it on its showtime, the
// Shortcut's token upload, and who gets the ticket when (the day-of
// screen). The real server in a child process on a scratch DATA_DIR,
// against a fake account service, as in auth.test.js.
//
// Run with `npm test`.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const pkpass = require('../lib/pkpass');

const ADA = 'a'.repeat(43);   // signs in first, so she's the admin
const FRED = 'f'.repeat(43);  // a friend with seats
const NELL = 'n'.repeat(43);  // a friend with none

const person = (id, first) => ({ id, email: `${first.toLowerCase()}@example.com`, emailVerified: true, firstName: first, lastName: 'X', shortName: `${first} X.`, photoUrl: null, findable: true, venmo: null, phone: null, instagram: null, cashapp: null });
const sessions = new Map([[ADA, { person: person('p-ada', 'Ada') }], [FRED, { person: person('p-fred', 'Fred') }], [NELL, { person: person('p-nell', 'Nell') }]]);

let account;
let tickets;
let base;
let output = '';
let dataDir;

// ---- A .pkpass, made here ----

// A minimal zip, deflated, the way Wallet's passes are.
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  Object.entries(files).forEach(([name, content]) => {
    const raw = Buffer.from(content);
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// AMC's pass.json, as the real one has it.
// `when` overrides the time, written exactly as given (AMC's own form is
// "2026-04-07T19:00:00-07:00").
function amcPass({ serial, startsAt, when, auditorium = '13', seats = 'E8, E7', tickets: count = '2 ADULT', film = 'Test Movie', message = 'A0123456789' }) {
  const iso = when || new Date(startsAt).toISOString().replace('.000Z', 'Z');
  return zip({
    'pass.json': JSON.stringify({
      passTypeIdentifier: 'pass.com.amctheatres.ticketconfirmation',
      formatVersion: 1,
      serialNumber: serial,
      organizationName: 'American Multi-Cinema, Inc',
      relevantDate: iso,
      locations: [{ latitude: 37.78, longitude: -122.4, relevantText: 'AMC Metreon 16' }],
      eventTicket: {
        headerFields: [{ key: 'showtime', label: 'Today', value: iso }],
        secondaryFields: [{ key: 'filmName', label: 'AMC Metreon 16', value: film }],
        auxiliaryFields: [
          { key: 'auditorium', label: 'Auditorium', value: auditorium },
          { key: 'seatings', label: 'Seats', value: seats },
          { key: 'tickets', label: 'Tickets', value: count }
        ]
      },
      barcode: { format: 'PKBarcodeFormatQR', message, messageEncoding: 'iso-8859-1', altText: message.slice(1) }
    }),
    'manifest.json': '{}',
    'icon.png': 'not really a png'
  });
}

// San Francisco's wall clock at an instant: { date, time }.
function sfWall(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}` };
}

// Whole minutes, as a showtime's time is.
const minute = (ms) => Math.floor(ms / 60000) * 60000;

// ---- The server ----

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

before(async () => {
  account = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/session')) return res.end(JSON.stringify(sessions.get(req.headers['x-canopy-session']) || { person: null }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => account.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-tickets-passes-'));
  tickets = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, CANOPY_ACCOUNT_URL: `http://127.0.0.1:${account.address().port}`, CANOPY_ACCOUNT_KEY: 'cnp_test' },
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
  // Ada first: a brand-new install's first person is its admin.
  assert.strictEqual((await api('/api/public/me', ADA)).status, 200);
});

after(() => {
  if (tickets) tickets.kill();
  if (account) account.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

function api(urlPath, token, init = {}) {
  return fetch(base + urlPath, {
    redirect: 'manual',
    ...init,
    headers: { Origin: base, 'Content-Type': 'application/json', ...(token ? { Cookie: `canopy_session=${token}` } : {}), ...(init.headers || {}) }
  });
}

async function json(res, status) {
  const body = await res.json();
  if (status) assert.strictEqual(res.status, status, JSON.stringify(body));
  return body;
}

// A movie with a showtime at `startsAt` in auditorium 13 (Dolby), seats
// E7-E9 in the block, and Fred in E7 with a guest in E8.
async function showtimeWithFred(title, startsAt) {
  const { movie } = await json(await api('/api/movies', ADA, { method: 'POST', body: JSON.stringify({ title }) }));
  await json(await api(`/api/movies/${movie.id}`, ADA, { method: 'PATCH', body: JSON.stringify({ password: 'pw' }) }), 200);
  const { date, time } = sfWall(startsAt);
  const { showtime } = await json(await api(`/api/movies/${movie.id}/showtimes`, ADA, {
    method: 'POST', body: JSON.stringify({ date, time, screen: 'amc-metreon-13', price: 18 })
  }), 201);
  for (const seat of ['E7', 'E8', 'E9']) {
    await json(await api(`/api/showtimes/${showtime.id}/seats/${seat}`, ADA, { method: 'PUT', body: JSON.stringify({ name: '' }) }), 200);
  }
  await json(await api(`/api/public/movies/${movie.id}/unlock`, FRED, { method: 'POST', body: JSON.stringify({ password: 'pw' }) }), 200);
  await json(await api(`/api/public/showtimes/${showtime.id}/claim`, FRED, { method: 'POST', body: JSON.stringify({ seatId: 'E7' }) }), 200);
  await json(await api(`/api/public/showtimes/${showtime.id}/claim`, FRED, { method: 'POST', body: JSON.stringify({ seatId: 'E8', guestName: 'Gus' }) }), 200);
  return showtime;
}

// The Shortcut's upload: the file as the body, the token, no Origin and
// no cookie.
function shortcutUpload(file, token) {
  return fetch(`${base}/api/passes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.apple.pkpass', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: file
  });
}

// ---- lib/pkpass.js on its own ----

test('a .pkpass is read: serial, start, auditorium, seats in order, barcode', () => {
  const startsAt = Date.parse('2026-04-08T02:00:00Z');
  const p = pkpass.parsePkpass(amcPass({ serial: '1-1', startsAt, seats: 'E8, E7, E14, E13, E12, E11, E10, E9', tickets: '8 ADULT' }));
  assert.strictEqual(p.serial, '1-1');
  assert.strictEqual(p.startsAt, startsAt);
  assert.strictEqual(p.auditorium, '13');
  assert.deepStrictEqual(p.seats, ['E7', 'E8', 'E9', 'E10', 'E11', 'E12', 'E13', 'E14']);
  assert.strictEqual(p.ticketCount, 8);
  assert.strictEqual(p.barcode.message, 'A0123456789');
  assert.ok(pkpass.barcodeSvg(p.barcode).startsWith('<svg'));
});

test('anything that is not a pass is refused with a reason', () => {
  assert.throws(() => pkpass.parsePkpass(Buffer.from('hello, this is not a zip file at all')), /not a zip/);
  assert.throws(() => pkpass.parsePkpass(zip({ 'other.json': '{}' })), /no pass\.json/);
  assert.throws(() => pkpass.parsePkpass(zip({ 'pass.json': '{"serialNumber":"x","boardingPass":{}}' })), /isn't a movie ticket/);
});

test('matching: start time, then auditorium, then seats', () => {
  const at = Date.parse('2026-04-08T02:00:00Z');
  const instantOf = (date, time) => Date.parse(`${date}T${time}:00-07:00`);
  const show = (id, screen, seats) => ({ id, date: '2026-04-07', time: '19:00', screen, seats: Object.fromEntries(seats.map((s) => [s, { status: 'assigned' }])) });
  const pass = { startsAt: at, auditorium: '13', seats: ['E7', 'E8'] };
  assert.strictEqual(pkpass.matchShowtime(pass, [show('a', 'amc-metreon-13', []), show('b', 'amc-metreon-16', [])], instantOf).showtime.id, 'a');
  // Two at the same time in the same auditorium: the one holding the seats.
  assert.strictEqual(pkpass.matchShowtime(pass, [show('a', 'amc-metreon-13', ['F1']), show('b', 'amc-metreon-13', ['E7', 'E8'])], instantOf).showtime.id, 'b');
  assert.match(pkpass.matchShowtime(pass, [show('a', 'amc-metreon-13', []), show('b', 'amc-metreon-13', [])], instantOf).reason, /more than one/);
  assert.match(pkpass.matchShowtime(pass, [show('a', 'amc-metreon-16', [])], instantOf).reason, /auditorium 13/);
  assert.match(pkpass.matchShowtime({ ...pass, startsAt: at + 3600000 }, [show('a', 'amc-metreon-13', [])], instantOf).reason, /no showtime starts/);
});

// ---- Through the server ----

test('the Shortcut uploads with its token, and the pass lands on its showtime', async () => {
  const startsAt = minute(Date.now() + 30 * 60 * 1000);
  const show = await showtimeWithFred('Soon Movie', startsAt);

  // No token yet: refused. Then Ada makes one.
  assert.strictEqual((await shortcutUpload(amcPass({ serial: 'soon-1', startsAt }), 'nope')).status, 401);
  const { token } = await json(await api('/api/pass-upload-token', ADA, { method: 'POST' }), 200);
  assert.ok(token && token.length >= 30);
  // Friends can't see or make it.
  assert.strictEqual((await api('/api/pass-upload-token', FRED)).status, 401);

  assert.strictEqual((await shortcutUpload(amcPass({ serial: 'soon-1', startsAt }), 'wrong')).status, 401);
  // Without the token it's an ordinary POST, which needs this site's Origin.
  assert.strictEqual((await shortcutUpload(amcPass({ serial: 'soon-1', startsAt }))).status, 403);

  const first = await json(await shortcutUpload(amcPass({ serial: 'soon-1', startsAt }), token), 201);
  assert.strictEqual(first.status, 'matched');
  assert.strictEqual(first.pass.showtime.id, show.id);
  assert.match(first.message, /^Added: Soon Movie, .*2 seats \(E7–E8\)\.$/);

  // The same pass again replaces it rather than adding a second.
  const again = await json(await shortcutUpload(amcPass({ serial: 'soon-1', startsAt }), token), 200);
  assert.match(again.message, /^Updated: /);
  const { passes } = await json(await api('/api/passes', ADA), 200);
  assert.strictEqual(passes.filter((p) => p.showtime && p.showtime.id === show.id).length, 1);
  // The admin list doesn't carry the barcode.
  assert.ok(!JSON.stringify(passes).includes('A0123456789'));
});

test('the admin page uploads as a form, signed in', async () => {
  const startsAt = minute(Date.now() + 26 * 60 * 60 * 1000);
  const form = new FormData();
  form.append('file', new Blob([amcPass({ serial: 'form-1', startsAt })]), 'Pass.pkpass');
  const res = await fetch(`${base}/api/passes`, { method: 'POST', body: form, headers: { Origin: base, Cookie: `canopy_session=${ADA}` } });
  const body = await json(res, 201);
  // Nothing at that time: kept, unplaced, with why.
  assert.strictEqual(body.status, 'unplaced');
  assert.match(body.message, /no showtime starts at that time/);
  // A friend can't upload.
  const fred = await fetch(`${base}/api/passes`, { method: 'POST', body: form, headers: { Origin: base, Cookie: `canopy_session=${FRED}` } });
  assert.strictEqual(fred.status, 401);
});

test('the day-of screen: the next showtime today, and its ticket from an hour before', async () => {
  const { dayOf } = await json(await api('/api/public/day-of', FRED), 200);
  assert.ok(dayOf, 'Fred has a showtime in half an hour');
  assert.strictEqual(dayOf.showtime.title, 'Soon Movie');
  assert.deepStrictEqual(dayOf.seatIds.slice().sort(), ['E7', 'E8']);
  assert.strictEqual(dayOf.passes.length, 1);
  const [pass] = dayOf.passes;
  assert.ok(pass.qrSvg.startsWith('<svg'));
  assert.deepStrictEqual(pass.mySeats, ['E7', 'E8']);
  // The screen shows the code, not its digits.
  const raw = JSON.stringify(dayOf);
  assert.ok(!raw.includes('A0123456789') && !raw.includes('0123456789'));

  // Add to Apple Wallet: AMC's file, untouched.
  const file = await api(pass.walletUrl, FRED);
  assert.strictEqual(file.status, 200);
  assert.strictEqual(file.headers.get('content-type'), 'application/vnd.apple.pkpass');
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.strictEqual(pkpass.parsePkpass(bytes).serial, 'soon-1');

  // Nobody without a seat gets it.
  assert.strictEqual((await api(pass.walletUrl, NELL)).status, 404);
  assert.strictEqual((await json(await api('/api/public/day-of', NELL), 200)).dayOf, null);
});

test("a later showtime the same day waits its turn, and its ticket isn't out early", async () => {
  // Tomorrow-safe: three hours on is still today unless it's late in the
  // evening, in which case it's simply not today's -- either way it must
  // not take over from the one in half an hour.
  const startsAt = minute(Date.now() + 3 * 60 * 60 * 1000);
  const show = await showtimeWithFred('Later Movie', startsAt);
  const { token } = await json(await api('/api/pass-upload-token', ADA), 200);
  const up = await json(await shortcutUpload(amcPass({ serial: 'later-1', startsAt }), token), 201);
  assert.strictEqual(up.pass.showtime.id, show.id);

  const { dayOf } = await json(await api('/api/public/day-of', FRED), 200);
  assert.strictEqual(dayOf.showtime.title, 'Soon Movie');

  const res = await api(`/api/public/passes/${up.pass.id}.pkpass`, FRED);
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).reason, 'too_early');
});

test('two orders for one showtime are both kept on it', async () => {
  const startsAt = minute(Date.now() + 40 * 60 * 1000);
  const show = await showtimeWithFred('Split Movie', startsAt);
  const { token } = await json(await api('/api/pass-upload-token', ADA), 200);
  await json(await shortcutUpload(amcPass({ serial: 'split-1', startsAt, seats: 'E9', tickets: '1 ADULT', message: 'A111' }), token), 201);
  const mine = await json(await shortcutUpload(amcPass({ serial: 'split-2', startsAt, seats: 'E7, E8', message: 'A222' }), token), 201);
  assert.strictEqual(mine.pass.showtime.id, show.id);
  // Split Movie starts after Soon Movie, so Fred's screen is still that
  // one; what matters here is which of Split's passes are his.
  const lookup = await json(await api('/api/passes', ADA), 200);
  const split = lookup.passes.filter((p) => p.showtime && p.showtime.id === show.id);
  assert.strictEqual(split.length, 2);
});

test('an unplaced pass is placed by hand', async () => {
  const { passes } = await json(await api('/api/passes', ADA), 200);
  const loose = passes.find((p) => !p.showtime);
  const target = passes.find((p) => p.showtime).showtime;
  const placed = await json(await api(`/api/passes/${loose.id}`, ADA, { method: 'PATCH', body: JSON.stringify({ showtimeId: target.id }) }), 200);
  assert.strictEqual(placed.pass.showtime.id, target.id);
  assert.strictEqual(placed.pass.unmatched, null);
  assert.strictEqual((await api(`/api/passes/${loose.id}`, FRED, { method: 'PATCH', body: JSON.stringify({ showtimeId: null }) })).status, 401);
  assert.strictEqual((await api(`/api/passes/${loose.id}`, ADA, { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, 'passes', `${loose.id}.pkpass`)));
});

test('the reservation page carries the Wallet badge inline', async () => {
  const res = await fetch(`${base}/`, { headers: { Cookie: `canopy_session=${FRED}`, Accept: 'text/html' } });
  const html = await res.text();
  assert.ok(html.includes('id="dayOfOverlay"'));
  assert.ok(html.includes('src="data:image/svg+xml;base64,'));
  assert.ok(!html.includes('__WALLET_BADGE_SRC__'));
});

test("a December show's pass carrying October's offset still matches, by its wall clock", async () => {
  // AMC writes the offset in force when the ticket was bought: -07:00 in
  // October, for a show that will be at -08:00. Wallet ignores it and
  // shows 7:00 PM; so does the match.
  const { movie } = await json(await api('/api/movies', ADA, { method: 'POST', body: JSON.stringify({ title: 'Winter Movie' }) }));
  const { showtime } = await json(await api(`/api/movies/${movie.id}/showtimes`, ADA, {
    method: 'POST', body: JSON.stringify({ date: '2026-12-14', time: '19:00', screen: 'amc-metreon-13' })
  }), 201);
  const { token } = await json(await api('/api/pass-upload-token', ADA), 200);
  const up = await json(await shortcutUpload(amcPass({ serial: 'winter-1', when: '2026-12-14T19:00:00-07:00' }), token), 201);
  assert.strictEqual(up.status, 'matched', up.message);
  assert.strictEqual(up.pass.showtime.id, showtime.id);
  // Said, and kept, as the real 7:00 PM -- PST, not an hour out.
  assert.match(up.message, /Mon, Dec 14, 7:00 PM/);
  assert.strictEqual(up.pass.startsAt, Date.parse('2026-12-14T19:00:00-08:00'));
});

test('a pass uploaded before its showtime existed gets placed once it does', async () => {
  const { token } = await json(await api('/api/pass-upload-token', ADA), 200);
  const up = await json(await shortcutUpload(amcPass({ serial: 'early-1', when: '2026-12-20T13:30:00-07:00', auditorium: '16' }), token), 201);
  assert.strictEqual(up.status, 'unplaced');
  const { movie } = await json(await api('/api/movies', ADA, { method: 'POST', body: JSON.stringify({ title: 'Matinee Movie' }) }));
  const { showtime } = await json(await api(`/api/movies/${movie.id}/showtimes`, ADA, {
    method: 'POST', body: JSON.stringify({ date: '2026-12-20', time: '13:30', screen: 'amc-metreon-16' })
  }), 201);
  // Settings asks for the list, which tries the unplaced ones again.
  const { passes } = await json(await api('/api/passes', ADA), 200);
  const placed = passes.find((p) => p.id === up.pass.id);
  assert.strictEqual(placed.showtime && placed.showtime.id, showtime.id);
  assert.strictEqual(placed.unmatched, null);
});

test('the host moves someone to another open seat, paid and ordered as they were', async () => {
  const startsAt = minute(Date.now() + 5 * 24 * 60 * 60 * 1000);
  const show = await showtimeWithFred('Moving Movie', startsAt);
  await json(await api(`/api/public/showtimes/${show.id}/seats/E7/paid`, FRED, { method: 'PUT', body: JSON.stringify({ ticket: true }) }), 200);
  const order = [{ itemId: 'x', name: 'Popcorn', price: 9, qty: 1 }];
  await json(await api(`/api/public/showtimes/${show.id}/seats/E7/concessions`, FRED, { method: 'PUT', body: JSON.stringify({ items: order }) }), 200);

  // E8 is Fred's guest: not open, so no.
  assert.strictEqual((await api(`/api/showtimes/${show.id}/seats/E7/move`, ADA, { method: 'POST', body: JSON.stringify({ to: 'E8' }) })).status, 409);
  // A friend can't move anyone.
  assert.strictEqual((await api(`/api/showtimes/${show.id}/seats/E7/move`, FRED, { method: 'POST', body: JSON.stringify({ to: 'E9' }) })).status, 401);

  const { showtime } = await json(await api(`/api/showtimes/${show.id}/seats/E7/move`, ADA, { method: 'POST', body: JSON.stringify({ to: 'E9' }) }), 200);
  assert.strictEqual(showtime.seats.E9.name, 'Fred X');
  assert.strictEqual(showtime.seats.E9.paid, true);
  assert.strictEqual(showtime.seats.E9.concessions.length, 1);
  // E7 stays in the block, open.
  assert.strictEqual(showtime.seats.E7.status, 'assigned');
  assert.strictEqual(showtime.seats.E7.name, '');
  // Still Fred's seat as far as he's concerned.
  const { items } = await json(await api('/api/public/mine', FRED), 200);
  const mine = items.find((i) => i.showtime.id === show.id);
  assert.deepStrictEqual(mine.seatIds.slice().sort(), ['E8', 'E9']);
});
