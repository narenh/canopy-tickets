// SQLite persistence for movies, showtimes, seats and people (tickets'
// own record of each Canopy account: see syncPerson). Showtimes come
// back in the record shape server.js works with: the showtime's fields
// plus a map of its seats.
//
// One file, DATA_DIR/canopy.db, on the same volume as everything else.
// better-sqlite3 is synchronous and this is one process, so a
// transaction is the whole locking story -- no write queue needed.
//
// ---- Shapes ----
//
// movies     one row per title. tmdb_id is filled in later, when the host
//            links a movie to TMDB.
// showtimes  the showtime's own fields. A showtime's title is its
//            movie's title. `extra` holds, as JSON, any top-level keys a
//            showtime brought with it from showtimes.json that have no
//            column; they're read back onto the record, and nothing new
//            is written there.
// seats      one row per seat that's in the block or marked sold out.
//            `paid` is stored as set, NOT with the host rule applied --
//            normalizeSeatEntry (lib/seats.js) works that out on read.
//
// A NULL column means "no value". Nothing in server.js tells a null price
// from an absent one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { normalizeSeatEntry, normalizeConcessions } = require('./seats');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'canopy.db');

// Bumped whenever the schema changes; see prepareSchema.
const SCHEMA_VERSION = 18;

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS movies (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL UNIQUE,
      tmdb_id     INTEGER UNIQUE,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      -- Where its poster lives (lib/posterStore.js), so a rename keeps it.
      poster_key  TEXT,
      -- What friends type to unlock the movie.
      password    TEXT
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
    -- Everyone who's signed in here, under the same id as their Canopy
    -- account. Email, names, photo_at and venmo are copied from the
    -- account on each visit (syncPerson); the rest is tickets' own. A row
    -- is never deleted: someone whose account is gone is a former member,
    -- and their seats stay theirs. Friends see "First L", the admin sees
    -- the full name.
    CREATE TABLE IF NOT EXISTS people (
      id          TEXT PRIMARY KEY,
      email       TEXT NOT NULL UNIQUE,
      first_name  TEXT NOT NULL,
      last_name   TEXT NOT NULL,
      -- The ?v= of their photo at the account service, or NULL for none.
      photo_at    INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      -- Their own Venmo username (without the @), from their account.
      venmo       TEXT,
      -- The secret in their calendar feed URL (see server.js). Made the
      -- first time they ask for the feed.
      calendar_token TEXT,
      -- When they dismissed (or acted on) the "Subscribe to your
      -- showtimes" banner, so it stops showing on every device.
      calendar_prompt_done INTEGER,
      -- Favorite concessions -- [{ itemId, option }], in their order -- and
      -- their "usual" order, the same shape, a whole order's worth of
      -- lines. JSON: they're only ever read and written whole.
      favorites   TEXT NOT NULL DEFAULT '[]',
      usual       TEXT NOT NULL DEFAULT '[]',
      -- Set when a line of their usual was dropped because its item or
      -- option left the menu -- the "Item discontinued" banner -- until
      -- they look at their favorites again.
      usual_gone  INTEGER NOT NULL DEFAULT 0,
      -- Like calendar_prompt_done, for the "Pick your favorite
      -- concessions" banner.
      favorites_prompt_done INTEGER,
      -- Ticked in their profile: peanut items are left off the menu for
      -- the seats either side of their own.
      peanut_allergy INTEGER NOT NULL DEFAULT 0,
      -- Ticked in their profile: they have AMC Stubs A-List. Only shown
      -- back to them for now.
      amc_a_list INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS people_calendar_token ON people(calendar_token);
    -- devices and passkeys are from when tickets did its own sign-in.
    -- Nothing reads or writes them since that moved to Canopy accounts;
    -- they're left in place rather than dropped, so going back to an
    -- older commit still finds them.
    --
    -- One browser: its cookie was the session, signed in as person_id once
    -- a passkey had been verified on it.
    CREATE TABLE IF NOT EXISTS devices (
      id              TEXT PRIMARY KEY,
      person_id       TEXT REFERENCES people(id) ON DELETE SET NULL,
      created_at      INTEGER NOT NULL,
      last_seen_at    INTEGER NOT NULL,
      -- A passkey ceremony in progress on this browser: the challenge the
      -- server issued, and who it's for (an existing person, or a new
      -- profile's details until the passkey exists).
      pending_challenge TEXT,
      pending_kind      TEXT,
      pending_person_id TEXT,
      pending_profile   TEXT,
      pending_at        INTEGER,
      -- When this browser entered the setup password (first run, or
      -- recovery): good for one sign-in soon after, which becomes the admin.
      admin_setup_at  INTEGER
    );
    -- A person's passkeys (WebAuthn credentials). Only public keys: nothing
    -- here lets anyone sign in. id is the credential id, base64url.
    CREATE TABLE IF NOT EXISTS passkeys (
      id            TEXT PRIMARY KEY,
      person_id     TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      public_key    BLOB NOT NULL,
      counter       INTEGER NOT NULL DEFAULT 0,
      transports    TEXT,
      device_type   TEXT,
      backed_up     INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS passkeys_person ON passkeys(person_id);
    -- Movies a person has unlocked (typed the password for, signed in).
    -- They follow the person to every device.
    CREATE TABLE IF NOT EXISTS person_unlocks (
      person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      movie_id     TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
      unlocked_at  INTEGER NOT NULL,
      PRIMARY KEY (person_id, movie_id)
    );
    CREATE TABLE IF NOT EXISTS seats (
      showtime_id      TEXT NOT NULL REFERENCES showtimes(id) ON DELETE CASCADE,
      seat_id          TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('assigned', 'occupied')),
      name             TEXT NOT NULL DEFAULT '',
      paid             INTEGER NOT NULL DEFAULT 0,
      concessions_paid INTEGER NOT NULL DEFAULT 0,
      concessions      TEXT NOT NULL DEFAULT '[]',
      -- Whose seat it is: a person's own (guest 0) or a guest's they
      -- booked (guest 1). NULL with a name on it: reserved before profiles
      -- existed and not claimed yet.
      person_id        TEXT REFERENCES people(id) ON DELETE SET NULL,
      guest            INTEGER NOT NULL DEFAULT 0,
      -- When it was reserved -- what the 24-hour "release your
      -- reservation" window counts from.
      reserved_at      INTEGER,
      PRIMARY KEY (showtime_id, seat_id)
    );
  `);
}

// Each step brings an existing database from the version it's keyed by
// to the next one. A brand-new database skips them: createSchema already
// makes the latest.
const UPGRADES = {
  // The peanut rule used to be hardcoded to the admin's seat; now it's a
  // setting on each profile. The admin's starts ticked, so nothing they
  // relied on changes until they untick it.
  16(db) {
    db.exec('ALTER TABLE people ADD COLUMN peanut_allergy INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE people SET peanut_allergy = 1 WHERE id = (SELECT value FROM meta WHERE key = 'admin_person_id')");
  },
  // The AMC A-List box in Settings.
  17(db) {
    db.exec('ALTER TABLE people ADD COLUMN amc_a_list INTEGER NOT NULL DEFAULT 0');
  }
};
const OLDEST_UPGRADABLE = 16;

// Opens a new database at SCHEMA_VERSION, or brings an existing one up to
// it. One older than OLDEST_UPGRADABLE -- a snapshot from before version
// 16, say -- is refused rather than opened with columns missing. To use
// one, start it once under commit f50b354, which still has the steps from
// before that.
function prepareSchema(db) {
  let version = db.pragma('user_version', { simple: true });
  const isNew = version === 0 && !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'movies'").get();
  if (!isNew && (version < OLDEST_UPGRADABLE || version > SCHEMA_VERSION)) {
    throw new Error(
      `${DB_FILE} is at schema version ${version}, and this code only opens versions ` +
        `${OLDEST_UPGRADABLE} to ${SCHEMA_VERSION}. Start it once under commit f50b354 to bring it up to date.`
    );
  }
  db.transaction(() => {
    createSchema(db);
    if (!isNew) for (; version < SCHEMA_VERSION; version++) UPGRADES[version](db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

// WAL: readers don't wait on a writer.
function open(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// ---------------- Rows -> records ----------------

// personId/guest say whose seat it is: a person's own (guest false) or a
// guest's they booked (guest true). normalizeSeatEntry drops them, so
// everything that only cares about the seat itself is unaffected.
// `hostId` is the admin's profile: the host, who pays for everything.
// Their own seat -- not their guests' -- comes back with host: true,
// which is what the paid rule reads (lib/seats.js).
function rowToSeat(row, hostId) {
  if (row.status === 'occupied') return { status: 'occupied' };
  const seat = {
    status: 'assigned',
    name: row.name,
    paid: !!row.paid,
    concessionsPaid: !!row.concessions_paid,
    concessions: JSON.parse(row.concessions),
    personId: row.person_id || null,
    guest: !!row.guest,
    reservedAt: row.reserved_at || null
  };
  if (hostId && row.person_id === hostId && !row.guest) seat.host = true;
  return seat;
}

// Puts a showtime row (joined with its movie's title) and its seats
// together into the record shape server.js works with.
function rowToShowtime(row, seatRows, hostId) {
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
  seatRows.forEach((s) => { seats[s.seat_id] = rowToSeat(s, hostId); });
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
    adminPerson: db.prepare("SELECT value FROM meta WHERE key = 'admin_person_id'"),
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

// The admin's profile -- also the host, whose seat owes nothing.
function adminPersonId(q) {
  const row = q.adminPerson.get();
  return row ? row.value : null;
}

function readShowtime(q, id) {
  const row = q.oneShowtime.get(id);
  if (!row) return null;
  return rowToShowtime(row, q.seatsFor.all(id), adminPersonId(q));
}

function readAllShowtimes(q) {
  const seatsBy = new Map();
  q.allSeats.all().forEach((s) => {
    if (!seatsBy.has(s.showtime_id)) seatsBy.set(s.showtime_id, []);
    seatsBy.get(s.showtime_id).push(s);
  });
  const hostId = adminPersonId(q);
  return q.allShowtimes.all().map((row) => rowToShowtime(row, seatsBy.get(row.id) || [], hostId));
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

// Opens (and if need be, creates) the database. Throws if it's at a
// schema version this code doesn't open (see prepareSchema).
function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = open(DB_FILE);
  prepareSchema(db);
  const q = prepare(db);

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
      INSERT INTO seats (showtime_id, seat_id, status, name, paid, concessions_paid, concessions, person_id, guest, reserved_at)
      VALUES (@showtime_id, @seat_id, @status, @name, @paid, @concessions_paid, @concessions, @person_id, @guest, @reserved_at)
      ON CONFLICT(showtime_id, seat_id) DO UPDATE SET
        status = excluded.status, name = excluded.name, paid = excluded.paid,
        concessions_paid = excluded.concessions_paid, concessions = excluded.concessions,
        person_id = excluded.person_id, guest = excluded.guest, reserved_at = excluded.reserved_at`),
    setOwner: db.prepare(`
      UPDATE seats SET name = @name, person_id = @person_id, guest = @guest, paid = @paid,
        concessions_paid = @concessions_paid, concessions = @concessions, reserved_at = @reserved_at
      WHERE showtime_id = @showtime_id AND seat_id = @seat_id`),

    person: db.prepare('SELECT * FROM people WHERE id = ?'),
    personByEmail: db.prepare('SELECT * FROM people WHERE email = ?'),
    people: db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM seats s WHERE s.person_id = p.id) AS seat_count
      FROM people p ORDER BY p.first_name COLLATE NOCASE, p.last_name COLLATE NOCASE`),
    insertPerson: db.prepare(`
      INSERT INTO people (id, email, first_name, last_name, photo_at, venmo, created_at, updated_at)
      VALUES (@id, @email, @first_name, @last_name, @photo_at, @venmo, @now, @now)`),
    updatePerson: db.prepare(`
      UPDATE people SET email = @email, first_name = @first_name, last_name = @last_name,
        photo_at = @photo_at, venmo = @venmo, updated_at = @now WHERE id = @id`),
    setEmail: db.prepare('UPDATE people SET email = ?, updated_at = ? WHERE id = ?'),
    renamePersonSeats: db.prepare('UPDATE seats SET name = ? WHERE person_id = ? AND guest = 0'),
    setPeanutAllergy: db.prepare('UPDATE people SET peanut_allergy = ?, updated_at = ? WHERE id = ?'),
    setAmcAList: db.prepare('UPDATE people SET amc_a_list = ?, updated_at = ? WHERE id = ?'),
    setFavorites: db.prepare('UPDATE people SET favorites = ?, usual = ? WHERE id = ?'),
    setUsualGone: db.prepare('UPDATE people SET usual_gone = ? WHERE id = ?'),
    allFavorites: db.prepare("SELECT id, favorites, usual FROM people WHERE favorites != '[]' OR usual != '[]'"),
    setCalendarToken: db.prepare('UPDATE people SET calendar_token = ? WHERE id = ?'),
    setCalendarPromptDone: db.prepare('UPDATE people SET calendar_prompt_done = ? WHERE id = ? AND calendar_prompt_done IS NULL'),
    setFavoritesPromptDone: db.prepare('UPDATE people SET favorites_prompt_done = ? WHERE id = ? AND favorites_prompt_done IS NULL'),
    personByCalendarToken: db.prepare('SELECT * FROM people WHERE calendar_token = ?'),
    setAdminPerson: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('admin_person_id', ?)"),

    personUnlocks: db.prepare(`
      SELECT movie_id FROM person_unlocks WHERE person_id = @p
      UNION
      SELECT st.movie_id FROM seats s JOIN showtimes st ON st.id = s.showtime_id WHERE s.person_id = @p`),
    personUnlock: db.prepare('INSERT OR IGNORE INTO person_unlocks (person_id, movie_id, unlocked_at) VALUES (?, ?, ?)'),
    setPassword: db.prepare('UPDATE movies SET password = ?, updated_at = ? WHERE id = ?'),

    // Seats with a name but no owner yet -- reserved before profiles.
    claimable: db.prepare(`
      SELECT s.showtime_id, s.seat_id, s.name, st.date, st.time, st.movie_id, m.title
      FROM seats s JOIN showtimes st ON st.id = s.showtime_id JOIN movies m ON m.id = st.movie_id
      WHERE s.status = 'assigned' AND s.name != '' AND s.person_id IS NULL
      ORDER BY st.date, st.time, s.seat_id`),
    // Their own (not a guest's) seat in this showtime, if any.
    ownSeatIn: db.prepare('SELECT seat_id FROM seats WHERE showtime_id = ? AND person_id = ? AND guest = 0'),
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
      calendarPromptDone: !!p.calendar_prompt_done,
      favoritesPromptDone: !!p.favorites_prompt_done,
      peanutAllergy: !!p.peanut_allergy,
      amcAList: !!p.amc_a_list,
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

    listPeople() {
      return mq.people.all().map(personRow);
    },

    // Brings tickets' row for a Canopy account up to date with it, making
    // the row if this is their first visit. `account` is the person the
    // account service answered with; `photoAt` is their photo's ?v= (or
    // null). Returns { person, created }.
    //
    // A rename keeps renamePerson's old rule: their own seats carry their
    // name, so those follow it; guests' seats keep the guest's name.
    //
    // An email is unique here as it is there. If another row still has
    // this one, that row is a former member (an account deleted there,
    // and the email signed up again as a new account), so it gives the
    // email up, keeping it recognisable: "ana@example.com (former <id>)".
    syncPerson(account, photoAt) {
      return db.transaction(() => {
        const now = Date.now();
        const row = {
          id: account.id,
          email: String(account.email || '').trim().toLowerCase(),
          first_name: account.firstName,
          last_name: account.lastName,
          photo_at: photoAt || null,
          venmo: account.venmo || null,
          now
        };
        const holder = mq.personByEmail.get(row.email);
        if (holder && holder.id !== row.id) mq.setEmail.run(`${holder.email} (former ${holder.id})`, now, holder.id);
        const before = mq.person.get(row.id);
        if (!before) {
          mq.insertPerson.run(row);
          return { person: personRow(mq.person.get(row.id)), created: true };
        }
        const same = before.email === row.email && before.first_name === row.first_name &&
          before.last_name === row.last_name && (before.photo_at || null) === row.photo_at &&
          (before.venmo || null) === row.venmo;
        if (!same) {
          mq.updatePerson.run(row);
          if (before.first_name !== row.first_name || before.last_name !== row.last_name) {
            mq.renamePersonSeats.run(shortName(mq.person.get(row.id)), row.id);
          }
        }
        return { person: personRow(mq.person.get(row.id)), created: false };
      })();
    },

    setPersonPeanutAllergy(id, allergic) {
      mq.setPeanutAllergy.run(allergic ? 1 : 0, Date.now(), id);
      return personRow(mq.person.get(id));
    },

    setPersonAmcAList(id, member) {
      mq.setAmcAList.run(member ? 1 : 0, Date.now(), id);
      return personRow(mq.person.get(id));
    },

    // ---- The admin ----
    // One profile is the admin: it opens /admin, and as the host its own
    // seat owes nothing. The same id as the account service's admin. On a
    // database with no admin yet, server.js makes the first person to
    // sign in the admin.

    getAdminPersonId() {
      return adminPersonId(q);
    },

    setAdminPersonId(id) {
      if (!mq.person.get(id)) return false;
      mq.setAdminPerson.run(id);
      return true;
    },

    // ---- Calendar feed ----

    // The secret in this person's feed URL, made the first time it's asked
    // for. 24 random bytes: unguessable, so the URL can work without a
    // login (calendar apps don't send cookies).
    calendarTokenFor(personId) {
      const p = mq.person.get(personId);
      if (!p) return null;
      if (p.calendar_token) return p.calendar_token;
      const token = crypto.randomBytes(24).toString('base64url');
      mq.setCalendarToken.run(token, personId);
      return token;
    },

    // ---- Favorite concessions ----
    // { favorites: [{itemId, option}], usual: [{itemId, option}] }, as
    // stored -- server.js checks them against the menu.
    getFavorites(personId) {
      const p = mq.person.get(personId);
      if (!p) return null;
      const parse = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
      return { favorites: parse(p.favorites), usual: parse(p.usual), usualGone: !!p.usual_gone };
    },

    // Saving them is looking at them, so it also clears usualGone.
    setFavorites(personId, { favorites, usual }) {
      db.transaction(() => {
        mq.setFavorites.run(JSON.stringify(favorites || []), JSON.stringify(usual || []), personId);
        mq.setUsualGone.run(0, personId);
      })();
    },

    // A line of their usual left the menu (true), or they've seen it (false).
    setUsualGone(personId, gone) {
      mq.setUsualGone.run(gone ? 1 : 0, personId);
    },

    // Runs `clean` over everyone's favorites and saves the ones it changed
    // (the menu lost an item or an option).
    pruneAllFavorites(clean) {
      db.transaction(() => {
        mq.allFavorites.all().forEach((r) => {
          const before = { favorites: JSON.parse(r.favorites || '[]'), usual: JSON.parse(r.usual || '[]') };
          const after = clean(before);
          if (JSON.stringify(after) !== JSON.stringify(before)) {
            mq.setFavorites.run(JSON.stringify(after.favorites), JSON.stringify(after.usual), r.id);
            if (after.usual.length < before.usual.length) mq.setUsualGone.run(1, r.id);
          }
        });
      })();
    },

    // The banner was dismissed or its Subscribe tapped. Keeps the first time.
    markCalendarPromptDone(personId) {
      mq.setCalendarPromptDone.run(Date.now(), personId);
    },

    // Same for the "Pick your favorite concessions" banner.
    markFavoritesPromptDone(personId) {
      mq.setFavoritesPromptDone.run(Date.now(), personId);
    },

    personByCalendarToken(token) {
      if (typeof token !== 'string' || !token) return null;
      return personRow(mq.personByCalendarToken.get(token));
    },

    // ---- Unlocks ----

    // The movies they've typed the password for, plus any movie they have
    // a seat in. Owning a seat means someone with that movie's password
    // reserved or claimed it for them (both take it), so the seat counts
    // as the unlock -- which also covers seats from before unlocks were
    // the person's, when the browser held them.
    personUnlockedMovieIds(personId) {
      return new Set(mq.personUnlocks.all({ p: personId }).map((r) => r.movie_id));
    },

    unlockMovieForPerson(personId, movieId) {
      mq.personUnlock.run(personId, movieId, Date.now());
    },

    // Every reserved-before-profiles seat (a name, no owner), for "are
    // these yours?". The server picks which of them a person is shown.
    claimableSeats() {
      return mq.claimable.all().map((r) => ({
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
          // One seat of your own per showtime: a second old seat claimed in
          // the same one becomes a guest's, keeping the name it had.
          const asGuest = !!mq.ownSeatIn.get(showtimeId, personId);
          mq.setOwner.run({
            showtime_id: showtimeId, seat_id: seatId, name: asGuest ? row.name : shortName(p),
            person_id: personId, guest: asGuest ? 1 : 0,
            paid: row.paid, concessions_paid: row.concessions_paid, concessions: row.concessions,
            // Still reserved when it was, not when it was claimed.
            reserved_at: row.reserved_at
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
    //
    // `personId` links the seat to a profile: their own seat (`guest`
    // false), named as they're shown to friends, or a guest of theirs
    // (`guest` true), under the name given. null: just a name, nobody's
    // profile. Left out (undefined): whoever had it keeps it while it keeps
    // a name, as before there was a choice.
    setSeat(id, seatId, { name, paid, concessionsPaid, personId, guest }) {
      return db.transaction(() => {
        if (!q.oneShowtime.get(id)) return { ok: false, reason: 'not_found' };
        const prior = q.seat.get(id, seatId);
        let cleanName = String(name || '').trim().slice(0, 80);
        const hadName = !!(prior && prior.status === 'assigned' && prior.name);
        let owner = { person_id: null, guest: 0 };
        if (personId === undefined) {
          if (cleanName && hadName) owner = { person_id: prior.person_id, guest: prior.guest };
        } else if (personId) {
          const p = mq.person.get(personId);
          if (!p) return { ok: false, reason: 'person_not_found' };
          if (guest) {
            if (!cleanName) return { ok: false, reason: 'name_required' };
          } else {
            // One seat of your own per showtime; any more are for guests.
            const own = mq.ownSeatIn.get(id, personId);
            if (own && own.seat_id !== seatId) return { ok: false, reason: 'already_have_seat' };
            cleanName = shortName(p);
          }
          owner = { person_id: personId, guest: guest ? 1 : 0 };
        }
        const keepCart = cleanName && hadName;
        // A seat that changes hands isn't the new owner's to give back
        // (see unclaimSeat): only a seat they reserved themselves is.
        const samePerson = !!(prior && owner.person_id && prior.person_id === owner.person_id);
        mq.upsertSeat.run({
          showtime_id: id,
          seat_id: seatId,
          status: 'assigned',
          name: cleanName,
          paid: paid ? 1 : 0,
          concessions_paid: cleanName && concessionsPaid ? 1 : 0,
          concessions: keepCart ? prior.concessions : '[]',
          person_id: owner.person_id,
          guest: owner.guest,
          reserved_at: samePerson ? prior.reserved_at : null
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

    deleteShowtime(id) {
      return db.transaction(() => {
        q.deleteSeatsFor.run(id);
        return q.deleteShowtime.run(id).changes > 0;
      })();
    },

    // Reserves one open seat in the block for `name`, if it's still open
    // when this runs. A transaction, so two friends tapping the same seat
    // at once can't both get it: one gets 'not_claimable' back.
    // `owner` is { personId, guest } for a signed-in friend reserving for
    // themselves (guest false) or for someone else (guest true, `name` is
    // the guest's).
    claimSeat(id, seatId, name, owner) {
      return db.transaction(() => {
        if (!q.oneShowtime.get(id)) return { ok: false, reason: 'not_found' };
        const row = q.seat.get(id, seatId);
        const seat = row ? normalizeSeatEntry(rowToSeat(row)) : null;
        if (!seat || seat.status !== 'assigned' || seat.name) return { ok: false, reason: 'not_claimable' };
        // One seat of your own per showtime; any more are for guests.
        if (owner && owner.personId && !owner.guest && mq.ownSeatIn.get(id, owner.personId)) {
          return { ok: false, reason: 'already_have_seat' };
        }
        mq.setOwner.run({
          showtime_id: id, seat_id: seatId, name,
          person_id: owner && owner.personId ? owner.personId : null,
          guest: owner && owner.guest ? 1 : 0,
          paid: 0, concessions_paid: 0, concessions: '[]',
          reserved_at: Date.now()
        });
        q.touchShowtime.run(Date.now(), id);
        return { ok: true, showtime: readShowtime(q, id) };
      })();
    },

    // A friend giving back a seat they reserved: it goes back to being an
    // open seat in the block. Only their own (or a guest's they booked),
    // only while nothing on it is paid, and only if they reserved it at or
    // after `reservedSince` -- the showtime's own deadline is the
    // caller's to check.
    unclaimSeat(id, seatId, personId, reservedSince) {
      return db.transaction(() => {
        if (!q.oneShowtime.get(id)) return { ok: false, reason: 'not_found' };
        const row = q.seat.get(id, seatId);
        if (!row || row.status !== 'assigned' || !row.name) return { ok: false, reason: 'not_reserved' };
        if (!personId || row.person_id !== personId) return { ok: false, reason: 'not_yours' };
        if (row.paid || row.concessions_paid) return { ok: false, reason: 'paid' };
        if (!row.reserved_at || row.reserved_at < reservedSince) return { ok: false, reason: 'too_late' };
        mq.setOwner.run({
          showtime_id: id, seat_id: seatId, name: '', person_id: null, guest: 0,
          paid: 0, concessions_paid: 0, concessions: '[]', reserved_at: null
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

    // Either half left out of `patch` keeps what's stored.
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

module.exports = { init, DB_FILE };
