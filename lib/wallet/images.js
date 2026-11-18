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
// Bumped whenever the images change (renditions or the logo files), so every pass is rebuilt and
// pushed with the new images (it's part of each pass's content hash).
const IMAGES_VERSION = 6;

const cache = new Map();
const CACHE_MAX = 8;

// A black overlay: 70% at the top edge fading out by a fifth of the way
// down, and from halfway down to 55% at the bottom.
function edgeShade(w, h) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0.7"/>
      <stop offset="0.2" stop-color="#000" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.55"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/></svg>`);
}

// The artwork's top blurs out gradually under the logo and date: fully
// blurred at the top edge, sharp again a seventh of the way down. A blurred
// copy, masked by a gradient, laid over the original.
async function progressiveBlur(img, w, h) {
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="m" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="1"/>
      <stop offset="0.05" stop-color="#fff" stop-opacity="1"/>
      <stop offset="0.14" stop-color="#fff" stop-opacity="0"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#m)"/></svg>`);
  const blurred = await sharp(img).blur(Math.max(4, w / 45)).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  return sharp(img).composite([{ input: blurred }]).toBuffer();
}

// HSL (h 0..360, s and l 0..1) to "rgb(r,g,b)".
function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `rgb(${f(0)},${f(8)},${f(4)})`;
}

// The pass's colours from the poster: its most vivid colour (each pixel
// weighted by saturation squared times brightness, so a dark or grey
// poster's few vivid areas still win), as a light tint for the labels and
// a near-black shade for the base. A poster with no real colour gets
// neutral ones.
async function posterColors(file) {
  const { data } = await sharp(file).resize(48, 72, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < data.length; i += 3) {
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    const sat = max ? (max - min) / max : 0;
    const weight = sat * sat * (max / 255);
    r += data[i] * weight; g += data[i + 1] * weight; b += data[i + 2] * weight; w += weight;
  }
  if (w < 1) return { label: 'rgb(220,220,220)', background: 'rgb(20,20,22)' };
  [r, g, b] = [r / w / 255, g / w / 255, b / w / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  if (s < 0.12) return { label: 'rgb(220,220,220)', background: 'rgb(20,20,22)' };
  return {
    label: hsl(h, Math.min(0.85, Math.max(0.45, s)), 0.8),
    // The poster style draws the title in the label colour on a band taken
    // from the poster, where a 0.8 tint was too faint: nearly white there.
    posterLabel: hsl(h, Math.min(0.6, Math.max(0.3, s)), 0.93),
    background: hsl(h, Math.min(0.6, s * 0.7), 0.1)
  };
}

async function render(file) {
  const out = { colors: await posterColors(file) };
  for (let [name, w, h] of POSTER_SIZES) {
    // The thumbnail is cropped to a one-sheet's 2:3. The backgrounds keep
    // the image's own shape (only scaled to the width), so a Wallet image
    // made for Wallet's crop arrives as it was made.
    const isThumb = name.startsWith('thumbnail');
    let img = await sharp(file).resize(isThumb ? { width: w, height: h, fit: 'cover', position: 'centre' } : { width: w, height: Math.round(h * 1.5), fit: 'inside' }).toBuffer();
    if (!isThumb) h = (await sharp(img).metadata()).height;
    // The classic ticket's text sits on the backdrop, and Wallet's own blur
    // still left the poster's title readable through it: blurred well past
    // legibility and darkened to 60% first.
    if (name.startsWith('background')) img = await sharp(img).blur(BACKDROP_BLUR).modulate({ brightness: BACKDROP_BRIGHTNESS }).toBuffer();
    // The poster style puts the logo and date over the top of the artwork
    // and the title on a band Wallet colours from its bottom, so both
    // edges fade to dark.
    if (name.startsWith('artwork')) img = await sharp(await progressiveBlur(img, w, h)).composite([{ input: edgeShade(w, h) }]).toBuffer();
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
// Every image file for a pass. `poster` is the movie's poster's
// renditions (the classic ticket's thumbnail), `art` its Wallet background's
// (both backgrounds; the poster's when the movie has none). Either may be
// null. `posterStyle` adds what only the poster style uses.
function passImages(poster, art, posterStyle) {
  const out = { ...ICONS };
  const back = art || poster;
  if (poster) {
    out['thumbnail@2x.png'] = poster['thumbnail@2x.png'];
    out['thumbnail@3x.png'] = poster['thumbnail@3x.png'];
  }
  if (!back) return out;
  out['background@2x.png'] = back['background@2x.png'];
  if (posterStyle) Object.assign(out, PRIMARY_LOGO, { 'artwork@2x.png': back['artwork@2x.png'], 'artwork@3x.png': back['artwork@3x.png'] });
  return out;
}

module.exports = { posterImages, passImages, IMAGES_VERSION, hsl };
