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
// A row can set `blankAfter: {seatNumber: n}` to render n blank,
// non-interactive slots right after that seat (i.e. to its right on the
// map, before the next-lower number) -- for gaps in the middle of a row,
// the way `padStart` handles one at its left edge. Auditorium 9's row H
// uses it.
//
// A row can also set `skip: [numbers]` for seat numbers that don't
// exist: each renders as one blank slot in its place, and no seat ID is
// created for it. Unlike blankAfter, the numbering around the gap jumps
// (Auditorium 9's row C goes C11, gap, C9).
//
// `formats` lists the projection formats a showtime in that auditorium
// can be sold as -- the admin's Format dropdown shows only these once the
// screen is picked, and the first is the default. What's stored on the
// showtime is the string itself (e.g. "IMAX 70mm"), so renaming one
// follows the same rule as seat IDs: saved showtimes keep the old text.
//
// To add another auditorium later (more Metreon screens, a different
// theater entirely -- Apple Van Ness IMAX, Alamo New Mission, whatever):
// just add another entry below. The admin editor's screen picker is
// built from this object at load time (grouped by `theater`), so there's
// nothing else to wire up.
const SEAT_LAYOUTS = {
  // IMAX (Auditorium 16). Row A's count and row B's count (34, seat B34
  // is visible) are read directly off a close-up screenshot of the real
  // map. Rows C-N are NOT individually confirmed -- a wide shot of the
  // room showed every row behind A is visibly wider than A, so they're
  // set to match B's 34 as the best-supported guess, not a precise
  // count. Tighten any of this against AMC's real seat chart when
  // convenient -- it's all just data here, nothing else depends on
  // these numbers being exact. IMAX is a single stadium-style room --
  // no gapAfter needed.
  //
  // Wheelchair spots (A4, A26, N7/N8, N13/N14, N27/N28) are confirmed
  // against the real chart. Each gets a companion seat on either side
  // (e.g. A4's neighbors A3/A5) -- companion seats aren't wheelchair
  // spots themselves, just the seat you'd sit in next to one.
  'amc-metreon-16': {
    theater: 'AMC Metreon',
    auditorium: '16',
    name: 'IMAX',
    formats: ['IMAX with Laser', 'IMAX 70mm'],
    rows: [
      // Real seats stop at A29, but the physical room continues -- two
      // more seat-widths' worth of space exist where A30/A31 would be
      // before the wheelchair cluster starts. `padStart: 2` renders two
      // blank, non-interactive filler slots there (see buildSeatmap/
      // buildSeatGrid), so A29 sits exactly 2 columns in from the row's
      // left edge, same as every other row -- which is what actually
      // puts it under B32 (B34/B33/B32 being that row's own first 3
      // columns). Rows render flush-left (see .seatmap's align-items),
      // not centered, so this is the only thing establishing row A's
      // horizontal position -- no dependency on how any given browser
      // handles cross-axis centering.
      { letter: 'A', count: 29, special: {3:'comp', 4:'wc', 5:'comp', 25:'comp', 26:'wc', 27:'comp'}, padStart: 2 },
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
      {
        letter: 'N',
        count: 34,
        special: {
          6:'comp', 7:'wc', 8:'wc', 9:'comp',
          12:'comp', 13:'wc', 14:'wc', 15:'comp',
          26:'comp', 27:'wc', 28:'wc', 29:'comp'
        }
      },
    ]
  },

  // Dolby Cinema (Auditorium 13). Rows A (20), B (22), and C (18, with a
  // 4-seat wheelchair/companion cluster at positions 6-9) are read
  // directly off a labeled screenshot and should be accurate; C is
  // marked gapAfter since it's the last of the three flat rows before
  // the stadium section starts at D. Rows D-H (22 each, no specials)
  // are also direct reads. Row J (the back row) is a direct read off a
  // clearer screenshot than the one used originally: it's shorter than
  // D-H, not the same 22 -- it tops out at J16, not J22, because most of
  // what would be J15 down to J7 is wheelchair/companion space instead
  // of real seats (two 4-seat clusters plus one more single spot). Real
  // seats are J16 and J6 down to J1 -- 7 seats total, out of 16 slots.
  // The very bottom edge of that screenshot is still slightly cropped,
  // so treat this as high-confidence but not 100% certain.
  'amc-metreon-13': {
    theater: 'AMC Metreon',
    auditorium: '13',
    name: 'Dolby Cinema',
    formats: ['Dolby Cinema'],
    rows: [
      { letter: 'A', count: 20, special: {} },
      { letter: 'B', count: 22, special: {} },
      { letter: 'C', count: 18, special: {6:'comp', 7:'wc', 8:'wc', 9:'comp'}, gapAfter: true },
      { letter: 'D', count: 22, special: {} },
      { letter: 'E', count: 22, special: {} },
      { letter: 'F', count: 22, special: {} },
      { letter: 'G', count: 22, special: {} },
      { letter: 'H', count: 22, special: {} },
      { letter: 'J', count: 16, special: {7:'comp', 8:'comp', 9:'wc', 10:'wc', 11:'comp', 12:'comp', 13:'wc', 14:'wc', 15:'comp'} },
    ]
  },

  // Auditorium 9 (AMC Signature Recliners). Read off three overlapping
  // screenshots of the real map, lined up by the seats they share. The
  // room is 18 columns wide (row B fills all of them); every other row
  // is placed on that same grid with padStart/blankAfter/skip. Occupied seats
  // show no number on AMC's map, so their numbers are inferred from the
  // labeled seats on either side in the same row -- rows D-G run 13 down
  // to 1 with no breaks, so e.g. D13-D5 are unambiguous.
  //
  // Row C is all wheelchair/companion spots with no labels on the map;
  // its numbers come from the host: numbered by column like D-G (13 down
  // to 1), with C10 and C5 not existing -- those are the two empty
  // columns. Wheelchair spots are C11, C9, C6, C4, C1; companion seats
  // C13, C12, C8, C7, C3, C2. Row H's H5 and H4 are split by three empty
  // columns, confirmed by H8/H3 being labeled.
  //
  // The narrow aisles between each pair of recliners aren't modeled,
  // same as the other rooms here.
  'amc-metreon-9': {
    theater: 'AMC Metreon',
    auditorium: '9',
    name: 'Signature Recliners',
    formats: ['Single Laser'],
    rows: [
      { letter: 'A', count: 14, special: {}, padStart: 2 },
      { letter: 'B', count: 18, special: {} },
      {
        letter: 'C',
        count: 13,
        padStart: 3,
        special: {
          13:'comp', 12:'comp', 11:'wc',
          9:'wc', 8:'comp', 7:'comp', 6:'wc',
          4:'wc', 3:'comp', 2:'comp', 1:'wc'
        },
        skip: [10, 5]
      },
      { letter: 'D', count: 13, special: {}, padStart: 3 },
      { letter: 'E', count: 13, special: {}, padStart: 3 },
      { letter: 'F', count: 13, special: {}, padStart: 3 },
      { letter: 'G', count: 13, special: {}, padStart: 3 },
      { letter: 'H', count: 10, special: {}, padStart: 3, blankAfter: {5: 3} },
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

// A plain .sort() on seat IDs compares them as strings, so e.g. "K10"
// sorts before "K9" (the character '1' is less than '9'). Splits each ID
// into its row letters and seat number and compares those separately
// instead: letters ascending (row A before row B, same as reading top to
// bottom), numbers *descending* within a row. That second part isn't a
// typo -- every seat map here numbers a row ascending left-to-right as
// seen *from the seat facing the screen* (so it's easy to find your seat
// walking in), which means the highest number is actually on the left
// and the lowest on the right when you look at the map printed on a page
// or screen (see buildSeatGrid()/buildSeatmap(), which render seat
// `row.count` down to `1` left-to-right, matching this). Sorting numbers
// descending makes a seat *list* read in that same left-to-right map
// order (K12, K11, ... K9) instead of the walking-in order.
//
// Falls back to a plain string compare for anything that doesn't look
// like "<letters><digits>" (there shouldn't be any, but better than
// throwing). Used by both admin.html and public.html wherever a list of
// seat IDs needs to display in seat-map order rather than alphabetical.
function compareSeatIds(a, b){
  const matchA = /^([A-Za-z]+)(\d+)$/.exec(a);
  const matchB = /^([A-Za-z]+)(\d+)$/.exec(b);
  if (!matchA || !matchB) return a < b ? -1 : (a > b ? 1 : 0);
  if (matchA[1] !== matchB[1]) return matchA[1] < matchB[1] ? -1 : 1;
  return Number(matchB[2]) - Number(matchA[2]);
}
