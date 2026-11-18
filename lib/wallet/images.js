// The movie pass's images. The Canopy icon and logo are fixed files (made
// for the door pass; see lib/wallet/images/). The poster comes from the
// movie's uploaded poster, which can be JPEG, PNG, WebP or GIF, so it's
// converted here: Wallet only takes PNG.
//
//   artwork      the poster style's card (Wallet fills the card with it)
//   background   the classic ticket's backdrop (Wallet blurs it itself,
//                so it can be small)
//   thumbnail    the classic ticket's poster, top right
//
// Palette PNGs keep the poster renditions to a few hundred KB; a full-colour
// @3x poster alone was over 2 MB.

const fs = require('fs');
const path = require('path');
// Loaded on first use, so a broken image library can only break the pass,
// never the rest of the site.
let sharpLib = null;
const sharp = (input) => (sharpLib || (sharpLib = require('sharp')))(input);

const DIR = path.join(__dirname, 'images');
const read = (name) => fs.readFileSync(path.join(DIR, name));
const ICONS = Object.fromEntries(['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png'].map((n) => [n, read(n)]));
const PRIMARY_LOGO = Object.fromEntries(['primaryLogo@2x.png', 'primaryLogo@3x.png'].map((n) => [n, read(n)]));

// [file, width, height] in pixels, all 2:3 like a one-sheet.
const POSTER_SIZES = [
  ['artwork@2x.png', 716, 1074],
  ['artwork@3x.png', 1074, 1611],
  ['background@2x.png', 240, 360],
  ['thumbnail@2x.png', 120, 180],
  ['thumbnail@3x.png', 180, 270]
];

const BACKDROP_BLUR = 10;
const BACKDROP_BRIGHTNESS = 0.6;
// Bumped whenever the renditions change, so every pass is rebuilt and
// pushed with the new images (it's part of each pass's content hash).
const IMAGES_VERSION = 2;

const cache = new Map();
const CACHE_MAX = 8;

async function render(file) {
  const out = {};
  for (const [name, w, h] of POSTER_SIZES) {
    let img = await sharp(file).resize(w, h, { fit: 'cover', position: 'centre' }).toBuffer();
    // The classic ticket's text sits on the backdrop, and Wallet's own blur
    // still left the poster's title readable through it: blurred well past
    // legibility and darkened to 60% first.
    if (name.startsWith('background')) img = await sharp(img).blur(BACKDROP_BLUR).modulate({ brightness: BACKDROP_BRIGHTNESS }).toBuffer();
    out[name] = await sharp(img).png({ palette: true, quality: 90, effort: 7, compressionLevel: 9 }).toBuffer();
  }
  return out;
}

// The poster renditions for a poster file, cached by its key and upload
// time (a new upload is a new key-and-time). Null if there's no file.
async function posterImages(posterStore, key) {
  if (!key) return null;
  const meta = posterStore.getMetaByKey(key);
  if (!meta) return null;
  const id = `${key}:${meta.uploadedAt}`;
  if (!cache.has(id)) {
    const file = posterStore.getFilePathByKey(key);
    if (!fs.existsSync(file)) return null;
    const pending = render(file);
    cache.set(id, pending);
    pending.catch(() => cache.delete(id));
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return cache.get(id);
}

// Every image file for a pass. `poster` is posterImages' result (or null);
// `posterStyle` adds what only the poster style uses.
function passImages(poster, posterStyle) {
  const out = { ...ICONS };
  if (!poster) return out;
  out['background@2x.png'] = poster['background@2x.png'];
  out['thumbnail@2x.png'] = poster['thumbnail@2x.png'];
  out['thumbnail@3x.png'] = poster['thumbnail@3x.png'];
  if (posterStyle) Object.assign(out, PRIMARY_LOGO, { 'artwork@2x.png': poster['artwork@2x.png'], 'artwork@3x.png': poster['artwork@3x.png'] });
  return out;
}

module.exports = { posterImages, passImages, IMAGES_VERSION };
