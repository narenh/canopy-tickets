// Tiny JSON-file persistence layer for showtimes.
//
// This is intentionally simple (no SQLite/Postgres): one small JSON file,
// read fully into memory and written back atomically. Fine for the scale
// of "one person's showtimes for their friend group." Writes are queued
// so concurrent saves can't interleave and corrupt the file.

const fs = require('fs');
const path = require('path');
const { normalizeSeatEntry } = require('./seats');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'showtimes.json');

let writeQueue = Promise.resolve();

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}', 'utf8');
}

function readAll() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch (e) {
    return {};
  }
}

function writeAll(data) {
  ensureFile();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

// Serializes async mutations against the file so a save/delete that's
// still in flight can't be clobbered by the next one.
function withWriteLock(fn) {
  const result = writeQueue.then(() => fn());
  writeQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

module.exports = {
  listShowtimes() {
    return Object.values(readAll());
  },

  getShowtime(id) {
    return readAll()[id] || null;
  },

  saveShowtime(id, obj) {
    return withWriteLock(() => {
      const all = readAll();
      all[id] = obj;
      writeAll(all);
      return obj;
    });
  },

  deleteShowtime(id) {
    return withWriteLock(() => {
      const all = readAll();
      const existed = Object.prototype.hasOwnProperty.call(all, id);
      delete all[id];
      writeAll(all);
      return existed;
    });
  },

  // Atomically claims whichever unnamed block seat sorts first, for
  // `name` -- the public side doesn't let a friend pick a specific
  // physical seat, just "a spot." Read-check-write all happens inside
  // the write lock, so two people claiming at the same moment can't both
  // land on the same seat.
  claimAnySeat(id, name) {
    return withWriteLock(() => {
      const all = readAll();
      const show = all[id];
      if (!show) return { ok: false, reason: 'not_found' };

      const openSeatId = Object.keys(show.seats || {})
        .filter((seatId) => {
          const seat = normalizeSeatEntry(show.seats[seatId]);
          return !!seat && seat.status === 'assigned' && !seat.name;
        })
        .sort()[0];
      if (!openSeatId) return { ok: false, reason: 'sold_out' };

      show.seats[openSeatId] = { status: 'assigned', name, paid: false };
      show.updatedAt = Date.now();
      writeAll(all);
      return { ok: true, showtime: show, seatId: openSeatId };
    });
  }
};
