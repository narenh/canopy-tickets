// Persistence for the concession menu -- the list of things a friend can
// order from the reservation page (popcorn, a large Icee, whatever the
// host is willing to stand in line for).
//
// One global menu, not one per showtime or per theater: this app exists
// for one person's friend group at, in practice, one theater, and making
// the host retype "Large Popcorn -- $9.49" for every showtime would be
// the whole feature's worth of friction. A showtime's orders snapshot the
// name and price they were placed at (see lib/seats.js), so editing the
// menu later never silently rewrites what someone already ordered.
//
// Lives in DATA_DIR alongside showtimes.json, same durability story.
//
// Item ids are opaque and stable: renaming or repricing an item keeps its
// id, so the reservation page can still tell "this cart line is that menu
// item" and show the stepper against it. Deleting an item drops it off
// the menu without touching carts that already contain it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'concession-menu.json');

const MAX_ITEMS = 100;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Money is stored as a plain number of dollars (same as a showtime's
// `price`), rounded to cents so a stray 9.489999 can't accumulate into
// an off-by-a-penny cart total.
function parsePrice(raw) {
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

// Accepts whatever the admin editor posted and returns a clean menu.
// Rows with a blank name are dropped rather than rejected -- the editor
// keeps an empty row at the bottom to type into, and that row shouldn't
// have to be special-cased on the way out.
function normalizeItems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seenIds = new Set();
  raw.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const name = String(entry.name == null ? '' : entry.name).trim().slice(0, 120);
    if (!name) return;
    if (out.length >= MAX_ITEMS) return;
    // Reuse the id the editor sent back (so an edit is an edit, not a
    // delete + re-add), but never let two rows share one.
    let id = typeof entry.id === 'string' ? entry.id.trim().slice(0, 64) : '';
    if (!id || seenIds.has(id)) id = crypto.randomUUID();
    seenIds.add(id);
    out.push({ id, name, price: parsePrice(entry.price) });
  });
  return out;
}

module.exports = {
  MAX_ITEMS,
  normalizeItems,

  // Always an array -- an absent or unparseable file just means "no menu
  // set up yet", which the reservation page shows as such rather than
  // treating as an error.
  get() {
    if (!fs.existsSync(FILE)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return normalizeItems(data.items);
    } catch (e) {
      return [];
    }
  },

  // Returns the normalized menu that was actually written, so the editor
  // can render back the ids assigned to brand-new rows.
  set(items) {
    ensureDir();
    const normalized = normalizeItems(items);
    fs.writeFileSync(FILE, JSON.stringify({ items: normalized, updatedAt: Date.now() }, null, 2), 'utf8');
    return normalized;
  }
};
