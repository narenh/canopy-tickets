// Tiny JSON-file persistence layer for showtimes.
//
// This is intentionally simple (no SQLite/Postgres): one small JSON file,
// read fully into memory and written back atomically. Fine for the scale
// of "one person's showtimes for their friend group." Writes are queued
// so concurrent saves can't interleave and corrupt the file.

const fs = require('fs');
const path = require('path');

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
  }
};
