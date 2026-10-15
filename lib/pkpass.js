// Reading the AMC Wallet passes the host uploads (a .pkpass per group of
// tickets), and working out which showtime one belongs to.
//
// A .pkpass is a zip: pass.json says what the pass is, the rest is its
// images, a manifest and Apple's signature. Only pass.json is read here.
// The file itself is kept and served back byte for byte -- it's signed by
// AMC, so changing anything in it would make Wallet refuse it.
//
// What AMC puts in pass.json (from a real one, an eventTicket):
//
//   serialNumber              "1122707601-1" -- the same pass re-shared
//                             keeps it, so it's what an upload dedupes on
//   relevantDate              "2026-04-07T19:00:00-07:00" -- the showtime,
//                             as a real instant
//   auxiliaryFields auditorium  "13"
//   auxiliaryFields seatings    "E8, E7, E14, E13, E12, E11, E10, E9"
//   auxiliaryFields tickets     "8 ADULT"
//   secondaryFields filmName    "The Super Mario Galaxy Movie"
//   locations[0].relevantText   "AMC Metreon 16"
//   barcode                   { format: PKBarcodeFormatQR, message, altText }
//
// The barcode is the order number, the same for as long as the order
// exists, which is why the page can draw its own copy of it (see
// barcodeSvg).

const zlib = require('zlib');
const qrcode = require('./vendor/qrcode-generator-1.4.4/qrcode');

// pass.json is a couple of KB. Anything claiming to be far bigger isn't a
// pass, and inflating it would only be a way to use up memory.
const MAX_PASS_JSON_BYTES = 256 * 1024;

// Finds one file in a zip and returns its bytes, or null if it isn't
// there. Reads the central directory at the end (the reliable list of
// what's in the file) rather than walking local headers from the front,
// which can't be trusted to carry sizes.
function readZipEntry(buf, wanted) {
  // The end-of-central-directory record: 22 bytes plus a comment of up to
  // 64KB, so it's somewhere in the last 64KB + 22.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip file');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    if (size > MAX_PASS_JSON_BYTES) throw new Error(`${wanted} is too large`);
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== 0x04034b50) throw new Error('damaged zip file');
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const data = buf.subarray(dataAt, dataAt + compressedSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_PASS_JSON_BYTES });
    throw new Error('unsupported zip compression');
  }
  return null;
}

// A field from one of an eventTicket's field lists, by key.
function fieldValue(pass, key) {
  const t = pass.eventTicket || {};
  for (const list of ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields']) {
    const field = (Array.isArray(t[list]) ? t[list] : []).find((f) => f && f.key === key);
    if (field && field.value !== undefined && field.value !== null) return String(field.value);
  }
  return '';
}

// "E8, E7, E14" -> ['E7', 'E8', 'E14'], in seat order, upper-cased, the
// same shape as the seat ids on a showtime ("F14").
function parseSeats(text) {
  const ids = String(text || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z]{1,3}\d{1,3}$/.test(s));
  return Array.from(new Set(ids)).sort(compareSeatIds);
}

function compareSeatIds(a, b) {
  const [, ra, na] = /^([A-Z]+)(\d+)$/.exec(a);
  const [, rb, nb] = /^([A-Z]+)(\d+)$/.exec(b);
  return ra === rb ? Number(na) - Number(nb) : ra.localeCompare(rb);
}

// What's needed from a .pkpass: who it's for, when, which seats, and its
// barcode. Throws, with something to tell the host, when the file isn't
// an event ticket this can use.
function parsePkpass(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a .pkpass file');
  const raw = readZipEntry(buf, 'pass.json');
  if (!raw) throw new Error('not a .pkpass file (no pass.json)');
  let pass;
  try {
    // Some passes start with a byte order mark.
    pass = JSON.parse(raw.toString('utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new Error("the pass's pass.json isn't readable");
  }
  if (!pass || typeof pass !== 'object' || !pass.eventTicket) throw new Error("that pass isn't a movie ticket");
  const serial = typeof pass.serialNumber === 'string' ? pass.serialNumber.trim() : '';
  if (!serial) throw new Error('that pass has no serial number');

  const when = pass.relevantDate || fieldValue(pass, 'showtime');
  const startsAt = when ? Date.parse(when) : NaN;
  // The showtime as the wall clock at the theater has it, offset ignored.
  // AMC's offset can't be trusted: its showtime field is marked
  // ignoresTimeZone (Wallet shows the digits as they are), and a December
  // show bought in October can carry October's -07:00. The digits are
  // what's on the ticket, and what a showtime's date and time are too.
  // Only a local time with its offset written out ("...19:00-07:00") has
  // a wall clock in it; a UTC one ("...Z") doesn't, and falls back to the
  // instant.
  const wall = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?[+-]\d{2}:?\d{2}$/.exec(fieldValue(pass, 'showtime') || pass.relevantDate || '');

  // Passes since iOS 9 have `barcodes`, older ones `barcode`; either may
  // be present, and the first entry is the one Wallet shows.
  const code = (Array.isArray(pass.barcodes) && pass.barcodes[0]) || pass.barcode || null;
  const barcode = code && typeof code.message === 'string'
    ? {
        format: String(code.format || ''),
        message: code.message,
        altText: typeof code.altText === 'string' ? code.altText : ''
      }
    : null;

  const location = Array.isArray(pass.locations) && pass.locations[0];
  const tickets = /^\s*(\d+)/.exec(fieldValue(pass, 'tickets'));
  const seats = parseSeats(fieldValue(pass, 'seatings') || fieldValue(pass, 'seats'));
  return {
    serial,
    organization: String(pass.organizationName || ''),
    film: fieldValue(pass, 'filmName'),
    theater: (location && location.relevantText) || '',
    auditorium: fieldValue(pass, 'auditorium').trim(),
    startsAt: Number.isFinite(startsAt) ? startsAt : null,
    wallDate: wall ? wall[1] : null,
    wallTime: wall ? wall[2] : null,
    seats,
    // What the ticket checker counts heads against. The seat list is the
    // better number when it's there; "8 ADULT" covers a pass without one.
    ticketCount: seats.length || (tickets ? Number(tickets[1]) : 0),
    barcode
  };
}

// The auditorium a showtime's screen is, from its key: "amc-metreon-13"
// is 13 (see public/seat-layout.js for the key scheme).
function screenAuditorium(screen) {
  const m = /-(\d+)$/.exec(String(screen || ''));
  return m ? m[1] : '';
}

// Which showtime a pass is for, out of `showtimes` (full records, seats
// and all). `instantOf(date, time)` turns a showtime's San Francisco wall
// clock into a real instant (server.js showtimeInstantMs).
//
// Same start time -- the pass's wall-clock date and time against the
// showtime's, or failing that the same instant -- then the same
// auditorium, then, if that still leaves more than one, the one whose
// block holds every seat on the pass. Returns { showtime } or
// { showtime: null, reason } with why not, in words for the host.
function matchShowtime(pass, showtimes, instantOf) {
  if (pass.startsAt === null && !pass.wallDate) return { showtime: null, reason: 'the pass has no showtime on it' };
  let candidates = pass.wallDate ? showtimes.filter((s) => s.date === pass.wallDate && s.time === pass.wallTime) : [];
  if (!candidates.length && pass.startsAt !== null) {
    candidates = showtimes.filter((s) => {
      const at = instantOf(s.date, s.time);
      return at !== null && Math.abs(at - pass.startsAt) < 60 * 1000;
    });
  }
  if (!candidates.length) return { showtime: null, reason: 'no showtime starts at that time' };
  if (pass.auditorium) {
    candidates = candidates.filter((s) => screenAuditorium(s.screen) === pass.auditorium);
    if (!candidates.length) return { showtime: null, reason: `no showtime at that time is in auditorium ${pass.auditorium}` };
  }
  if (candidates.length > 1 && pass.seats.length) {
    const holding = candidates.filter((s) => pass.seats.every((id) => s.seats && s.seats[id] && s.seats[id].status === 'assigned'));
    if (holding.length) candidates = holding;
  }
  if (candidates.length > 1) return { showtime: null, reason: 'more than one showtime matches' };
  return { showtime: candidates[0] };
}

// The pass's QR code as an SVG, drawn here rather than in the browser so
// the page doesn't carry a QR library. Null for any other barcode format
// (the page falls back to the code's digits and Add to Apple Wallet).
function barcodeSvg(barcode) {
  if (!barcode || barcode.format !== 'PKBarcodeFormatQR' || !barcode.message) return null;
  const qr = qrcode(0, 'M');
  qr.addData(barcode.message);
  qr.make();
  // A quiet zone of 2 modules; the white card around it adds the rest.
  return qr.createSvgTag({ cellSize: 1, margin: 2, scalable: true });
}

module.exports = { parsePkpass, matchShowtime, barcodeSvg, parseSeats, screenAuditorium, readZipEntry };
