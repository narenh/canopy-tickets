// The showtime store server.js uses: SQLite (lib/sqliteStore.js), which
// on its first start imports showtimes.json and checks the copy.
//
// If that check fails, this falls back to the JSON store the app has
// always run on (lib/jsonStore.js) and says so loudly in the log. The
// app keeps working on the data it had; nothing was changed; the next
// start tries the migration again. Better than refusing to start (a
// friend can't reserve) or starting on a database that didn't check out.

const sqliteStore = require('./sqliteStore');

let store;
try {
  store = sqliteStore.init();
  if (store.migrated) {
    const m = store.migrated;
    console.log(
      `[canopy-tickets] Moved showtimes.json into SQLite (${sqliteStore.DB_FILE}): ` +
        `${m.showtimes} showtime(s) across ${m.movies.length} movie(s), ${m.seats} seat(s), ` +
        `${m.claimedSeats} reserved, ${m.seatsWithConcessions} with concessions. Every showtime checked ` +
        'against the original. showtimes.json was left as it was (and is no longer read); ' +
        `a copy is in ${m.backupDir}.`
    );
    m.movies.forEach((movie) => console.log(`[canopy-tickets]   ${movie.title}: ${movie.n} showtime(s)`));
  }
} catch (err) {
  console.error('[canopy-tickets] !!! SQLite store unavailable -- running on showtimes.json instead. !!!');
  console.error(`[canopy-tickets] ${err && err.stack ? err.stack : err}`);
  store = { kind: 'json', ...require('./jsonStore') };
}

module.exports = store;
