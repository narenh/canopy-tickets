// Normalizes a raw per-seat entry from storage into one of:
//   { status: 'occupied' }                                    -- sold out, never purchased by the owner
//   { status: 'assigned', name, paid, concessions }            -- part of the owner's block (name may be '' = unclaimed)
//   null                                                       -- available / no entry
//
// Handles the legacy plain-string format ('selected' / 'occupied') used
// before per-seat names and paid tracking existed, so old data keeps
// working without a migration step. Seats saved before concessions
// existed simply normalize to an empty cart.
//
// Keep this in sync with the equivalent normalizeSeatEntry() in
// views/admin.html and views/public.html -- there's no shared bundle here,
// this file is server-side only.

const MAX_CART_LINES = 50;
const MAX_QTY = 99;

// One cart line: { itemId, name, price, qty, note? }.
//
// `name` and `price` are a SNAPSHOT of the menu item at the moment it was
// added, not a live lookup -- the host repricing or deleting a menu item
// later must not silently change or vanish an order someone already
// placed (and already owes money for). `itemId` is kept alongside purely
// so the reservation page can line a cart up against the current menu.
function normalizeConcessionLine(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name == null ? '' : raw.name).trim().slice(0, 120);
  if (!name) return null;

  const qtyNum = typeof raw.qty === 'number' ? raw.qty : parseInt(raw.qty, 10);
  const qty = Number.isFinite(qtyNum) ? Math.min(MAX_QTY, Math.floor(qtyNum)) : 0;
  // Quantity 0 isn't an error -- it's how the reservation page says
  // "removed" -- it just doesn't survive as a cart line.
  if (qty < 1) return null;

  const priceNum = typeof raw.price === 'number' ? raw.price : parseFloat(raw.price);
  const price = Number.isFinite(priceNum) && priceNum > 0 ? Math.round(priceNum * 100) / 100 : 0;

  const line = {
    itemId: typeof raw.itemId === 'string' ? raw.itemId.slice(0, 64) : '',
    name,
    price,
    qty
  };
  const note = String(raw.note == null ? '' : raw.note).trim().slice(0, 200);
  if (note) line.note = note;
  return line;
}

function normalizeConcessions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((entry) => {
    if (out.length >= MAX_CART_LINES) return;
    const line = normalizeConcessionLine(entry);
    if (line) out.push(line);
  });
  return out;
}

function normalizeSeatEntry(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    if (raw === 'selected') return { status: 'assigned', name: '', paid: true, concessions: [] };
    if (raw === 'occupied') return { status: 'occupied' };
    return null;
  }
  if (typeof raw === 'object') {
    if (raw.status === 'assigned') {
      return {
        status: 'assigned',
        name: raw.name || '',
        paid: !!raw.paid,
        // An unclaimed seat can't hold an order: the cart belongs to
        // whoever's name is on the seat, so clearing the name clears it.
        concessions: raw.name ? normalizeConcessions(raw.concessions) : []
      };
    }
    if (raw.status === 'occupied') return { status: 'occupied' };
  }
  return null;
}

function normalizeSeats(rawSeats) {
  const out = {};
  Object.keys(rawSeats || {}).forEach((id) => {
    const n = normalizeSeatEntry(rawSeats[id]);
    if (n) out[id] = n;
  });
  return out;
}

// Sum of one cart, in dollars. Rounded at the end (not per line) so a
// cart of odd-cent items can't drift.
function concessionsTotal(lines) {
  const total = (lines || []).reduce((sum, l) => sum + (l.price || 0) * (l.qty || 0), 0);
  return Math.round(total * 100) / 100;
}

module.exports = {
  MAX_CART_LINES,
  MAX_QTY,
  normalizeSeatEntry,
  normalizeSeats,
  normalizeConcessions,
  concessionsTotal
};
