// SQLite persistence for movies, showtimes and seats. Same interface as
// the old JSON store (lib/jsonStore.js) -- every method takes and returns
// showtimes in exactly the shape server.js already works with -- so
// moving onto it changes where the data lives and nothing else.
//
// Why the move: showtimes are becoming showtimes OF a movie (a movie
// gets its own title/poster/TMDB link), and seats are about to be saved
// one at a time instead of the editor writing back the whole map. Both
// are rows, not one JSON blob rewritten on every change.
//
// One file, DATA_DIR/canopy.db, on the same volume as everything else.
// better-sqlite3 is synchronous and this is one process, so a
// transaction is the whole locking story -- no write queue needed.
//
// ---- Shapes ----
//
// movies     one row per distinct title for now. tmdb_id is filled in
//            later, when the host links a movie to TMDB.
// showtimes  the showtime's own fields. A showtime's title is its
//            movie's title. `extra` holds any top-level key this file
//            doesn't know about as JSON, so nothing on a record is
//            dropped just because no column exists for it yet.
// seats      one row per seat that's in the block or marked sold out.
//            `paid` is stored as set, NOT with the host rule applied --
//            normalizeSeatEntry (lib/seats.js) still works that out on
//            every read, exactly as it did against the JSON.
//
// A NULL column means "no value", the same as a missing key in the JSON.
// Nothing in server.js tells a null price from an absent one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { normalizeSeatEntry, normalizeSeats, normalizeConcessions } = require('./seats');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'canopy.db');
const JSON_FILE = path.join(DATA_DIR, 'showtimes.json');

// Bumped whenever the schema changes; see migrateSchema.
const SCHEMA_VERSION = 1;

// The keys a showtime record maps onto columns. Anything else on a
// record goes into `extra`.
const KNOWN_KEYS = new Set([
  'id', 'title', 'theater', 'date', 'time', 'format', 'screen', 'price',
  'info', 'ordersClosed', 'createdAt', 'updatedAt', 'seats'
]);

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS movies (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL UNIQUE,
      tmdb_id     INTEGER UNIQUE,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS showtimes (
      id            TEXT PRIMARY KEY,
      movie_id      TEXT NOT NULL REFERENCES movies(id),
      theater       TEXT,
      date          TEXT,
      time          TEXT,
      format        TEXT,
      screen        TEXT,
      price         REAL,
      info          TEXT,
      orders_closed INTEGER,
      created_at    INTEGER,
      updated_at    INTEGER,
      extra         TEXT
    );
    CREATE INDEX IF NOT EXISTS showtimes_movie ON showtimes(movie_id);
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seats (
      showtime_id      TEXT NOT NULL REFERENCES showtimes(id) ON DELETE CASCADE,
      seat_id          TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('assigned', 'occupied')),
      name             TEXT NOT NULL DEFAULT '',
      paid             INTEGER NOT NULL DEFAULT 0,
      concessions_paid INTEGER NOT NULL DEFAULT 0,
      concessions      TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (showtime_id, seat_id)
    );
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

// WAL for the live database (readers don't wait on a writer). Not for
// the migration's .tmp file: WAL keeps recent writes in a separate -wal
// file, and only the main file gets renamed into place.
function open(file, { wal = true } = {}) {
  const db = new Database(file);
  db.pragma(`journal_mode = ${wal ? 'WAL' : 'DELETE'}`);
  db.pragma('foreign_keys = ON');
  return db;
}

// ---------------- Record <-> rows ----------------

// One seat from a showtime record, as the row it's stored as -- or null
// for an entry that reads as "no seat" (normalizeSeatEntry returns null
// for it), which the JSON kept but nothing ever showed.
//
// Everything except `paid` goes through normalizeSeatEntry, which is what
// every read of the JSON already did. `paid` is taken as stored, because
// normalizing it would bake in the host rule (`|| isHostSeat(name)`) that
// is meant to be worked out on read.
function seatToRow(raw) {
  const n = normalizeSeatEntry(raw);
  if (!n) return null;
  if (n.status === 'occupied') {
    return { status: 'occupied', name: '', paid: 0, concessions_paid: 0, concessions: '[]' };
  }
  // The legacy string 'selected' means "in the block, paid".
  const paid = typeof raw === 'string' ? true : !!raw.paid;
  return {
    status: 'assigned',
    name: n.name,
    paid: paid ? 1 : 0,
    concessions_paid: n.concessionsPaid ? 1 : 0,
    concessions: JSON.stringify(n.concessions)
  };
}

function rowToSeat(row) {
  if (row.status === 'occupied') return { status: 'occupied' };
  return {
    status: 'assigned',
    name: row.name,
    paid: !!row.paid,
    concessionsPaid: !!row.concessions_paid,
    concessions: JSON.parse(row.concessions)
  };
}

// Puts a showtime row (joined with its movie's title) and its seats back
// into the record shape the JSON store used.
function rowToShowtime(row, seatRows) {
  const out = {
    ...(row.extra ? JSON.parse(row.extra) : {}),
    id: row.id,
    title: row.title
  };
  const put = (key, value) => {
    if (value !== null && value !== undefined) out[key] = value;
  };
  put('theater', row.theater);
  put('date', row.date);
  put('time', row.time);
  put('format', row.format);
  put('screen', row.screen);
  out.price = row.price === null ? null : row.price;
  put('info', row.info);
  if (row.orders_closed !== null) out.ordersClosed = !!row.orders_closed;
  put('createdAt', row.created_at);
  put('updatedAt', row.updated_at);
  const seats = {};
  seatRows.forEach((s) => { seats[s.seat_id] = rowToSeat(s); });
  out.seats = seats;
  return out;
}

function textOrNull(v) {
  return v === null || v === undefined ? null : String(v);
}

// ---------------- Statements ----------------

function prepare(db) {
  const SHOWTIME_COLUMNS = `s.*, m.title AS title`;
  return {
    movieByTitle: db.prepare('SELECT * FROM movies WHERE title = ?'),
    insertMovie: db.prepare(
      'INSERT INTO movies (id, title, created_at, updated_at) VALUES (@id, @title, @now, @now)'
    ),
    allShowtimes: db.prepare(
      `SELECT ${SHOWTIME_COLUMNS} FROM showtimes s JOIN movies m ON m.id = s.movie_id ORDER BY s.rowid`
    ),
    oneShowtime: db.prepare(
      `SELECT ${SHOWTIME_COLUMNS} FROM showtimes s JOIN movies m ON m.id = s.movie_id WHERE s.id = ?`
    ),
    allSeats: db.prepare('SELECT * FROM seats ORDER BY showtime_id, rowid'),
    seatsFor: db.prepare('SELECT * FROM seats WHERE showtime_id = ? ORDER BY rowid'),
    seat: db.prepare('SELECT * FROM seats WHERE showtime_id = ? AND seat_id = ?'),
    upsertShowtime: db.prepare(`
      INSERT INTO showtimes (id, movie_id, theater, date, time, format, screen, price, info,
                             orders_closed, created_at, updated_at, extra)
      VALUES (@id, @movie_id, @theater, @date, @time, @format, @screen, @price, @info,
              @orders_closed, @created_at, @updated_at, @extra)
      ON CONFLICT(id) DO UPDATE SET
        movie_id = excluded.movie_id, theater = excluded.theater, date = excluded.date,
        time = excluded.time, format = excluded.format, screen = excluded.screen,
        price = excluded.price, info = excluded.info, orders_closed = excluded.orders_closed,
        created_at = excluded.created_at, updated_at = excluded.updated_at, extra = excluded.extra
    `),
    deleteSeatsFor: db.prepare('DELETE FROM seats WHERE showtime_id = ?'),
    insertSeat: db.prepare(`
      INSERT INTO seats (showtime_id, seat_id, status, name, paid, concessions_paid, concessions)
      VALUES (@showtime_id, @seat_id, @status, @name, @paid, @concessions_paid, @concessions)
    `),
    updateSeat: db.prepare(`
      UPDATE seats SET status = @status, name = @name, paid = @paid,
        concessions_paid = @concessions_paid, concessions = @concessions
      WHERE showtime_id = @showtime_id AND seat_id = @seat_id
    `),
    touchShowtime: db.prepare('UPDATE showtimes SET updated_at = ? WHERE id = ?'),
    deleteShowtime: db.prepare('DELETE FROM showtimes WHERE id = ?')
  };
}

// Finds the movie a title belongs to, making it if there isn't one yet.
// Titles are matched trimmed -- the same rule posters and the friend
// page's movie grid already use -- so "Dune" and "Dune " are one movie.
function movieIdForTitle(q, title, now) {
  const clean = String(title == null ? '' : title).trim() || 'Untitled';
  const found = q.movieByTitle.get(clean);
  if (found) return found.id;
  const id = crypto.randomUUID();
  q.insertMovie.run({ id, title: clean, now });
  return id;
}

// Writes one whole showtime record: its row, its movie (by title), and
// its seats -- replacing whatever seats it had. The shape the admin
// editor saves today; per-seat writes come with the new editor.
function writeShowtime(q, obj) {
  const now = Date.now();
  const extra = {};
  Object.keys(obj).forEach((k) => {
    if (!KNOWN_KEYS.has(k) && obj[k] !== undefined) extra[k] = obj[k];
  });
  q.upsertShowtime.run({
    id: obj.id,
    movie_id: movieIdForTitle(q, obj.title, now),
    theater: textOrNull(obj.theater),
    date: textOrNull(obj.date),
    time: textOrNull(obj.time),
    format: textOrNull(obj.format),
    screen: textOrNull(obj.screen),
    price: typeof obj.price === 'number' && Number.isFinite(obj.price) ? obj.price : null,
    info: textOrNull(obj.info),
    orders_closed: typeof obj.ordersClosed === 'boolean' ? (obj.ordersClosed ? 1 : 0) : null,
    created_at: typeof obj.createdAt === 'number' ? obj.createdAt : null,
    updated_at: typeof obj.updatedAt === 'number' ? obj.updatedAt : null,
    extra: Object.keys(extra).length ? JSON.stringify(extra) : null
  });
  q.deleteSeatsFor.run(obj.id);
  const seats = obj.seats && typeof obj.seats === 'object' ? obj.seats : {};
  Object.keys(seats).forEach((seatId) => {
    const row = seatToRow(seats[seatId]);
    if (row) q.insertSeat.run({ showtime_id: obj.id, seat_id: seatId, ...row });
  });
}

function readShowtime(q, id) {
  const row = q.oneShowtime.get(id);
  if (!row) return null;
  return rowToShowtime(row, q.seatsFor.all(id));
}

function readAllShowtimes(q) {
  const seatsBy = new Map();
  q.allSeats.all().forEach((s) => {
    if (!seatsBy.has(s.showtime_id)) seatsBy.set(s.showtime_id, []);
    seatsBy.get(s.showtime_id).push(s);
  });
  return q.allShowtimes.all().map((row) => rowToShowtime(row, seatsBy.get(row.id) || []));
}

// ---------------- Migration from showtimes.json ----------------
//
// Runs once: when canopy.db doesn't exist yet. Prod data, so it's built to
// be boring and checkable:
//
//   1. showtimes.json is copied to backups/pre-sqlite-<time>/ first. The
//      original is never written to, renamed or deleted -- after this, it
//      is simply no longer read.
//   2. Everything is imported into canopy.db.tmp, in one transaction.
//   3. Every showtime is read back out and compared with the original,
//      field by field and seat by seat, the way the app reads them (see
//      comparable()). Any difference at all and the .tmp file is deleted
//      and this throws -- lib/store.js then carries on with the JSON.
//   4. Only a database that passed is renamed into place.

// A showtime the way the app actually sees it, for comparing an original
// record with the copy read back out of SQLite: keys sorted, "no value"
// spelled one way (null and missing are the same thing to server.js), the
// title trimmed (titles are matched trimmed, see movieIdForTitle), and the
// seats normalized, because that's how every read has always seen them.
function comparable(obj) {
  const out = {};
  Object.keys(obj).sort().forEach((k) => {
    let v = obj[k];
    if (k === 'seats') v = normalizeSeats(v);
    if (k === 'title') v = String(v == null ? '' : v).trim() || 'Untitled';
    if (v === null || v === undefined) return;
    out[k] = v;
  });
  return stableStringify(out);
}

function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Imports `records` (showtimes.json's contents) into a database at
// `file` and checks it. Returns a summary; throws on any mismatch.
// `sourceHash` is recorded so later starts can tell if the JSON changed
// after it was imported (see checkJsonUnchanged).
function importAndVerify(records, file, sourceHash) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) {
    throw new Error('showtimes.json is not an object of showtimes');
  }
  const db = open(file, { wal: false });
  try {
    createSchema(db);
    const q = prepare(db);
    const ids = Object.keys(records);
    db.transaction(() => {
      ids.forEach((key) => {
        const obj = records[key];
        if (!obj || typeof obj !== 'object') throw new Error(`showtime ${key} is not an object`);
        // The JSON is keyed by id and every record carries its id too.
        // If those ever disagree, stop rather than guess which is right.
        if (obj.id !== key) throw new Error(`showtime keyed ${key} has id ${obj.id}`);
        writeShowtime(q, obj);
      });
      const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      setMeta.run('migrated_from_json_sha256', sourceHash || '');
      setMeta.run('migrated_at', new Date().toISOString());
    })();

    const problems = [];
    let seatCount = 0;
    let claimedCount = 0;
    let cartCount = 0;
    ids.forEach((id) => {
      const back = readShowtime(q, id);
      if (!back) { problems.push(`${id}: missing after import`); return; }
      const a = comparable(records[id]);
      const b = comparable(back);
      if (a !== b) problems.push(`${id}: differs\n  json:   ${a}\n  sqlite: ${b}`);
      const seats = normalizeSeats(back.seats);
      Object.values(seats).forEach((s) => {
        seatCount++;
        if (s.name) claimedCount++;
        if (s.concessions && s.concessions.length) cartCount++;
      });
    });
    const storedShowtimes = db.prepare('SELECT COUNT(*) AS n FROM showtimes').get().n;
    if (storedShowtimes !== ids.length) {
      problems.push(`expected ${ids.length} showtimes, database has ${storedShowtimes}`);
    }
    if (problems.length) {
      throw new Error(`migration check failed:\n${problems.join('\n')}`);
    }

    const titles = db.prepare(
      `SELECT m.title, COUNT(s.id) AS n FROM movies m LEFT JOIN showtimes s ON s.movie_id = m.id
       GROUP BY m.id ORDER BY MIN(s.rowid)`
    ).all();
    return {
      showtimes: ids.length,
      movies: titles,
      seats: seatCount,
      claimedSeats: claimedCount,
      seatsWithConcessions: cartCount
    };
  } finally {
    db.close();
  }
}

function removeDbFiles(file) {
  [file, `${file}-wal`, `${file}-shm`].forEach((f) => {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
}

function migrateFromJson() {
  // Read directly rather than through jsonStore, whose readAll() treats an
  // unreadable file as empty -- fine for serving, but here it would turn
  // a corrupt file into a "successful" migration of nothing.
  const raw = fs.readFileSync(JSON_FILE, 'utf8');
  const records = JSON.parse(raw || '{}');
  const sourceHash = sha256(raw);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(DATA_DIR, 'backups', `pre-sqlite-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(JSON_FILE, path.join(backupDir, 'showtimes.json'));

  const tmp = `${DB_FILE}.tmp`;
  removeDbFiles(tmp);
  let summary;
  try {
    summary = importAndVerify(records, tmp, sourceHash);
  } catch (err) {
    removeDbFiles(tmp);
    throw err;
  }
  fs.renameSync(tmp, DB_FILE);
  return { ...summary, backupDir };
}

// showtimes.json is never read again once it's imported -- so if it
// changes afterwards, something wrote to it that this database never
// saw. The likely way: during the deploy that migrated, the previous
// container (still on the JSON store) was briefly running alongside this
// one and took a friend's reservation. Nothing is merged automatically;
// it's said loudly, every start, until someone looks.
function checkJsonUnchanged(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'migrated_from_json_sha256'").get();
  if (!row || !row.value || !fs.existsSync(JSON_FILE)) return;
  const now = sha256(fs.readFileSync(JSON_FILE, 'utf8'));
  if (now === row.value) return;
  const at = db.prepare("SELECT value FROM meta WHERE key = 'migrated_at'").get();
  console.error(
    '[canopy-tickets] !!! showtimes.json has changed since it was moved into SQLite' +
      (at ? ` (${at.value})` : '') + '. Whatever changed there is NOT in the database -- most ' +
      'likely a reservation taken by the old container during the deploy. Compare it with the ' +
      'copy in backups/pre-sqlite-*/ to see what. !!!'
  );
}

// A consistent copy of the database, made with SQLite's own online
// backup, at startup and then daily. Coolify's volume backups archive
// files as they sit on disk, and its docs warn a live database file can
// come out of that inconsistent -- these copies are what a restore
// should use. backups/sqlite/canopy-YYYY-MM-DD.db, newest 14 kept.
const SNAPSHOT_DIR = path.join(DATA_DIR, 'backups', 'sqlite');
const SNAPSHOTS_KEPT = 14;

function snapshot(db) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(SNAPSHOT_DIR, `canopy-${day}.db`);
  return db
    .backup(target)
    .then(() => {
      fs.readdirSync(SNAPSHOT_DIR)
        .filter((f) => /^canopy-\d{4}-\d{2}-\d{2}\.db$/.test(f))
        .sort()
        .slice(0, -SNAPSHOTS_KEPT)
        .forEach((f) => fs.unlinkSync(path.join(SNAPSHOT_DIR, f)));
    })
    .catch((err) => console.error(`[canopy-tickets] database snapshot failed: ${err.message}`));
}

// ---------------- The store ----------------

// Opens (and if need be, creates) the database. Throws if the migration
// fails its check; lib/store.js decides what to do about that.
function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  let migrated = null;
  if (!fs.existsSync(DB_FILE) && fs.existsSync(JSON_FILE)) {
    migrated = migrateFromJson();
  }
  const db = open(DB_FILE);
  createSchema(db);
  const q = prepare(db);

  // Belt and braces after the rename: the database that's now in place
  // must hold every showtime the check counted. If not, move it aside
  // (kept, for a look) and fail the same way a failed check does.
  if (migrated) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM showtimes').get().n;
    if (n !== migrated.showtimes) {
      db.close();
      fs.renameSync(DB_FILE, `${DB_FILE}.failed-${Date.now()}`);
      throw new Error(`migrated database has ${n} showtimes after the rename, expected ${migrated.showtimes}`);
    }
  } else {
    checkJsonUnchanged(db);
  }

  snapshot(db);
  setInterval(() => snapshot(db), 24 * 60 * 60 * 1000).unref();

  const store = {
    kind: 'sqlite',
    migrated,

    listShowtimes() {
      return readAllShowtimes(q);
    },

    getShowtime(id) {
      return readShowtime(q, id);
    },

    saveShowtime(id, obj) {
      db.transaction(() => writeShowtime(q, { ...obj, id }))();
      return readShowtime(q, id);
    },

    deleteShowtime(id) {
      return db.transaction(() => {
        q.deleteSeatsFor.run(id);
        return q.deleteShowtime.run(id).changes > 0;
      })();
    },

    // Same rules as the JSON store's versions of these, which say why
    // (lib/jsonStore.js). A transaction does the job its write lock did:
    // the check and the write can't be split by another request.
    claimSeat(id, seatId, name) {
      return db.transaction(() => {
        if (!q.oneShowtime.get(id)) return { ok: false, reason: 'not_found' };
        const row = q.seat.get(id, seatId);
        const seat = row ? normalizeSeatEntry(rowToSeat(row)) : null;
        if (!seat || seat.status !== 'assigned' || seat.name) return { ok: false, reason: 'not_claimable' };
        q.updateSeat.run({
          showtime_id: id, seat_id: seatId, status: 'assigned', name,
          paid: 0, concessions_paid: 0, concessions: '[]'
        });
        q.touchShowtime.run(Date.now(), id);
        return { ok: true, showtime: readShowtime(q, id) };
      })();
    },

    setSeatConcessions(id, seatId, lines) {
      return db.transaction(() => {
        const show = q.oneShowtime.get(id);
        if (!show) return { ok: false, reason: 'not_found' };
        if (show.orders_closed) return { ok: false, reason: 'orders_closed' };
        const row = q.seat.get(id, seatId);
        if (!row || row.status !== 'assigned' || !row.name) return { ok: false, reason: 'not_reserved' };
        q.updateSeat.run({ ...row, concessions: JSON.stringify(normalizeConcessions(lines)) });
        q.touchShowtime.run(Date.now(), id);
        return { ok: true, showtime: readShowtime(q, id) };
      })();
    },

    // `paid` is written as the normalized value, the same as the JSON
    // store's version, which saved the whole normalized seat back.
    setSeatPaid(id, seatId, patch) {
      return db.transaction(() => {
        if (!q.oneShowtime.get(id)) return { ok: false, reason: 'not_found' };
        const row = q.seat.get(id, seatId);
        const seat = row ? normalizeSeatEntry(rowToSeat(row)) : null;
        if (!seat || seat.status !== 'assigned' || !seat.name) return { ok: false, reason: 'not_reserved' };
        const paid = typeof patch.ticket === 'boolean' ? patch.ticket : seat.paid;
        const concessionsPaid = typeof patch.concessions === 'boolean' ? patch.concessions : seat.concessionsPaid;
        q.updateSeat.run({ ...row, paid: paid ? 1 : 0, concessions_paid: concessionsPaid ? 1 : 0 });
        q.touchShowtime.run(Date.now(), id);
        return { ok: true, showtime: readShowtime(q, id) };
      })();
    }
  };
  return store;
}

module.exports = { init, importAndVerify, comparable, DB_FILE, JSON_FILE };
