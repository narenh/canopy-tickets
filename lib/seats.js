// Normalizes a raw per-seat entry from storage into one of:
//   { status: 'occupied' }                                    -- sold out, never purchased by the owner
//   { status: 'assigned', name, paid, concessionsPaid, concessions }  -- part of the owner's block (name may be '' = unclaimed)
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

// The host. They buy every ticket and every tray of concessions on their
// own card, so a seat with their name on it is settled the moment it
// exists -- there's nobody for them to pay.
//
// HARDCODED, knowingly and temporarily. It's one name in one place so
// that generalising it later is a matter of replacing this constant and
// isHostSeat() with something the admin sets, rather than hunting the
// idea through the views. Word-boundary matched, any capitalisation, so
// "naren", "Naren" and "Naren H" all count and a "Karen" doesn't.
//
// Deliberately separate from the peanut rule in views/public.html even
// though it's the same person today: "who is buying" and "who has the
// allergy" are two different facts that happen to coincide.
const HOST_SEAT_NAME = /\bnaren\b/i;

function isHostSeat(name) {
  return HOST_SEAT_NAME.test(name || '');
}

const MAX_CART_LINES = 50;
const MAX_QTY = 99;
const MAX_OPTION_NAME = 60;

// Option picks for one cart line, one per unit ordered: two orders of
// chicken tenders are two sauce cups, and which two is exactly the thing
// the host needs to read at the counter. Indexed positionally, so a
// chosen-then-unchosen middle unit keeps its slot as ''.
//
// Capped at `qty` (an order of 2 can't carry 5 picks) and trimmed of
// trailing blanks, so a line where nothing was picked stores nothing
// rather than an array of empty strings.
//
// The picks are stored as text, not as ids into the option group, for the
// same reason name/price are snapshotted below: the host renaming or
// removing an option must not rewrite what someone already ordered.
function normalizeOptions(raw, qty) {
  if (!Array.isArray(raw)) return [];
  const out = raw
    .slice(0, qty)
    .map((s) => String(s == null ? '' : s).trim().slice(0, MAX_OPTION_NAME));
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

// One cart line: { itemId, name, price, qty, note?, options? }.
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
  // Omitted rather than stored as [] so a cart of ordinary items doesn't
  // carry an empty array on every line.
  const options = normalizeOptions(raw.options, qty);
  if (options.length) line.options = options;
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

// How much of a seat's concessions have been settled, in dollars. A
// number rather than a boolean because a cart can grow after it's been
// paid for -- order tenders, send the money, then remember you wanted
// candy -- and a flag would go on insisting the seat was square. What's
// still owed is the current total minus this.
function normalizeMoney(raw) {
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}

function normalizeSeatEntry(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    if (raw === 'selected') return { status: 'assigned', name: '', paid: true, concessionsPaid: 0, concessions: [] };
    if (raw === 'occupied') return { status: 'occupied' };
    return null;
  }
  if (typeof raw === 'object') {
    if (raw.status === 'assigned') {
      const name = raw.name || '';
      return {
        status: 'assigned',
        name,
        // Derived rather than stored, so it holds however the name got
        // onto the seat -- claimed from the reservation page, or typed
        // into the editor.
        paid: !!raw.paid || isHostSeat(name),
        // Dollars of concessions settled, not a flag -- see normalizeMoney.
        concessionsPaid: name ? normalizeMoney(raw.concessionsPaid) : 0,
        // An unclaimed seat can't hold an order: the cart belongs to
        // whoever's name is on the seat, so clearing the name clears it.
        concessions: name ? normalizeConcessions(raw.concessions) : []
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

// San Francisco, CA. California Reg. 1603 makes food taxable when it's
// sold somewhere admission is charged, whatever the food is, so this
// applies to the whole cart rather than to some of it.
//
// Mirrored client-side, where it arrives as `concessionTaxRate` from
// /api/public/config rather than being hardcoded a second time.
const CONCESSION_TAX_RATE = 0.08625;

function concessionTax(subtotal) {
  if (!(subtotal > 0) || !(CONCESSION_TAX_RATE > 0)) return 0;
  return Math.round(subtotal * CONCESSION_TAX_RATE * 100) / 100;
}

// What a cart actually costs to settle, tax included -- the figure
// someone sends over, and so the figure concessionsPaid is measured
// against.
function concessionsGrandTotal(lines) {
  const sub = concessionsTotal(lines);
  return Math.round((sub + concessionTax(sub)) * 100) / 100;
}

module.exports = {
  isHostSeat,
  MAX_CART_LINES,
  MAX_QTY,
  normalizeOptions,
  normalizeSeatEntry,
  normalizeSeats,
  normalizeConcessions,
  concessionsTotal,
  CONCESSION_TAX_RATE,
  concessionTax,
  concessionsGrandTotal
};
