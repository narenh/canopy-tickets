// Normalizes a raw per-seat entry from storage into one of:
//   { status: 'occupied' }                       -- sold out, never purchased by the owner
//   { status: 'assigned', name, paid }            -- part of the owner's block (name may be '' = unclaimed)
//   null                                          -- available / no entry
//
// Handles the legacy plain-string format ('selected' / 'occupied') used
// before per-seat names and paid tracking existed, so old data keeps
// working without a migration step.
//
// Keep this in sync with the equivalent normalizeSeatEntry() in
// views/admin.html and views/public.html -- there's no shared bundle here,
// this file is server-side only.

function normalizeSeatEntry(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    if (raw === 'selected') return { status: 'assigned', name: '', paid: true };
    if (raw === 'occupied') return { status: 'occupied' };
    return null;
  }
  if (typeof raw === 'object') {
    if (raw.status === 'assigned') return { status: 'assigned', name: raw.name || '', paid: !!raw.paid };
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

module.exports = { normalizeSeatEntry, normalizeSeats };
