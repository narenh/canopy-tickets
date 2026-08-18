// Seat layout for the current (single) auditorium -- AMC Metreon 16,
// IMAX. Both the admin editor and the public seat picker load this file
// so they always agree on which seat IDs exist.
//
// Seat *identity* is just "row letter + number" (e.g. "F14"), and that's
// the only thing ever written into a showtime's stored seats. That means
// this layout is safe to correct later (row lengths, gaps, wheelchair/
// companion icon positions, adding more rows) without touching any
// already-saved showtime -- the one rule is: don't rename or renumber a
// seat ID that's already assigned to someone, or that assignment becomes
// orphaned (it'll still show up by ID, just won't line up with a seat on
// the redrawn map).
//
// TODO when a second screen (e.g. Dolby Cinema) gets added: turn this
// into a lookup keyed by screen/room instead of one flat constant, and
// have showtimes carry a screen id alongside `format`.
const SEAT_LAYOUT = [
  { letter: 'A', count: 29, special: {3:'wc', 27:'wc'} },
  { letter: 'B', count: 29, special: {} },
  { letter: 'C', count: 29, special: {} },
  { letter: 'D', count: 29, special: {} },
  { letter: 'E', count: 29, special: {} },
  { letter: 'F', count: 29, special: {} },
  { letter: 'G', count: 29, special: {} },
  { letter: 'H', count: 29, special: {} },
  { letter: 'J', count: 29, special: {} },
  { letter: 'K', count: 29, special: {} },
  { letter: 'L', count: 29, special: {} },
  { letter: 'M', count: 29, special: {} },
  { letter: 'N', count: 29, special: {5:'wc', 6:'comp', 24:'comp', 25:'wc'} },
];
