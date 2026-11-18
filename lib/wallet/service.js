// The movie pass: one Apple Wallet pass per person that always shows their
// next showtime (see passContent.js for what it says, README.md "The movie
// pass" for the whole picture).
//
// - Someone adds it from My Showtimes (GET /api/public/wallet-pass.pkpass).
// - Wallet registers the device with this server and gets a push token
//   (Apple's "web service": the /v1/... routes below, authenticated by the
//   pass's own token, never by the account cookie).
// - A sweep rebuilds every pass once a minute, and a few seconds after any
//   change made through the site. A pass whose content changed gets a new
//   updated_at and an empty push to each device holding it; Wallet then
//   asks which passes changed and downloads them.
//
// Off unless WALLET_CERT_PEM, WALLET_KEY_PEM and WALLET_WWDR_PEM are set.

const crypto = require('crypto');
const express = require('express');
const { loadSigner } = require('./sign');
const { buildPkpass } = require('./pkpass');
const { createPusher, APNS_ORIGIN } = require('./apns');
const { buildPass } = require('./passContent');
const { posterImages, passImages } = require('./images');

const SWEEP_EVERY_MS = 60 * 1000;
const SWEEP_AFTER_CHANGE_MS = 3 * 1000;
// A showtime stays someone's "next" until this long after it starts, like
// the day-of screen.
const NEXT_UNTIL_AFTER_START_MS = 20 * 60 * 1000;

// A PEM pasted into an env var may have its newlines as literal \n.
function pemFromEnv(value) {
  return value ? String(value).replace(/\\n/g, '\n').trim() + '\n' : '';
}

function createWallet({ store, posterStore, showtimeInstantMs, venmoHandle, siteOrigin, env = process.env, log = console.log }) {
  const config = {
    passTypeIdentifier: env.WALLET_PASS_TYPE_ID || 'pass.com.canopysf.tickets',
    teamIdentifier: env.WALLET_TEAM_ID || 'UC3Y84QJ83',
    certPem: pemFromEnv(env.WALLET_CERT_PEM),
    keyPem: pemFromEnv(env.WALLET_KEY_PEM),
    wwdrPem: pemFromEnv(env.WALLET_WWDR_PEM),
    webServiceURL: env.WALLET_WEB_SERVICE_URL || `${siteOrigin}/`,
    apnsOrigin: env.WALLET_APNS_ORIGIN || APNS_ORIGIN
  };
  const enabled = !!(config.certPem.trim() && config.keyPem.trim() && config.wwdrPem.trim());
  const siteUrl = `${siteOrigin}/`;
  const siteHost = new URL(siteOrigin).host;

  let signerPromise = null;
  const signer = () => {
    if (!signerPromise) {
      signerPromise = loadSigner(config);
      signerPromise.catch((e) => { log(`[wallet] signing setup failed: ${e.message}`); signerPromise = null; });
    }
    return signerPromise;
  };
  const pusher = enabled ? createPusher({ certPem: config.certPem, keyPem: config.keyPem, topic: config.passTypeIdentifier, origin: config.apnsOrigin, log }) : null;

  // What someone's pass says right now, and a hash of it (images included,
  // by the poster's key and upload time).
  function contentFor(wp, now = Date.now()) {
    const person = store.getPerson(wp.personId);
    if (!person) return null;
    const mine = store.seatsOf(person.id)
      .map(({ showtime, seatIds }) => ({ showtime, seatIds, startsAt: showtimeInstantMs(showtime.date, showtime.time) }))
      .filter((x) => x.showtime && x.startsAt !== null && now < x.startsAt + NEXT_UNTIL_AFTER_START_MS)
      .sort((a, b) => a.startsAt - b.startsAt);
    const next = mine[0] || null;
    const posterKey = next ? next.showtime.posterKey : null;
    const posterMeta = posterKey ? posterStore.getMetaByKey(posterKey) : null;
    const built = buildPass({
      passTypeIdentifier: config.passTypeIdentifier,
      teamIdentifier: config.teamIdentifier,
      serialNumber: wp.serial,
      authenticationToken: wp.authToken,
      webServiceURL: config.webServiceURL,
      siteUrl,
      siteHost,
      venmoHandle: venmoHandle(),
      person: { id: person.id, amcAList: !!person.amcAList },
      next,
      passes: next ? store.passesFor(next.showtime.id) : [],
      upcoming: mine.slice(1),
      hasPoster: !!posterMeta,
      now
    });
    const imagesId = posterMeta ? `${posterKey}:${posterMeta.uploadedAt}` : 'none';
    const hash = crypto.createHash('sha256').update(JSON.stringify(built.json) + '\n' + imagesId + (built.poster ? ':poster' : '')).digest('hex');
    return { ...built, posterKey: posterMeta ? posterKey : null, hash };
  }

  // Brings the stored hash up to date; true if the content changed.
  function refresh(wp, now) {
    const c = contentFor(wp, now);
    if (!c || c.hash === wp.contentHash) return { content: c, changed: false, pass: wp };
    return { content: c, changed: true, pass: store.setWalletContent(wp.serial, c.hash) || wp };
  }

  async function pkpassFor(content) {
    let poster = null;
    try {
      poster = content.posterKey ? await posterImages(posterStore, content.posterKey) : null;
    } catch (e) {
      log(`[wallet] poster images failed: ${e.message}`);
    }
    // Without the artwork the poster style isn't valid: fall back to classic.
    const json = poster || !content.poster ? content.json : { ...content.json, preferredStyleSchemes: undefined };
    return buildPkpass(json, passImages(poster, content.poster && !!poster), await signer());
  }

  // Tells every device holding the pass that it changed.
  async function notify(serial) {
    const targets = store.walletPushTargets(serial);
    if (!targets.length) return;
    const { gone } = await pusher.push(targets, serial.slice(0, 8));
    gone.forEach((d) => store.forgetWalletDevice(d));
  }

  // A change noticed outside the sweep (a download, a device's fetch) still
  // reaches the pass's other devices.
  function refreshAndNotify(wp, now) {
    const r = refresh(wp, now);
    if (r.changed) notify(wp.serial).catch((e) => log(`[wallet] push failed: ${e}`));
    return r;
  }

  let sweeping = false;
  async function sweep() {
    if (!enabled || sweeping) return;
    sweeping = true;
    try {
      const now = Date.now();
      for (const wp of store.listWalletPasses()) {
        const { changed } = refresh(wp, now);
        if (changed) await notify(wp.serial);
      }
    } catch (e) {
      log(`[wallet] sweep failed: ${e.stack || e}`);
    } finally {
      sweeping = false;
    }
  }

  let soon = null;
  function sweepSoon() {
    if (!enabled || soon) return;
    soon = setTimeout(() => { soon = null; sweep(); }, SWEEP_AFTER_CHANGE_MS);
    soon.unref();
  }
  if (enabled) setInterval(sweep, SWEEP_EVERY_MS).unref();

  // Any change made through the site may change someone's pass.
  function afterChanges(req, res, next) {
    if (enabled && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.path.startsWith('/v1/')) {
      res.on('finish', () => { if (res.statusCode < 400) sweepSoon(); });
    }
    next();
  }

  function sendPkpass(res, buf, pass) {
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Content-Disposition', 'inline; filename="canopy-movies.pkpass"');
    res.set('Last-Modified', new Date(pass.updatedAt * 1000).toUTCString());
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  }

  // GET /api/public/wallet-pass.pkpass, behind the site's sign-in.
  async function download(req, res) {
    if (!enabled) return res.status(404).json({ error: 'not available' });
    try {
      const { content, pass } = refreshAndNotify(store.ensureWalletPass(req.person.id), Date.now());
      sendPkpass(res, await pkpassFor(content), pass);
    } catch (e) {
      log(`[wallet] download failed: ${e.stack || e}`);
      res.status(500).json({ error: 'could not make the pass' });
    }
  }

  // ---- Apple's pass web service ----
  const router = express.Router();

  function passFor(req, res) {
    if (req.params.passTypeId !== config.passTypeIdentifier) { res.status(404).end(); return null; }
    const wp = store.walletPass(req.params.serial);
    const m = /^ApplePass (.+)$/.exec(req.get('authorization') || '');
    const ok = wp && m && m[1].length === wp.authToken.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(wp.authToken));
    if (!ok) { res.status(401).end(); return null; }
    return wp;
  }

  router.post('/v1/devices/:deviceId/registrations/:passTypeId/:serial', express.json(), (req, res) => {
    const wp = passFor(req, res);
    if (!wp) return;
    const pushToken = req.body && typeof req.body.pushToken === 'string' ? req.body.pushToken : '';
    if (!/^[0-9a-fA-F]{16,200}$/.test(pushToken) || req.params.deviceId.length > 200) return res.status(400).end();
    const { created } = store.registerWalletDevice(req.params.deviceId, pushToken, wp.serial);
    res.status(created ? 201 : 200).end();
  });

  router.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serial', (req, res) => {
    const wp = passFor(req, res);
    if (!wp) return;
    store.unregisterWalletDevice(req.params.deviceId, wp.serial);
    res.status(200).end();
  });

  router.get('/v1/devices/:deviceId/registrations/:passTypeId', (req, res) => {
    if (req.params.passTypeId !== config.passTypeIdentifier) return res.status(404).end();
    const since = parseInt(req.query.passesUpdatedSince, 10);
    const rows = store.walletSerialsForDevice(req.params.deviceId, since);
    if (!rows.length) return res.status(204).end();
    res.json({ serialNumbers: rows.map((r) => r.serial), lastUpdated: String(rows[rows.length - 1].updated_at) });
  });

  router.get('/v1/passes/:passTypeId/:serial', async (req, res) => {
    const found = passFor(req, res);
    if (!found) return;
    try {
      const { content, pass } = refreshAndNotify(found, Date.now());
      if (!content) return res.status(404).end();
      const since = Date.parse(req.get('if-modified-since') || '');
      if (Number.isFinite(since) && pass.updatedAt * 1000 <= since) return res.status(304).end();
      sendPkpass(res, await pkpassFor(content), pass);
    } catch (e) {
      log(`[wallet] pass fetch failed: ${e.stack || e}`);
      res.status(500).end();
    }
  });

  router.post('/v1/log', express.json(), (req, res) => {
    const logs = req.body && Array.isArray(req.body.logs) ? req.body.logs : [];
    logs.slice(0, 20).forEach((l) => log(`[wallet] device log: ${String(l).slice(0, 500)}`));
    res.status(200).end();
  });

  function isAdded(personId) {
    const wp = store.walletPassOf(personId);
    return !!wp && store.walletPushTargets(wp.serial).length > 0;
  }

  return { enabled, router, download, afterChanges, sweep, contentFor, isAdded };
}

module.exports = { createWallet };
