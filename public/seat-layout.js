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
// Row A's count and its 3-seat wheelchair/companion cluster (positions
// 25-27) are read directly off a close-up screenshot of the real map and
// should be accurate. Row B's count (34) is also a direct read (seat B34
// is visible). Rows C-N are NOT individually confirmed -- a wide shot of
// the room showed every row behind A is visibly wider than A, so they're
// set to match B's 34 as the best-supported guess, not a precise count.
// The back row's 4 wheelchair-related seats are still an estimate (real
// icon spacing wasn't legible at that zoom); positions below are just
// B's-row-A-style offsets rescaled to 34 seats. Tighten any of this
// against AMC's real seat chart when convenient -- it's all just data
// here, nothing else depends on these numbers being exact.
//
// TODO when a second screen (e.g. Dolby Cinema) gets added: turn this
// into a lookup keyed by screen/room instead of one flat constant, and
// have showtimes carry a screen id alongside `format`.
const SEAT_LAYOUT = [
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
];
