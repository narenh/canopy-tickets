// Generic persistence for a single admin-settable string setting -- same
// idea as sharedPassword.js (which predates this and is left alone since
// it already works), generalized here so the Venmo/Cash App handles don't
// need their own bespoke store each. Each named setting gets its own file
// in DATA_DIR, same durability story as showtimes.json.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Returns an independent {get, set} store for one named text setting, e.g.
// createTextSettingStore('venmo-handle') <-> data/venmo-handle.json.
function createTextSettingStore(name) {
  const file = path.join(DATA_DIR, `${name}.json`);

  return {
    // Returns the current value, or null if none has ever been set.
    get() {
      if (!fs.existsSync(file)) return null;
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data.value || null;
      } catch (e) {
        return null;
      }
    },

    // Pass a falsy/empty value to clear it.
    set(value) {
      ensureDir();
      if (!value) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return null;
      }
      fs.writeFileSync(file, JSON.stringify({ value, updatedAt: Date.now() }));
      return value;
    }
  };
}

module.exports = { createTextSettingStore };
