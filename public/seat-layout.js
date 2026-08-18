// Seat layouts for every auditorium this app knows about, keyed by a
// stable id that's what a showtime's `screen` field actually stores.
// A bare auditorium number isn't a safe key on its own -- "16" or "13"
// only means something within one specific theater, and more theaters
// are coming (AMC has more than one Metreon-like multiplex; other
// chains number their own auditoriums independently) -- so each entry
// carries its own `theater` and `auditorium` fields, and the key
// combines them (e.g. "amc-metreon-16") so two different theaters can
// each have their own "16" without colliding.
//
// Both the admin editor and the public seat picker load this file so
// they always agree on which seat IDs exist for a given showtime.
//
// Seat *identity* is just "row letter + number" (e.g. "F14"), and that's
// the only thing ever written into a showtime's stored seats. That means
// a layout is safe to correct later (row lengths, gaps, wheelchair/
// companion icon positions, adding more rows) without touching any
// already-saved showtime for that screen -- the one rule is: don't
// rename or renumber a seat ID that's already assigned to someone, or
// that assignment becomes orphaned (it'll still show up by ID, just
// won't line up with a seat on the redrawn map). Renaming a *key*
// (`amc-metreon-16` itself) is the same rule one level up -- don't, or
// every showtime already using that screen orphans the same way.
//
// A row can set `gapAfter: true` to add extra space below it before the
// next row, with no divider line -- used for stadium-style rooms that
// have a few rows of flat seating up front before the raised rows start
// (Dolby here: rows A-C are flat, D onward is stadium).
//
// To add another auditorium later (more Metreon screens, a different
// theater entirely -- Apple Van Ness IMAX, Alamo New Mission, whatever):
// just add another entry below. The admin editor's screen picker is
// built from this object at load time (grouped by `theater`), so there's
// nothing else to wire up.
const SEAT_LAYOUTS = {
  // IMAX (Auditorium 16). Row A's count and its 3-seat wheelchair/
  // companion cluster (positions 25-27) are read directly off a
  // close-up screenshot of the real map and should be accurate. Row B's
  // count (34) is also a direct read (seat B34 is visible). Rows C-N
  // are NOT individually confirmed -- a wide shot of the room showed
  // every row behind A is visibly wider than A, so they're set to match
  // B's 34 as the best-supported guess, not a precise count. The back
  // row's 4 wheelchair-related seats are still an estimate (real icon
  // spacing wasn't legible at that zoom); positions below are just
  // row A's-style offsets rescaled to 34 seats. Tighten any of this
  // against AMC's real seat chart when convenient -- it's all just data
  // here, nothing else depends on these numbers being exact. IMAX is a
  // single stadium-style room -- no gapAfter needed.
  'amc-metreon-16': {
    theater: 'AMC Metreon',
    auditorium: '16',
    name: 'IMAX',
    rows: [
      { letter: 'A', count: 29, special: {25:'wc', 26:'wc', 27:'wc'} },
      { letter: 'B', count: 34, special: {} },
      { letter: 'C', count: 34, special: {} },
      { letter: 'D', count: 34, special: {} },
      { letter: 'E', count: 34, special: {} },
      { letter: 'F', count: 34, special: {} },
      { letter: 'G', count: 34, special: {} },
      { letter: 'H', count: 34, special: {} },
      { letter: 'J', count: 34, special: {} },
      { letter: 'K', count: 34, special: {} },
      { letter: 'L', count: 34, special: {} },
      { letter: 'M', count: 34, special: {} },
      { letter: 'N', count: 34, special: {5:'wc', 6:'comp', 29:'comp', 30:'wc'} },
    ]
  },

  // Dolby Cinema (Auditorium 13). Rows A (20), B (22), and C (18, with a
  // 4-seat wheelchair/companion cluster at positions 6-9) are read
  // directly off a labeled screenshot and should be accurate; C is
  // marked gapAfter since it's the last of the three flat rows before
  // the stadium section starts at D. Rows D-H (22 each, no specials)
  // are also direct reads. Row J (the back row) is NOT fully confirmed
  // -- the screenshot was cropped at the bottom -- so its count (22,
  // matching D-H) and its wheelchair cluster position are a reasonable
  // estimate, not a confirmed read; the real map may have more than one
  // such cluster back there. Tighten against AMC's real chart when
  // convenient.
  'amc-metreon-13': {
    theater: 'AMC Metreon',
    auditorium: '13',
    name: 'Dolby Cinema',
    rows: [
      { letter: 'A', count: 20, special: {} },
      { letter: 'B', count: 22, special: {} },
      { letter: 'C', count: 18, special: {6:'comp', 7:'wc', 8:'wc', 9:'comp'}, gapAfter: true },
      { letter: 'D', count: 22, special: {} },
      { letter: 'E', count: 22, special: {} },
      { letter: 'F', count: 22, special: {} },
      { letter: 'G', count: 22, special: {} },
      { letter: 'H', count: 22, special: {} },
      { letter: 'J', count: 22, special: {6:'comp', 7:'wc', 8:'wc', 9:'comp'} },
    ]
  }
};

// Kept in sync by hand with the same-named constant in server.js (a
// separate runtime that can't share this file) -- both should point at
// whichever screen "no screen picked yet" ought to mean.
const DEFAULT_SCREEN = 'amc-metreon-16';

function getSeatLayout(screenId){
  return (SEAT_LAYOUTS[screenId] || SEAT_LAYOUTS[DEFAULT_SCREEN]).rows;
}
