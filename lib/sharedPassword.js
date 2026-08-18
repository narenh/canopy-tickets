// Persistence for the friend-facing "shared" password. This replaces the
// old SHARED_PASSWORD env var: instead of a fixed value that requires a
// redeploy to change, the admin sets/rotates it from the editor UI (handy
// for handing out a fresh password per movie). Lives in DATA_DIR, same as
// showtimes.json, so it survives redeploys.
//
// No password set at all (file absent) means friend login is off --
// get() returns null, and the login check in server.js only compares
// against a shared password when this returns something truthy.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'shared-password.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

module.exports = {
  // Returns the current password string, or null if none is set (friend
  // login disabled).
  get() {
    if (!fs.existsSync(FILE)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return data.password || null;
    } catch (e) {
      return null;
    }
  },

  // Pass a falsy/empty password to clear it (disabling friend login).
  set(password) {
    ensureDir();
    if (!password) {
      if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
      return null;
    }
    fs.writeFileSync(FILE, JSON.stringify({ password, updatedAt: Date.now() }));
    return password;
  }
};
