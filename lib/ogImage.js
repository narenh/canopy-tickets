// Persistence for the link-preview (Open Graph) image the admin can
// upload. Lives in DATA_DIR, same as showtimes.json -- not under
// public/ or views/, because those come from the git-tracked source and
// get wiped on every redeploy; DATA_DIR is the one path that's actually
// mounted as a persistent volume in production.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const IMAGE_FILE = path.join(DATA_DIR, 'og-image');
const META_FILE = path.join(DATA_DIR, 'og-image.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

module.exports = {
  // Returns { mimeType, uploadedAt } for the current image, or null if
  // none has ever been uploaded.
  getMeta() {
    if (!fs.existsSync(META_FILE) || !fs.existsSync(IMAGE_FILE)) return null;
    try {
      return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    } catch (e) {
      return null;
    }
  },

  getFilePath() {
    return IMAGE_FILE;
  },

  // uploadedAt becomes the cache-busting `?v=` on the public image URL --
  // every re-upload gets a brand new URL, so platforms that cache by URL
  // (Facebook, iMessage, etc.) can't keep serving a stale image.
  save(buffer, mimeType) {
    ensureDir();
    fs.writeFileSync(IMAGE_FILE, buffer);
    const meta = { mimeType, uploadedAt: Date.now() };
    fs.writeFileSync(META_FILE, JSON.stringify(meta));
    return meta;
  }
};
