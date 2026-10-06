// Persistence for movie poster art. Unlike lib/uploadedImage.js's stores
// (one fixed name each, created once at startup -- og/logo), there's one
// poster per movie and no fixed set of movies, so this is one store
// covering all of them, each file under an opaque key.
//
// A movie remembers its poster's key (movies.poster_key, see
// lib/sqliteStore.js). New uploads are keyed by the movie's id, so a
// rename keeps the poster. Posters uploaded before movies existed were
// keyed by a hash of the exact (trimmed) title -- keyFor(title) -- and
// stay where they are; the movie made for that title points at them.
//
// Same DATA_DIR reasoning as uploadedImage.js -- posters/ has to live
// under the one path that's actually mounted as a persistent volume in
// production.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const POSTERS_DIR = path.join(DATA_DIR, 'posters');

function ensureDir() {
  if (!fs.existsSync(POSTERS_DIR)) fs.mkdirSync(POSTERS_DIR, { recursive: true });
}

// Exported so server.js can build a stable, non-secret lookup key for
// the public image-serving route without exposing/re-encoding the raw
// title in a URL.
function keyFor(title) {
  return crypto.createHash('sha256').update(String(title).trim()).digest('hex');
}

// Every key is a sha256 hex digest (see keyFor). Checked before a key
// from a URL goes anywhere near a file path, so `?key=../something`
// can't reach outside the posters folder.
const KEY_RE = /^[a-f0-9]{64}$/;

function imagePathForKey(key) {
  return path.join(POSTERS_DIR, key);
}
function metaPathForKey(key) {
  return path.join(POSTERS_DIR, `${key}.json`);
}

function readMeta(key) {
  if (!KEY_RE.test(String(key))) return null;
  const metaFile = metaPathForKey(key);
  if (!fs.existsSync(metaFile) || !fs.existsSync(imagePathForKey(key))) return null;
  try {
    return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch (e) {
    return null;
  }
}

module.exports = {
  keyFor,

  // Returns { mimeType, uploadedAt } for the poster under `key`, or null.
  getMetaByKey(key) {
    return readMeta(key);
  },

  getFilePathByKey(key) {
    if (!KEY_RE.test(String(key))) throw new Error('bad poster key');
    return imagePathForKey(key);
  },

  // Saves under a key the caller chose (a movie's -- see server.js).
  // `label` is only for anyone reading the folder by hand. uploadedAt
  // becomes the cache-busting `?v=` on the poster's URL, same reasoning
  // as uploadedImage.js: a re-upload gets a new URL, so a browser can't
  // keep showing the old image from cache.
  saveByKey(key, buffer, mimeType, label) {
    if (!KEY_RE.test(String(key))) throw new Error('bad poster key');
    ensureDir();
    fs.writeFileSync(imagePathForKey(key), buffer);
    const meta = { title: String(label || ''), mimeType, uploadedAt: Date.now() };
    fs.writeFileSync(metaPathForKey(key), JSON.stringify(meta));
    return meta;
  }
};
