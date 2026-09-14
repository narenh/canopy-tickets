// Persistence for movie poster art. Unlike lib/uploadedImage.js's stores
// (one fixed name each, created once at startup -- og/logo), a poster is
// keyed by the movie's *title*, and there's no fixed set of titles known
// in advance -- so this is one store covering every title, not a
// per-name factory.
//
// Re-using a title (hosting the same movie again) automatically reuses
// whatever poster was already uploaded for it -- nothing to re-upload
// per showtime. Two different movies that happen to share an identical
// title string would collide onto the same poster; that's an accepted
// tradeoff for a small friend-group app, not worth more machinery to
// prevent (title+year, a manual "is this the same movie?" prompt, ...) --
// just re-upload if it ever actually comes up.
//
// A title isn't filesystem/URL-safe on its own (slashes, unicode,
// arbitrary length), so the on-disk key is a hash of the *exact*
// (trimmed) title string, not the title itself. Same DATA_DIR reasoning
// as uploadedImage.js -- posters/ has to live under the one path that's
// actually mounted as a persistent volume in production.

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

function imagePathForKey(key) {
  return path.join(POSTERS_DIR, key);
}
function metaPathForKey(key) {
  return path.join(POSTERS_DIR, `${key}.json`);
}

function readMeta(key) {
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

  // Returns { mimeType, uploadedAt } for this title's poster, or null if
  // none has been uploaded for this exact title yet.
  getMetaByTitle(title) {
    return readMeta(keyFor(title));
  },

  // Same lookup, but by the key already embedded in an image URL --
  // avoids re-hashing (or having the title at all) on the serving path.
  getMetaByKey(key) {
    return readMeta(key);
  },

  getFilePathByKey(key) {
    return imagePathForKey(key);
  },

  // uploadedAt becomes the cache-busting `?v=` on the poster's public
  // URL, same reasoning as uploadedImage.js -- a re-upload for this
  // title gets a brand new URL so it can't keep serving the old image
  // from cache.
  save(title, buffer, mimeType) {
    ensureDir();
    const key = keyFor(title);
    fs.writeFileSync(imagePathForKey(key), buffer);
    const meta = { title: String(title).trim(), mimeType, uploadedAt: Date.now() };
    fs.writeFileSync(metaPathForKey(key), JSON.stringify(meta));
    return meta;
  }
};
