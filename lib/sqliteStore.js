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
const posterStore = require('./posterStore');
const sharedPasswordStore = require('./sharedPassword');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'canopy.db');
const JSON_FILE = path.join(DATA_DIR, 'showtimes.json');

// Bumped whenever the schema changes; see migrateSchema.
//   1  movies, showtimes, seats, meta
//   2  movies.poster_key
//   3  people, devices, device_unlocks; movies.password; seats.person_id, seats.guest
//   4  person_unlocks (short-lived; see 5)
//   5  drops person_unlocks -- claiming a seat now checks the movie
//      password in the claim itself, so nothing needs remembering
//   6  people.venmo
const SCHEMA_VERSION = 6;

// The keys a showtime record maps onto columns. Anything else on a
// record goes into `extra`. movieId/posterKey/posterUrl come from the
// movie, not the showtime, so they're never stored as extras either.
const KNOWN_KEYS = new Set([
  'id', 'title', 'theater', 'date', 'time', 'format', 'screen', 'price',
  'info', 'ordersClosed', 'createdAt', 'updatedAt', 'seats',
  'movieId', 'posterKey', 'posterUrl'
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
    -- A friend, signed in by email (no password -- see server.js). Names
    -- are required; friends see "First L", the admin sees the full name.
    CREATE TABLE IF NOT EXISTS people (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL UNIQUE,
      first_name  TEXT NOT NULL,
      last_name   TEXT NOT NULL,
      photo_at    INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    -- One browser. Movie unlocks belong to the device, not the person, so
    -- knowing someone's email gets you their profile and nothing in
    -- their movies.
    CREATE TABLE IF NOT EXISTS devices (
      id              TEXT PRIMARY KEY,
      person_id       TEXT REFERENCES people(id) ON DELETE SET NULL,
      legacy_checked  INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_unlocks (
      device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      movie_id     TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
      unlocked_at  INTEGER NOT NULL,
      PRIMARY KEY (device_id, movie_id)
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
}

// Brings an existing database up to SCHEMA_VERSION, one step at a time.
// A brand-new one goes through the same steps, so there's one path.
function migrateSchema(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version < 2) {
    // A movie's poster used to be found by hashing its title (see
    // lib/posterStore.js), which would lose it the moment the movie is
    // renamed. Now the movie remembers its poster's key. Existing posters
    // are picked up by title here, once.
    const cols = db.prepare('PRAGMA table_info(movies)').all().map((c) => c.name);
    if (!cols.includes('poster_key')) db.exec('ALTER TABLE movies ADD COLUMN poster_key TEXT');
    backfillPosterKeys(db);
  }
  if (version < 3) {
    // Per-movie passwords replace the one friend password, and a seat
    // can belong to a person (their own seat, or a guest's they booked).
    const movieCols = db.prepare('PRAGMA table_info(movies)').all().map((c) => c.name);
    if (!movieCols.includes('password')) db.exec('ALTER TABLE movies ADD COLUMN password TEXT');
    const seatCols = db.prepare('PRAGMA table_info(seats)').all().map((c) => c.name);
    if (!seatCols.includes('person_id')) {
      db.exec('ALTER TABLE seats ADD COLUMN person_id TEXT REFERENCES people(id) ON DELETE SET NULL');
    }
    if (!seatCols.includes('guest')) db.exec('ALTER TABLE seats ADD COLUMN guest INTEGER NOT NULL DEFAULT 0');
    seedMovieAccess(db);
  }
  if (version < 5) db.exec('DROP TABLE IF EXISTS person_unlocks');
  if (version < 6) {
    // A friend's own Venmo username (without the @), set in their profile.
    const cols = db.prepare('PRAGMA table_info(people)').all().map((c) => c.name);
    if (!cols.includes('venmo')) db.exec('ALTER TABLE people ADD COLUMN venmo TEXT');
  }
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

// The movies that exist when per-movie passwords arrive:
//   - each gets the friend password as its own, so the password friends
//     already have keeps working (the host changes any of them after);
//   - they're recorded as the "legacy" set, which a browser still holding
//     the old friend-password cookie gets unlocked automatically, once --
//     nobody already in is asked for a password they never had.
function seedMovieAccess(db) {
  const friendPassword = sharedPasswordStore.get();
  if (friendPassword) {
    db.prepare('UPDATE movies SET password = ? WHERE password IS NULL').run(friendPassword);
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'legacy_unlock_movies'").get();
  const ids = new Set(row ? JSON.parse(row.value) : []);
  db.prepare('SELECT id FROM movies').all().forEach((m) => ids.add(m.id));
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_unlock_movies', ?)")
    .run(JSON.stringify(Array.from(ids)));
}

// Gives any movie without a poster the one uploaded for its exact title
// under the old scheme, if there is one.
function backfillPosterKeys(db) {
  const set = db.prepare('UPDATE movies SET poster_key = ? WHERE id = ?');
  db.prepare('SELECT id, title FROM movies WHERE poster_key IS NULL').all().forEach((m) => {
    const key = posterStore.keyFor(m.title);
    if (posterStore.getMetaByKey(key)) set.run(key, m.id);
  });
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

// personId/guest say whose seat it is: a person's own (guest false) or a
// guest's they booked (guest true). normalizeSeatEntry drops them, so
// everything that only cares about the seat itself is unaffected.
function rowToSeat(row) {
  if (row.status === 'occupied') return { status: 'occupied' };
  return {
    status: 'assigned',
    name: row.name,
    paid: !!row.paid,
    concessionsPaid: !!row.concessions_paid,
    concessions: JSON.parse(row.concessions),
    personId: row.person_id || null,
    guest: !!row.guest
  };
}

// Puts a showtime row (joined with its movie's title) and its seats back
// into the record shape the JSON store used.
function rowToShowtime(row, seatRows) {
  const out = {
    ...(row.extra ? JSON.parse(row.extra) : {}),
    id: row.id,
    title: row.title,
    movieId: row.movie_id,
    posterKey: row.poster_key || null
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
  const SHOWTIME_COLUMNS = `s.*, m.title AS title, m.poster_key AS poster_key`;
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
const MOVIE_KEYS = new Set(['movieId', 'posterKey', 'posterUrl']);

function comparable(obj) {
  const out = {};
  Object.keys(obj).sort().forEach((k) => {
    if (MOVIE_KEYS.has(k)) return;
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
    migrateSchema(db);
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
  migrateSchema(db);
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
    // The import made its movies after the schema steps ran, so they
    // haven't had their posters looked up or passwords set yet.
    backfillPosterKeys(db);
    seedMovieAccess(db);
  } else {
    checkJsonUnchanged(db);
  }

  snapshot(db);
  setInterval(() => snapshot(db), 24 * 60 * 60 * 1000).unref();

  const mq = {
    movies: db.prepare(`
      SELECT m.*, COUNT(s.id) AS showtime_count, GROUP_CONCAT(s.date) AS dates
      FROM movies m LEFT JOIN showtimes s ON s.movie_id = m.id
      GROUP BY m.id ORDER BY m.created_at, m.rowid`),
    movie: db.prepare('SELECT * FROM movies WHERE id = ?'),
    showtimesOf: db.prepare('SELECT id FROM showtimes WHERE movie_id = ? ORDER BY date, time, rowid'),
    countOf: db.prepare('SELECT COUNT(*) AS n FROM showtimes WHERE movie_id = ?'),
    rename: db.prepare('UPDATE movies SET title = ?, updated_at = ? WHERE id = ?'),
    setPoster: db.prepare('UPDATE movies SET poster_key = ?, updated_at = ? WHERE id = ?'),
    deleteMovie: db.prepare('DELETE FROM movies WHERE id = ?'),
    deleteSeat: db.prepare('DELETE FROM seats WHERE showtime_id = ? AND seat_id = ?'),
    upsertSeat: db.prepare(`
      INSERT INTO seats (showtime_id, seat_id, status, name, paid, concessions_paid, concessions, person_id, guest)
      VALUES (@showtime_id, @seat_id, @status, @name, @paid, @concessions_paid, @concessions, @person_id, @guest)
      ON CONFLICT(showtime_id, seat_id) DO UPDATE SET
        status = excluded.status, name = excluded.name, paid = excluded.paid,
        concessions_paid = excluded.concessions_paid, concessions = excluded.concessions,
        person_id = excluded.person_id, guest = excluded.guest`),
    setOwner: db.prepare(`
      UPDATE seats SET name = @name, person_id = @person_id, guest = @guest, paid = @paid,
        concessions_paid = @concessions_paid, concessions = @concessions
      WHERE showtime_id = @showtime_id AND seat_id = @seat_id`),

    person: db.prepare('SELECT * FROM people WHERE id = ?'),
    personByEmail: db.prepare('SELECT * FROM people WHERE email = ?'),
    people: db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM seats s WHERE s.person_id = p.id) AS seat_count
      FROM people p ORDER BY p.first_name COLLATE NOCASE, p.last_name COLLATE NOCASE`),
    insertPerson: db.prepare(`
      INSERT INTO people (id, email, first_name, last_name, photo_at, created_at, updated_at)
      VALUES (@id, @email, @first_name, @last_name, NULL, @now, @now)`),
    renamePerson: db.prepare('UPDATE people SET first_name = ?, last_name = ?, updated_at = ? WHERE id = ?'),
    renamePersonSeats: db.prepare('UPDATE seats SET name = ? WHERE person_id = ? AND guest = 0'),
    setPhoto: db.prepare('UPDATE people SET photo_at = ?, updated_at = ? WHERE id = ?'),
    setVenmo: db.prepare('UPDATE people SET venmo = ?, updated_at = ? WHERE id = ?'),
    deletePerson: db.prepare('DELETE FROM people WHERE id = ?'),

    device: db.prepare('SELECT * FROM devices WHERE id = ?'),
    insertDevice: db.prepare('INSERT INTO devices (id, created_at, last_seen_at) VALUES (?, ?, ?)'),
    touchDevice: db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?'),
    setDevicePerson: db.prepare('UPDATE devices SET person_id = ? WHERE id = ?'),
    setLegacyChecked: db.prepare('UPDATE devices SET legacy_checked = 1 WHERE id = ?'),
    unlocks: db.prepare('SELECT movie_id FROM device_unlocks WHERE device_id = ?'),
    unlock: db.prepare('INSERT OR IGNORE INTO device_unlocks (device_id, movie_id, unlocked_at) VALUES (?, ?, ?)'),
    legacyMovies: db.prepare("SELECT value FROM meta WHERE key = 'legacy_unlock_movies'"),
    setPassword: db.prepare('UPDATE movies SET password = ?, updated_at = ? WHERE id = ?'),

    // Seats with a name but no owner yet -- reserved before profiles.
    claimable: db.prepare(`
      SELECT s.showtime_id, s.seat_id, s.name, st.date, st.time, st.movie_id, m.title
      FROM seats s JOIN showtimes st ON st.id = s.showtime_id JOIN movies m ON m.id = st.movie_id
      WHERE s.status = 'assigned' AND s.name != '' AND s.person_id IS NULL
      ORDER BY st.date, st.time, s.seat_id`),
    mySeats: db.prepare(`
      SELECT s.showtime_id, s.seat_id FROM seats s JOIN showtimes st ON st.id = s.showtime_id
      WHERE s.person_id = ? ORDER BY st.date, st.time, s.seat_id`)
  };

  // What friends see a person as: first name and last initial, no period
  // ("Matt G"). The full name is only shown in the admin.
  function shortName(p) {
    return `${p.first_name} ${(p.last_name || '').charAt(0).toUpperCase()}`.trim();
  }

  function personRow(p) {
    if (!p) return null;
    return {
      id: p.id,
      email: p.email,
      firstName: p.first_name,
      lastName: p.last_name,
      shortName: shortName(p),
      photoAt: p.photo_at || null,
      venmo: p.venmo || null,
      createdAt: p.created_at,
      seatCount: p.seat_count
    };
  }

  function movieRow(m) {
    return {
      id: m.id,
      title: m.title,
      tmdbId: m.tmdb_id,
      password: m.password || null,
      posterKey: m.poster_key || null,
      createdAt: m.created_at,
      updatedAt: m.updated_at
    };
  }

  // Showtime columns the editor can change one at a time, and the column
  // each lives in. Values arrive already validated by server.js.
  const PATCHABLE = {
    theater: 'theater',
    date: 'date',
    time: 'time',
    format: 'format',
    screen: 'screen',
    price: 'price',
    info: 'info',
    ordersClosed: 'orders_closed'
  };

  const store = {
    kind: 'sqlite',
    migrated,

    // ---- Movies ----

    // Every movie with how many showtimes it has and their dates (the
    // page works out which are upcoming -- "today" is the viewer's, and
    // this process runs in UTC).
    listMovies() {
      return mq.movies.all().map((m) => ({
        ...movieRow(m),
        showtimeCount: m.showtime_count,
        dates: (m.dates ? m.dates.split(',') : []).filter(Boolean).sort()
      }));
    },

    // One movie with its showtimes, soonest first.
    getMovie(id) {
      const m = mq.movie.get(id);
      if (!m) return null;
      return {
        ...movieRow(m),
        showtimes: mq.showtimesOf.all(id).map((r) => readShowtime(q, r.id))
      };
    },

    // Titles are unique, so adding one that already exists hands back the
    // existing movie rather than making a second with the same name.
    createMovie(title) {
      return db.transaction(() => {
        const clean = String(title || '').trim().slice(0, 200);
        if (!clean) return { ok: false, reason: 'title_required' };
        const existing = q.movieByTitle.get(clean);
        if (existing) return { ok: true, existed: true, movie: movieRow(existing) };
        const id = movieIdForTitle(q, clean, Date.now());
        return { ok: true, existed: false, movie: movieRow(mq.movie.get(id)) };
      })();
    },

    renameMovie(id, title) {
      return db.transaction(() => {
        const m = mq.movie.get(id);
        if (!m) return { ok: false, reason: 'not_found' };
        const clean = String(title || '').trim().slice(0, 200);
        if (!clean) return { ok: false, reason: 'title_required' };
        const other = q.movieByTitle.get(clean);
        if (other && other.id !== id) return { ok: false, reason: 'conflict' };
        mq.rename.run(clean, Date.now(), id);
        return { ok: true, movie: movieRow(mq.movie.get(id)) };
      })();
    },

    setMoviePosterKey(id, key) {
      const changed = mq.setPoster.run(key, Date.now(), id).changes;
      return changed ? movieRow(mq.movie.get(id)) : null;
    },

    // Only an empty movie can go: deleting one with showtimes would take
    // its friends' reservations with it.
    deleteMovie(id) {
      return db.transaction(() => {
        if (!mq.movie.get(id)) return { ok: false, reason: 'not_found' };
        if (mq.countOf.get(id).n > 0) return { ok: false, reason: 'has_showtimes' };
        mq.deleteMovie.run(id);
        return { ok: true };
      })();
    },

    setMoviePassword(id, password) {
      const clean = String(password || '').trim().slice(0, 200) || null;
      const changed = mq.setPassword.run(clean, Date.now(), id).changes;
      return changed ? movieRow(mq.movie.get(id)) : null;
    },

    // ---- People ----

    getPerson(id) {
      return personRow(mq.person.get(id));
    },

    getPersonByEmail(email) {
      return personRow(mq.personByEmail.get(email));
    },

    listPeople() {
      return mq.people.all().map(personRow);
    },

    createPerson({ email, firstName, lastName }) {
      return db.transaction(() => {
        if (mq.personByEmail.get(email)) return { ok: false, reason: 'conflict' };
        const id = crypto.randomUUID();
        mq.insertPerson.run({ id, email, first_name: firstName, last_name: lastName, now: Date.now() });
        return { ok: true, person: personRow(mq.person.get(id)) };
      })();
    },

    // Their own seats carry their name, so those follow a rename. Guests'
    // seats keep the guest's name.
    renamePerson(id, firstName, lastName) {
      return db.transaction(() => {
        if (!mq.person.get(id)) return { ok: false, reason: 'not_found' };
        mq.renamePerson.run(firstName, lastName, Date.now(), id);
        const p = mq.person.get(id);
        mq.renamePersonSeats.run(shortName(p), id);
        return { ok: true, person: personRow(p) };
      })();
    },

    // `venmo` is already cleaned (server.js); null clears it.
    setPersonVenmo(id, venmo) {
      mq.setVenmo.run(venmo || null, Date.now(), id);
      return personRow(mq.person.get(id));
    },

    setPersonPhoto(id, at) {
      mq.setPhoto.run(at, Date.now(), id);
      return personRow(mq.person.get(id));
    },

    // Their seats stay reserved under the names on them; they just stop
    // belonging to anyone (ON DELETE SET NULL).
    deletePerson(id) {
      return mq.deletePerson.run(id).changes > 0;
    },

    // ---- Devices & unlocks ----

    createDevice() {
      const id = crypto.randomUUID();
      const now = Date.now();
      mq.insertDevice.run(id, now, now);
      return mq.device.get(id);
    },

    getDevice(id) {
      return mq.device.get(id) || null;
    },

    touchDevice(id) {
      mq.touchDevice.run(Date.now(), id);
    },

    setDevicePerson(deviceId, personId) {
      mq.setDevicePerson.run(personId, deviceId);
    },

    unlockedMovieIds(deviceId) {
      return new Set(mq.unlocks.all(deviceId).map((r) => r.movie_id));
    },

    unlockMovie(deviceId, movieId) {
      mq.unlock.run(deviceId, movieId, Date.now());
    },

    // A browser that still has the old friend-password cookie gets every
    // movie that existed when per-movie passwords arrived, once.
    grantLegacyUnlocks(deviceId) {
      return db.transaction(() => {
        const d = mq.device.get(deviceId);
        if (!d || d.legacy_checked) return 0;
        const row = mq.legacyMovies.get();
        let n = 0;
        (row ? JSON.parse(row.value) : []).forEach((movieId) => {
          if (mq.movie.get(movieId)) { mq.unlock.run(deviceId, movieId, Date.now()); n++; }
        });
        mq.setLegacyChecked.run(deviceId);
        return n;
      })();
    },

    // Reserved-before-profiles seats in the movies this device has
    // unlocked, for "are these yours?".
    claimableSeats(movieIds) {
      return mq.claimable.all().filter((r) => movieIds.has(r.movie_id)).map((r) => ({
        showtimeId: r.showtime_id,
        seatId: r.seat_id,
        name: r.name,
        date: r.date,
        time: r.time,
        movieId: r.movie_id,
        title: r.title
      }));
    },

    // Makes each listed seat this person's own, renamed to their name --
    // only seats nobody owns yet, in the given movies.
    claimExistingSeats(personId, items, movieIds) {
      return db.transaction(() => {
        const p = mq.person.get(personId);
        if (!p) return { ok: false, reason: 'not_found' };
        let n = 0;
        (items || []).forEach(({ showtimeId, seatId }) => {
          const st = q.oneShowtime.get(showtimeId);
          if (!st || !movieIds.has(st.movie_id)) return;
          const row = q.seat.get(showtimeId, seatId);
          if (!row || row.status !== 'assigned' || !row.name || row.person_id) return;
          mq.setOwner.run({
            showtime_id: showtimeId, seat_id: seatId, name: shortName(p), person_id: personId, guest: 0,
            paid: row.paid, concessions_paid: row.concessions_paid, concessions: row.concessions
          });
          q.touchShowtime.run(Date.now(), showtimeId);
          n++;
        });
        return { ok: true, claimed: n };
      })();
    },

    // Every seat this person owns (theirs and their guests'), with the
    // showtime it's in -- whether or not this device has the movie unlocked.
    seatsOf(personId) {
      const byShowtime = new Map();
      mq.mySeats.all(personId).forEach((r) => {
        if (!byShowtime.has(r.showtime_id)) byShowtime.set(r.showtime_id, []);
        byShowtime.get(r.showtime_id).push(r.seat_id);
      });
      return Array.from(byShowtime.entries()).map(([showtimeId, seatIds]) => ({
        showtime: readShowtime(q, showtimeId),
        seatIds
      }));
    },

    // ---- Showtimes, a field or a seat at a time ----

    createShowtime(movieId, fields) {
      return db.transaction(() => {
        if (!mq.movie.get(movieId)) return { ok: false, reason: 'not_found' };
        const id = crypto.randomUUID();
        const now = Date.now();
        q.upsertShowtime.run({
          id,
          movie_id: movieId,
          theater: textOrNull(fields.theater),
          date: textOrNull(fields.date),
          time: textOrNull(fields.time),
          format: textOrNull(fields.format),
          screen: textOrNull(fields.screen),
          price: typeof fields.price === 'number' ? fields.price : null,
          info: textOrNull(fields.info),
          orders_closed: null,
          created_at: now,
          updated_at: now,
          extra: null
        });
        return { ok: true, showtime: readShowtime(q, id) };
      })();
    },

    // Same fields, a new date to set, no seats: the seats you hold are
    // different for every showing.
    duplicateShowtime(id) {
      const src = readShowtime(q, id);
      if (!src) return { ok: false, reason: 'not_found' };
      return store.createShowtime(src.movieId, src);
    },

    // `patch` holds only the fields being changed.
    patchShowtime(id, patch) {
      return db.transaction(() => {
        if (!q.oneShowtime.get(id)) return { ok: false, reason: 'not_found' };
        const sets = [];
        const values = {};
        Object.keys(patch).forEach((key) => {
          const col = PATCHABLE[key];
          if (!col) return;
          sets.push(`${col} = @${col}`);
          let v = patch[key];
          if (typeof v === 'boolean') v = v ? 1 : 0;
          values[col] = v === undefined ? null : v;
        });
        sets.push('updated_at = @updated_at');
        values.updated_at = Date.now();
        db.prepare(`UPDATE showtimes SET ${sets.join(', ')} WHERE id = @id`).run({ ...values, id });
        return { ok: true, showtime: readShowtime(q, id) };
      })();
    },

    // The editor setting one seat in your block: who it's for and what
    // they've paid. The friend's order isn't the editor's to change, so it
    // stays on the seat -- through a renamed or re-paid seat too -- and
    // only goes when the name does (an unnamed seat has nobody to owe it).
    setSeat(id, seatId, { name, paid, concessionsPaid }) {
      return db.transaction(() => {
        if (!q.oneShowtime.get(id)) return { ok: false, reason: 'not_found' };
        const prior = q.seat.get(id, seatId);
        const cleanName = String(name || '').trim().slice(0, 80);
        const keepCart = cleanName && prior && prior.status === 'assigned' && prior.name;
        // Whose seat it is goes with the name, same as the order does.
        mq.upsertSeat.run({
          showtime_id: id,
          seat_id: seatId,
          status: 'assigned',
          name: cleanName,
          paid: paid ? 1 : 0,
          concessions_paid: cleanName && concessionsPaid ? 1 : 0,
          concessions: keepCart ? prior.concessions : '[]',
          person_id: keepCart ? prior.person_id : null,
          guest: keepCart ? prior.guest : 0
        });
        q.touchShowtime.run(Date.now(), id);
        return { ok: true, showtime: readShowtime(q, id) };
      })();
    },

    // Out of your block entirely (e.g. the ticket was refunded).
    releaseSeat(id, seatId) {
      return db.transaction(() => {
        if (!q.oneShowtime.get(id)) return { ok: false, reason: 'not_found' };
        mq.deleteSeat.run(id, seatId);
        q.touchShowtime.run(Date.now(), id);
        return { ok: true, showtime: readShowtime(q, id) };
      })();
    },

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
    // `owner` is { personId, guest } for a signed-in friend reserving for
    // themselves (guest false) or for someone else (guest true, `name` is
    // the guest's).
    claimSeat(id, seatId, name, owner) {
      return db.transaction(() => {
        if (!q.oneShowtime.get(id)) return { ok: false, reason: 'not_found' };
        const row = q.seat.get(id, seatId);
        const seat = row ? normalizeSeatEntry(rowToSeat(row)) : null;
        if (!seat || seat.status !== 'assigned' || seat.name) return { ok: false, reason: 'not_claimable' };
        mq.setOwner.run({
          showtime_id: id, seat_id: seatId, name,
          person_id: owner && owner.personId ? owner.personId : null,
          guest: owner && owner.guest ? 1 : 0,
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
