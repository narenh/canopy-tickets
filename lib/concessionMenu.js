// Persistence for the concession menu -- the list of things a friend can
// order from the reservation page, plus the option groups that items
// with a choice (which sauce, which pretzel flavor) pick from.
//
// One global menu, not one per showtime or per theater: this app exists
// for one person's friend group at, in practice, one theater, and making
// the host retype the AMC menu for every movie would be the whole
// feature's worth of friction. A showtime's orders snapshot the name and
// price they were placed at (see lib/seats.js), so editing the menu
// later never silently rewrites what someone already ordered.
//
// Lives in DATA_DIR alongside showtimes.json, same durability story.
//
// Item ids are opaque and stable: renaming or repricing an item keeps its
// id, so the reservation page can still tell "this cart line is that menu
// item" and show the stepper against it. Deleting an item drops it off
// the menu without touching carts that already contain it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'concession-menu.json');

const MAX_ITEMS = 150;
const MAX_OPTION_GROUPS = 12;
const MAX_OPTIONS = 60;
const MAX_OPTION_NAME = 60;

// The AMC menu, built in so a fresh install has a usable list on day one
// instead of an empty panel the host has to fill before friends can
// order anything.
//
// "Hardcoded but editable" is the whole shape of this: these are what
// you get while no menu file exists. The moment the host saves from the
// editor, the file wins and these stop being consulted -- including for
// an empty menu, which is a deliberate "orders are closed", not a reason
// to fall back. reset() deletes the file to come back here.
//
// Ids are hand-written and stable (not the random uuids a host-added
// item gets), so an order placed against the built-in popcorn still
// lines up with it after the host edits its price, and still lines up
// after a reset.
//
// A price here is what a friend actually owes, full stop. The host buys
// the whole order on their own AMC Stubs account, which both waives the
// $1.99-per-order service fee AMC's app charges and applies the Stubs
// discount to everyone -- so there is no fee, surcharge or markup for
// this app to model, and a cart total is exactly the sum of its lines.
//
// That's also why some of these sit below the price on the board: the
// soda and popcorn ones are discounted, the food ones aren't. `note` is
// free text shown under the item and is where that gets explained (the
// 50c/$1 off labels). Nothing computes off it; `price` is charged as-is.
//
// `optionGroup` is the id of an OPTION GROUP below when ordering this
// item means also picking something, or '' for an item that's just
// itself. Candy is deliberately NOT a group -- it's a flat list of
// individual items, so two different candies are just two lines.
//
// `section` is presentation only: a named section is collapsed behind a
// header in the cart instead of sitting inline, which is what keeps 25
// candy bars from burying the eight things people usually want. '' means
// the main list. Nothing else reads it -- an item's section has no
// bearing on price, options, or what lands in an order.
const DEFAULT_ITEMS = [
  { id: 'amc-large-soda', name: 'Large Soda', price: 7.49, note: '50\u00a2 off', section: '', optionGroup: '' },
  { id: 'amc-icee', name: 'ICEE', price: 8.49, note: '', section: '', optionGroup: '' },
  { id: 'amc-large-popcorn', name: 'Large Popcorn', price: 10.49, note: '$1 off', section: '', optionGroup: '' },

  { id: 'amc-chicken-tenders', name: 'Chicken Tenders', price: 11.49, note: '', section: '', optionGroup: 'sauce' },
  { id: 'amc-popcorn-chicken', name: 'Popcorn Chicken', price: 8.99, note: '', section: '', optionGroup: 'sauce' },
  { id: 'amc-impossible-nuggets', name: 'IMPOSSIBLE Nuggets', price: 11.49, note: '', section: '', optionGroup: 'sauce' },
  { id: 'amc-extra-sauce', name: 'Extra Sauce', price: 0.99, note: '', section: '', optionGroup: 'sauce' },
  { id: 'amc-hot-dog', name: 'All-Beef Hot Dog', price: 8.49, note: '', section: '', optionGroup: '' },
  { id: 'amc-movie-nachos', name: 'MovieNachos', price: 8.99, note: '', section: '', optionGroup: '' },
  { id: 'amc-waffle-fries', name: 'Waffle Fries', price: 7.49, note: '', section: '', optionGroup: '' },
  { id: 'amc-mozzarella-sticks', name: 'Mozzarella Sticks w/ Marinara', price: 8.99, note: '', section: '', optionGroup: '' },
  { id: 'amc-street-corn-poppers', name: 'Street Corn Poppers', price: 10.19, note: '', section: '', optionGroup: '' },
  { id: 'amc-stone-fired-pizza', name: 'Stone Fired Pizza', price: 11.49, note: '', section: '', optionGroup: 'pizza' },
  { id: 'amc-pretzel-bites', name: 'Bavarian Pretzel Bites', price: 9.49, note: '', section: '', optionGroup: 'pretzel' },
  { id: 'amc-legend-pretzel', name: 'Bavarian Legend Pretzel', price: 17.49, note: '', section: '', optionGroup: 'pretzel' },
  { id: 'amc-cookies-8', name: 'Mini Chocolate Chip Cookies - 8 ct.', price: 7.49, note: '', section: '', optionGroup: '' },
  { id: 'amc-cookies-24', name: 'Mini Chocolate Chip Cookies - 24 ct.', price: 17.49, note: '', section: '', optionGroup: '' },

  { id: 'amc-candy-airhead-soft-filled-bites', name: 'Airhead Soft Filled Bites', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-airhead-xtreme-bites', name: 'Airhead Xtreme Bites', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-buncha-crunch', name: 'Buncha Crunch', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-cookie-dough-bites', name: 'Cookie Dough Bites', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-chocolate-covered-pretzels', name: 'Chocolate Covered Pretzels', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-cinema-sweets-wild-berry-rings', name: 'Cinema Sweets Wild Berry Rings', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-haribo-gold-bears', name: 'Haribo Gold Bears', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-hi-chew-getaway', name: 'Hi-Chew Getaway', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-jr-caramels', name: 'Jr. Caramels', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-junior-mints', name: 'Junior Mints', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-lifesaver-gummies-fruit-rings', name: 'LifeSaver Gummies Fruit Rings', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-m-and-m-peanut', name: 'M&M Peanut', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-m-and-m-peanut-butter', name: 'M&M Peanut Butter', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-m-and-m-milk-chocolate', name: 'M&M Milk Chocolate', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-nerds-gummy-clusters', name: 'Nerds Gummy Clusters', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-nerds-very-berry-cluster', name: 'Nerds Very Berry Cluster', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-raisinets', name: 'Raisinets', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-red-vines', name: 'Red Vines', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-reeses-pieces', name: "Reese's Pieces", price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-skittles', name: 'Skittles', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-sour-patch-kids', name: 'Sour Patch Kids', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-sour-patch-watermelon', name: 'Sour Patch Watermelon', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-starburst-minis', name: 'Starburst Minis', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-trolli-sour-brite-crawlers', name: 'Trolli Sour Brite Crawlers', price: 6.99, note: '', section: 'Candy', optionGroup: '' },
  { id: 'amc-candy-welchs-fruit-snacks', name: "Welch's Fruit Snacks", price: 6.99, note: '', section: 'Candy', optionGroup: '' }
];

// A group is one named list of choices. An item points at a group by id,
// so a group can be shared by several items (every fried thing takes the
// same sauce cups) or belong to exactly one (a pizza's toppings) -- same
// mechanism either way, which is what keeps "add Marinara" a single edit
// rather than one per tenders-shaped item.
//
// One pick per unit ordered: AMC's own screen says "CHOOSE SAUCE (pick
// one)", and two orders of tenders are two cups, quite possibly two
// different ones.
//
// All three lists are transcribed from AMC's own ordering screens at
// Metreon rather than guessed. A group the host creates and hasn't
// filled in yet is still legal -- an item whose group has no options
// behaves exactly like an item with no group until someone fills it.
//
// Calories are on AMC's list and deliberately not here: nothing in this
// app needs them to get an order to the counter. And yes, the icing cup
// is a real order that has been placed.
const DEFAULT_OPTION_GROUPS = [
  {
    id: 'sauce',
    label: 'Sauce',
    options: [
      'BBQ Sauce',
      'Buffalo Sauce',
      'Honey Mustard',
      'Icing Cup',
      'Marinara Dipping Sauce',
      "Mike's Hot Honey",
      'Ranch'
    ]
  },
  {
    id: 'pretzel',
    label: 'Pretzel Flavor',
    options: [
      'Cinnamon Sugar w/Icing',
      'Dill Pickle w/ Cheese',
      'Garlic Parmesan w/Cheese',
      'Salted w/Cheese',
      'Unsalted w/Cheese'
    ]
  },
  { id: 'pizza', label: 'Pizza Flavor', options: ['4-Cheese', 'Hot Honey Sausage', 'Pepperoni'] }
];

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function cloneItems(items) {
  return items.map((i) => ({ ...i }));
}

function cloneGroups(groups) {
  return groups.map((g) => ({ ...g, options: g.options.slice() }));
}

// Money is stored as a plain number of dollars (same as a showtime's
// `price`), rounded to cents so a stray 9.489999 can't accumulate into
// an off-by-a-penny cart total.
function parsePrice(raw) {
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

// Blank entries dropped and duplicates collapsed: the editor is a box of
// text lines and the empty one at the bottom shouldn't need
// special-casing on the way out. Compared case-insensitively so "Ranch"
// and "ranch" don't both end up in the dropdown, keeping whichever
// spelling was typed first.
function normalizeOptionList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  raw.forEach((entry) => {
    const name = String(entry == null ? '' : entry).trim().slice(0, MAX_OPTION_NAME);
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key) || out.length >= MAX_OPTIONS) return;
    seen.add(key);
    out.push(name);
  });
  return out;
}

// A group with no label is dropped (same "blank row" reasoning as items);
// a group with no options is KEPT, since that's the legitimate state of
// a group the host has created but not filled in yet.
function normalizeOptionGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seenIds = new Set();
  raw.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const label = String(entry.label == null ? '' : entry.label).trim().slice(0, 60);
    if (!label || out.length >= MAX_OPTION_GROUPS) return;
    let id = typeof entry.id === 'string' ? entry.id.trim().slice(0, 64) : '';
    if (!id || seenIds.has(id)) id = crypto.randomUUID();
    seenIds.add(id);
    out.push({ id, label, options: normalizeOptionList(entry.options) });
  });
  return out;
}

// Accepts whatever the admin editor posted and returns a clean menu.
// Rows with a blank name are dropped rather than rejected -- the editor
// keeps an empty row at the bottom to type into, and that row shouldn't
// have to be special-cased on the way out.
//
// `validGroupIds`, when given, is what keeps an item from pointing at a
// group the same save just deleted: a dangling reference becomes no
// group at all rather than a choice nobody can make.
function normalizeItems(raw, validGroupIds) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seenIds = new Set();
  raw.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const name = String(entry.name == null ? '' : entry.name).trim().slice(0, 120);
    if (!name || out.length >= MAX_ITEMS) return;
    // Reuse the id the editor sent back (so an edit is an edit, not a
    // delete + re-add), but never let two rows share one.
    let id = typeof entry.id === 'string' ? entry.id.trim().slice(0, 64) : '';
    if (!id || seenIds.has(id)) id = crypto.randomUUID();
    seenIds.add(id);
    let optionGroup = typeof entry.optionGroup === 'string' ? entry.optionGroup.trim().slice(0, 64) : '';
    if (optionGroup && validGroupIds && !validGroupIds.has(optionGroup)) optionGroup = '';
    out.push({
      id,
      name,
      price: parsePrice(entry.price),
      note: String(entry.note == null ? '' : entry.note).trim().slice(0, 120),
      // Free text rather than an id into a list of sections: a section is
      // a heading, not a thing anything points at, and two items are in
      // the same one exactly when they spell it the same way.
      section: String(entry.section == null ? '' : entry.section).trim().slice(0, 60),
      optionGroup
    });
  });
  return out;
}

module.exports = {
  MAX_ITEMS,
  MAX_OPTION_GROUPS,
  MAX_OPTIONS,
  DEFAULT_ITEMS,
  DEFAULT_OPTION_GROUPS,
  normalizeItems,
  normalizeOptionGroups,

  // Returns { items, optionGroups, isDefault }. `isDefault` is true while
  // no menu has been saved and these are the built-ins -- the editor uses
  // it to say so, and to know whether "restore the AMC menu" would change
  // anything.
  //
  // An unparseable file falls back to the built-ins too: a corrupted menu
  // shouldn't mean friends see no menu at all, and the host's next save
  // overwrites the bad file anyway.
  get() {
    if (fs.existsSync(FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        // A menu saved before option groups existed has no `optionGroups`
        // key. Fall back to the built-in groups rather than an empty list,
        // so a sauce dropdown isn't silently empty after an upgrade; the
        // host can still clear them deliberately, which stores [].
        const optionGroups = Array.isArray(data.optionGroups)
          ? normalizeOptionGroups(data.optionGroups)
          : cloneGroups(DEFAULT_OPTION_GROUPS);
        const ids = new Set(optionGroups.map((g) => g.id));
        return { items: normalizeItems(data.items, ids), optionGroups, isDefault: false };
      } catch (e) {
        // fall through to the built-ins
      }
    }
    return {
      items: cloneItems(DEFAULT_ITEMS),
      optionGroups: cloneGroups(DEFAULT_OPTION_GROUPS),
      isDefault: true
    };
  },

  // Returns the normalized menu that was actually written, so the editor
  // can render back the ids assigned to brand-new rows and groups.
  set(items, optionGroups) {
    ensureDir();
    const groups = normalizeOptionGroups(optionGroups);
    const ids = new Set(groups.map((g) => g.id));
    const saved = { items: normalizeItems(items, ids), optionGroups: groups };
    fs.writeFileSync(FILE, JSON.stringify({ ...saved, updatedAt: Date.now() }, null, 2), 'utf8');
    return { ...saved, isDefault: false };
  },

  // Drops the saved menu so the built-in AMC list takes over again.
  // Deliberately a delete rather than "write the defaults into the file":
  // that way a later change to DEFAULT_ITEMS actually reaches a host who
  // reset, instead of freezing today's list into their data.
  reset() {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
    return module.exports.get();
  }
};
