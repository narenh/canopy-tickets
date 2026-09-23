// Every sentence this app says out loud, in one place.
//
// EDITING: change the text between the quotes, save, reload the page.
// There's no build step -- the file is served straight to the browser and
// read at load time.
//
// {braces} are placeholders the code fills in. Keep the name spelled
// exactly as it appears ({amount}, {seat}, {count}) or it'll show through
// to the page verbatim; move it anywhere in the sentence you like, or
// drop it if you don't want it said.
//
// Pairs ending in `One`/`Many` are singular and plural of the same line.
//
// NOT here, on purpose:
//   * One- and two-word button labels (Save, Close, Edit, Reserve, Skip).
//     They live next to the buttons they name, where the code reads
//     better for having them inline.
//   * The concessions menu -- item names, prices and option groups are
//     data, not copy. Edit those in the admin menu editor; the built-in
//     list they start from is lib/concessionMenu.js.
//   * Anything only a developer sees (thrown errors, console output).
const COPY = {

  // ---------------- LOGIN ----------------
  login: {
    tagline: 'Enter the password to access seat reservations.',
    wrongPassword: 'Wrong password.',
    failed: 'Something went wrong. Try again.',
    unreachable: 'Could not reach the server. Try again.'
  },

  // ---------------- RESERVATION PAGE (what friends see) ----------------
  friend: {
    intro: 'Reserve a spot below. Tap any reserved seat to add concessions, up to 2 hours before showtime.',

    list: {
      loadFailed: 'Could not load showtimes. Try again.',
      empty: 'No showtimes posted yet. Check back soon.',
      noSeats: 'No seats posted yet',
      seatsAvailableOne: '{count} seat available',
      seatsAvailableMany: '{count} seats available',
      // Shown under a reserved seat's name on the list.
      concessionsOne: '🍿 {count} item',
      concessionsMany: '🍿 {count} items',
      noConcessions: 'No concessions'
    },

    seatMap: {
      noteOpen: "Tap a gold seat to reserve it, or a red one to see whose it is. Gray seats aren't part of this block.",
      noteSoldOut: "Every seat in this block is taken — tap a red seat to see whose it is. Gray seats aren't part of this block.",
      // The little black tooltip on a seat.
      tipTaken: '{seat} — {name}',
      tipAvailable: '{seat} — available',
      tipNotOurs: '{seat} — not purchased'
    },

    claim: {
      title: 'Reserve seat {seat}',
      hint: "Your name will be shown next to this seat so the host knows it's yours.",
      noName: 'Enter your name first.',
      taken: 'Sorry, someone just claimed that seat. Pick another.',
      failed: 'Could not claim that seat. Try again.',
      unreachable: 'Could not reach the server. Try again.'
    },

    // The card after a seat is claimed, one step at a time.
    success: {
      heading: "You're in! 🎬",
      subtitle: 'Seat {seat} for {title} -- {price}.',
      subtitleNoPrice: 'Seat {seat} for {title}.',
      unnamedShowtime: 'this showtime',
      step: 'Step {n} of {total}',
      payVenmo: 'Pay {amount} via Venmo',
      payVenmoNoPrice: 'Pay via Venmo',
      payCashApp: 'Pay {amount} via Cash App',
      payCashAppNoPrice: 'Pay via Cash App',
      alreadyPaid: 'I’ve already paid',
      addCalendar: '📅 Add to calendar',
      addConcessions: '🍿 Add concessions'
    },

    cart: {
      subtitle: 'Seat {seat} · {name}',
      locked: 'The order for this showtime is final — it’s gone in at the counter. Message the host if you still need to change something.',
      menuEmpty: "The host hasn't put up a concessions menu yet. Check back later.",
      noPriceSet: 'No price set',
      sectionItemsOne: '{count} item',
      sectionItemsMany: '{count} items',
      sectionInOrder: '{count} in order',
      choosePrompt: 'Choose {label}...',
      // A cart line placed before its item had a choice to make.
      noChoice: ' · no {label}',
      orderCountOne: '{count} item',
      orderCountMany: '{count} items',
      saveRetry: "Couldn't save — tap to retry",
      saveClosed: 'The host finalized the order for this showtime, so this change was not saved.',
      saveNotReserved: 'That seat is no longer reserved, so there is nothing to order for it.',
      // Named lines that still need a sauce/flavour picked. `items` is a
      // comma-joined list of `missingItem` below.
      missingHint: 'Remove and re-add to pick {items}.',
      missingItem: 'a {label} for {name}',
      missingItemMany: 'a {label} for {name} (×{count})'
    },

    totals: {
      ticket: 'Ticket',
      concessions: 'Concessions',
      tax: 'Tax ({rate})',
      concessionsPaid: 'Concessions paid',
      owed: 'You owe',
      settled: 'All settled',
      paidNote: '✓ paid',
      undo: 'undo',
      markPaid: 'I’ve paid {amount}',
      venmo: 'Venmo {amount}',
      cashApp: 'Cash App {amount}',
      foodPending: 'Concessions settle after order is placed.'
    }
  },

  // ---------------- EDITOR (what the host sees) ----------------
  admin: {
    listSubtitle: 'Seat blocks for your crew',
    listLoadFailed: 'Could not load showtimes. Try again.',
    listEmptyAll: 'No showtimes yet. Tap "+ New Showtime" to create your first seat block.',
    listEmptyUpcoming: 'No upcoming showtimes. Tap "+ New Showtime" to create one.',

    seatGrid: {
      help: 'Tap a yellow seat to add it to your block. Tap a green seat to assign it to a friend. Tap a red seat to edit, clear, or release it.',
      fieldsHelp: 'Tap title/theater to rename; use pickers for date/time and the dropdowns for format and screen.',
      tipClaimed: '{seat} — {name} ({state})',
      tipAvailable: '{seat} — available',
      tipNotOurs: '{seat} — not in your block',
      legendNotOurs: 'Not in your block',
      legendAvailable: 'Your block, available',
      legendClaimed: 'Reserved by a friend',
      legendPaid: 'Reserved &amp; paid'
    },

    seatEditor: {
      title: 'Seat {seat}',
      nameLabel: 'Assigned to (leave blank = available for a friend to claim)',
      concessionsPaid: 'Concessions paid ({amount} with tax)',
      orderHead: 'Ordered from the reservation page'
    },

    seatSummary: {
      none: 'Your seats: <b>none</b>',
      heading: 'Your seats ({count}):',
      available: 'AVAILABLE',
      empty: 'No seats in your block yet',
      owes: ' owes {amount}',
      paid: ' ✓paid'
    },

    orders: {
      heading: 'Concessions',
      empty: 'Nothing ordered yet. Friends add items from the reservation page; what they pick shows up here.',
      seatHeadingOne: 'Concessions ({count} seat)',
      seatHeadingMany: 'Concessions ({count} seats)',
      choices: 'Choices',
      tax: 'Tax ({rate})',
      total: 'Total to buy',
      finalize: 'Finalize Order',
      reopen: 'Reopen Order',
      noteOpen: 'Friends can still add and remove items. Finalize when you go to the counter.',
      noteClosed: 'Order is final. Friends can see their carts but not change them.',
      finalizeConfirm: 'Finalize the order? Friends will not be able to change what they asked for until you reopen it.',
      finalizeFailed: 'Could not change that. Try again.'
    },

    menuEditor: {
      blurb: "What friends can order from the reservation page. Ships with the AMC menu already filled in -- edit, reprice, add or remove anything and save, and your version takes over. One list for every showtime; orders are attached to each reserved seat, and friends can change theirs until you finalize that showtime's order. Removing an item here doesn't disturb orders already placed -- those keep the name and price they were placed at.",
      groupsBlurb: "Lists of choices an item comes with, one option per line. Friends pick one per unit ordered, so two chicken tenders get two picks. A group can be shared by several items (everything fried points at Sauce) or belong to just one (a pizza's toppings) -- assign it with the dropdown on each item above.",
      empty: "No items -- friends can't order anything until you add one, or restore the AMC menu below.",
      groupsEmpty: 'No option groups. Add one if an item comes with a choice (a sauce, a flavor, a topping).',
      noChoices: 'No choices',
      optionsPlaceholder: 'One option per line',
      usingDefault: 'Showing the built-in AMC menu. Edit anything and save to make it your own list.',
      loadFailed: 'Could not load the menu.',
      removed: 'Removed -- save the menu to apply it.',
      resetConfirm: 'Replace the menu with the built-in AMC list? Orders friends have already placed are not affected.',
      restoring: 'Restoring...',
      restored: 'Restored the AMC menu.',
      restoreFailed: 'Could not restore the AMC menu. Try again.',
      groupUnused: 'not used yet',
      groupUsedOne: 'used by {count} item',
      groupUsedMany: 'used by {count} items'
    },

    status: {
      saving: 'Saving...',
      saved: 'Saved.',
      saveFailed: 'Save failed. Try again.',
      uploading: 'Uploading...',
      uploaded: 'Uploaded.',
      uploadFailed: 'Upload failed. Try again.',
      chooseImage: 'Choose an image first.',
      typeTitle: 'Type a title first.',
      friendLoginOff: 'Friend login turned off.'
    },

    passwordBlurb: 'What friends enter at login to reach the reservation page. Change it any time -- e.g. a fresh password per movie. Leave it blank and save to turn off friend access entirely.',
    payBlurb: "Shown as pay buttons to friends right after they claim a seat. Fill in either, both, or neither -- a button only shows up for the one(s) you've set.",
    ogBlurb: "Shown when this site's link is shared in iMessage, Facebook, Instagram, etc.",
    logoBlurb: 'Shown on the login screen and at the top of this and the reservation page. PNG with a transparent background works best.',

    deleteConfirm: 'Delete this showtime? This cannot be undone.',
    deleteFailed: 'Could not delete. Try again.',
    openFailed: 'Could not open that showtime.',
    notFound: 'Could not find that showtime.',
    auditorium: 'Auditorium {number} ({name})',
    // For a screen with no `name` in seat-layout.js.
    auditoriumUnnamed: 'Auditorium {number}'
  },

  // Shown on both pages when the session is gone and bouncing to the
  // login screen has already been tried once.
  sessionTrouble: 'Session trouble &mdash; <a href="/" style="color:#c9a24b;">click here to sign in again</a>.'
};

// COPY.friend.cart.locked, with {braces} swapped for values:
//   t('friend.claim.title', { seat: 'G17' })
// A missing key returns the path itself rather than "undefined", so a
// typo shows up on the page as the thing to go and fix.
function t(path, vars){
  let node = COPY;
  for (const key of path.split('.')){
    if (node == null || typeof node !== 'object') return path;
    node = node[key];
  }
  if (typeof node !== 'string') return path;
  if (!vars) return node;
  return node.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole);
}

// Fills every <element data-copy="some.path"> with its line. Markup that
// carries HTML (a link, an entity) marks itself data-copy-html.
function applyCopy(root){
  (root || document).querySelectorAll('[data-copy]').forEach(el => {
    const text = t(el.getAttribute('data-copy'));
    if (el.hasAttribute('data-copy-html')) el.innerHTML = text;
    else el.textContent = text;
  });
}
