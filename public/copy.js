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

  // ---------------- SIGN IN (signed out, at / and /admin) ----------------
  // The passkey runs here; email goes to the Canopy account service.
  signin: {
    tagline: 'Sign in with your Canopy Account or continue with email.',
    passkey: 'Sign in with passkey',
    or: 'or',
    email: 'Continue with email',
    unknownPasskey: "That passkey isn't linked to an account anymore. Continue with email to set up a new one.",
    noPasskeys: "This browser can't use passkeys. Open this page in Safari or Chrome, or continue with email.",
    unavailable: "Signing in isn't working here right now. Try again later.",
    failed: 'Something went wrong. Try again.',
    unreachable: 'Could not reach Canopy accounts. Try again.'
  },

  // ---------------- RESERVATION PAGE (what friends see) ----------------
  friend: {
    // Above the All Movies grid.
    intro: 'Tap a movie to see its showtimes. Locked ones need their password once.',

    // One film's showtimes, after tapping its poster.
    film: {
      intro: 'Reserve a spot below. Order concessions for your seats from My Showtimes.',
      // On a showtime you already have your seat in.
      going: 'Going',
      addPlusOne: 'Add +1'
    },

    // A poster tile on the landing grid.
    grid: {
      showtimesOne: '{count} showtime',
      showtimesMany: '{count} showtimes',
      next: 'Next: {when}'
    },

    list: {
      loadFailed: 'Could not load showtimes. Try again.',
      empty: 'No showtimes posted yet. Check back soon.',
      noSeats: 'No seats posted yet',
      seatsAvailableOne: '{count} seat available',
      seatsAvailableMany: '{count} seats available',
      // Shown under a reserved seat's name on the list.
      // A guest's seat: who brought them.
      via: 'via {name}',
      you: 'you'
    },

    // Unlocking a movie, over its poster on the All Movies tab.
    unlock: {
      placeholder: 'Password',
      button: 'Unlock',
      cancel: 'Cancel',
      wrong: 'Wrong password',
      tooMany: 'Too many tries. Wait a few minutes.',
      failed: "Couldn't reach the server."
    },

    mine: {
      empty: "You don't have any seats yet.",
      browse: 'Browse movies',
      locked: 'Unlock this movie to make changes',
      going: 'Going ({count})',
      // Your order (or a guest's) on a My Showtimes card.
      add: '+ Add concessions',
      addFor: '+ Add concessions for {name}',
      head: 'Concessions ({count})',
      headFor: "{name}'s concessions ({count})",
      edit: '+ Add / Edit',
      view: 'View',
      none: 'No concessions',
      noneFor: 'No concessions for {name}',
      // The ⋯ beside the pay button under the poster.
      payMore: 'More options',
      // Giving a seat back, from that ⋯ (unpaid, reserved in the last 24
      // hours, and the showtime more than 24 hours off).
      release: 'Release seat {seat}',
      releaseGuest: "Release {name}'s seat ({seat})",
      releaseConfirm: 'Release seat {seat}? Anyone will be able to reserve it.',
      releaseYes: 'Release',
      releaseNo: 'Cancel',
      releaseFailed: "Couldn't release it. It may be too late now."
    },

    // A line of your usual order left the menu (red, top of My Showtimes).
    usualBanner: {
      title: 'Item discontinued',
      text: 'An item in your usual order is no longer available at this theater.',
      button: 'Update order',
      // On "Your usual" in the cart while the banner's up.
      cartNote: "Something you usually get isn't available anymore."
    },

    // Replaces the calendar banner while you have no showtimes and there
    // are seats reserved before profiles still waiting to be claimed.
    claimBanner: {
      title: 'Claim your previous reservations',
      text: "If you signed up for showtimes before creating your account, you'll need to transfer them into your account.",
      button: 'Claim now'
    },

    // Under the calendar banner while you have no favorites and no usual,
    // until dismissed or tapped.
    favBanner: {
      title: 'Pick your favorite concessions',
      text: 'Select your favorite items and create a usual order you can choose with one tap.',
      button: 'Add favorites'
    },

    // The banner at the top of My Showtimes, until dismissed or tapped.
    calBanner: {
      title: 'Subscribe to your showtimes',
      text: 'Add the subscription link to your calendar app and all your showtimes will appear automatically.',
      subscribe: 'Subscribe'
    },

    // Your usual order and favorite items (Settings -> Favorite concessions).
    favorites: {
      heading: 'Favorites',
      hint: 'These show first whenever you add concessions.',
      usualHeading: 'Your usual',
      usualHint: 'Your whole order, added in one tap.',
      usualEmpty: 'Nothing yet.',
      addUsual: '+ Add to your usual',
      listHeading: 'Favorite items',
      listEmpty: 'No favorites yet.',
      addFavorite: '+ Add a favorite',
      pickUsual: 'Add to your usual',
      pickFavorite: 'Add a favorite',
      moveUp: 'Move up',
      moveDown: 'Move down',
      remove: 'Remove',
      failed: "Couldn't save. Try again.",
      // The cart's section, and the usual's row in it.
      cartSection: 'Favorites',
      cartEdit: 'Edit',
      cartUsual: 'Your usual'
    },

    // Your subscribe-once calendar of every showtime you have a seat in.
    calendar: {
      heading: 'Calendar feed',
      hint: "Subscribe once and every showtime you reserve shows up in your calendar, kept up to date. The link is private to you, so don't share it.",
      subscribe: 'Subscribe in Calendar',
      copy: 'Copy link',
      copied: 'Copied',
      copyPrompt: 'Copy this link:',
      failed: "Couldn't load your calendar link. Try again."
    },

    // The tab bar under the header. Manage, at its right end, is only
    // shown to the admin and opens the editor.
    tabs: {
      mine: 'My Showtimes',
      all: 'All Movies',
      manage: 'Manage'
    },

    // The menu under your photo in the header. It opens on who you're
    // signed in as, with a link to your Canopy account.
    menu: {
      account: 'Canopy Account',
      manageAccount: 'Manage',
      calendar: 'My Calendar Feed',
      settings: 'Settings',
      claimExisting: 'Claim Existing Seats',
      signOut: 'Sign out'
    },

    // Tickets' own settings. Who you are (name, photo, phone, payment
    // handles) is your Canopy account's, linked from here.
    profile: {
      heading: 'Settings',
      accountNote: 'Name and photo:',
      accountLink: 'Canopy Account',
      peanutAllergy: 'Peanut allergy',
      peanutHint: 'Peanut items will be hidden for adjacent seats.',
      amcAList: 'AMC A-List Member',
      favorites: 'Favorite concessions',
      failed: "Couldn't save. Try again."
    },

    // Seats reserved before profiles existed.
    existing: {
      heading: 'Are any of these yours?',
      hint: "Seats reserved before profiles under your name, and any in movies you've unlocked. Tick yours and they join your showtimes.",
      submit: 'These are mine',
      skip: 'Not now',
      none: "No unclaimed seats under your name. If yours is under a nickname, unlock its movie in All Movies to see everyone's, then try again.",
      failed: "Couldn't save. Try again.",
      // Claiming always takes the movie's password, one movie at a time.
      pwHeading: 'Password for {title}',
      pwHint: 'Enter the movie password to claim your seats.',
      pwStep: '(Movie {n} of {count})',
      pwContinue: 'Continue',
      pwBack: 'Back'
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
      hint: 'Your name and photo show on the seat, so everyone knows whose it is.',
      // Already have your own seat in this showtime: the next is a guest's.
      hintGuestOnly: "You already have a seat in this showtime. Who's this one for?",
      alreadyHave: "You already have a seat in this showtime. Enter the name of who you're bringing.",
      forMe: 'For me ({name})',
      forGuest: 'For someone else',
      noName: "Enter their name first.",
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
      // An A-List member's own seat on a swap-eligible showtime: no pay
      // buttons, this instead. {name} is the host's first name.
      aListSwap: 'Text {name} to organize an A-List swap',
      aListSwapNoName: 'Text the host to organize an A-List swap',
      // What that text says when it opens in Messages.
      aListSwapText: 'Can we do an A-List swap for {title} on {date}?',
      payVenmoNoPrice: 'Pay via Venmo',
      payCashApp: 'Pay {amount} via Cash App',
      payCashAppNoPrice: 'Pay via Cash App',
      alreadyPaid: 'I’ve already paid',
      addConcessions: '🍿 Add concessions'
    },

    cart: {
      subtitle: 'Seat {seat} · {name}',
      locked: 'This order has been placed and can no longer be changed or refunded.',
      finalEmpty: 'Nothing was ordered for this seat.',
      menuEmpty: "The host hasn't put up a concessions menu yet. Check back later.",
      noPriceSet: 'No price set',
      sectionItemsOne: '{count} item',
      sectionItemsMany: '{count} items',
      sectionInOrder: '{count} in order',
      // Under an item with a required pick, and above its options.
      chooseOption: 'Choose a {label}',
      // Beside an item's price: how many options its "+" will offer.
      choicesOne: '{count} {label}',
      choicesMany: '{count} {label}s',
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
      concessions: 'Concessions',
      tax: 'Tax ({rate})',
      total: 'Total',
      paidNote: '✓ paid',
      undo: 'undo',
      markPaid: 'I’ve paid',
      markPaidFull: 'I’ve paid {amount}',
      venmo: 'Venmo {amount}',
      cashApp: 'Cash App {amount}',
      foodPending: 'Concessions settle after order is placed.'
    }
  },

  // ---------------- EDITOR (what the host sees) ----------------
  admin: {
    // Top right of the Ticket Manager: back to the friend side.
    backToApp: 'My Showtimes',
    // A box under a showtime's info line; off for a new showtime.
    aListSwap: 'Eligible for A-List swap',
    movies: {
      none: 'No movies yet. Tap "+ Add movie" to start.',
      noneUpcoming: 'Nothing coming up. Add a movie, or a showtime to one below.',
      loadFailed: 'Could not load movies. Try again.',
      openFailed: 'Could not open that movie.',
      typeTitle: 'Type a title first.',
      titleTaken: 'Another movie already has that title.',
      noShowtimes: 'No showtimes yet',
      noUpcomingShowtimes: 'No upcoming showtimes. Tap "+ Add showtime" to add one.',
      showtimesOne: '{count} showtime',
      showtimesMany: '{count} showtimes',
      next: 'Next: {when}',
      last: 'Last: {when}',
      deleteConfirm: 'Delete "{title}"? It has no showtimes.',
      noPassword: 'No password yet',
      passwordNone: "None yet -- friends can't unlock this",
      passwordNote: "Friends type it once per phone. Changing it doesn't lock out phones that already unlocked."
    },

    people: {
      none: 'Nobody has signed in yet.',
      loadFailed: 'Could not load people. Try again.',
      seatsOne: '{count} Reservation',
      seatsMany: '{count} Reservations',
      // On the admin's own row (you; also the host, whose seats owe nothing).
      adminTag: 'Admin',
      // Their Canopy account has been deleted. Their seats stay theirs.
      formerTag: 'Former member'
    },

    // The pill at the bottom of a showtime while it saves.
    save: {
      saving: 'Saving…',
      saved: 'All changes saved',
      failed: "Couldn't save · Tap to retry"
    },

    seatGrid: {
      help: 'Tap a yellow seat to add it to your block. Tap a green seat to assign it to a friend. Tap a red seat to edit, clear, or release it.',
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
      personLabel: 'Person',
      personNone: 'No profile (just a name)',
      personUnknown: 'Their profile (the list didn’t load)',
      guestLabel: 'A guest they’re bringing',
      guestForced: 'A guest they’re bringing ({seat} is their own seat)',
      nameLabel: 'Assigned to (leave blank = available for a friend to claim)',
      namePlaceholder: 'e.g. Jordan',
      ownNameLabel: 'Shown to friends as',
      guestNameLabel: 'Guest’s name',
      guestPlaceholder: 'e.g. Jordan',
      guestNameRequired: 'Enter the guest’s name.',
      concessionsPaid: 'Concessions paid ({amount} with tax)',
      orderHead: 'Ordered from the reservation page',
      releaseConfirm: 'Release {seat}? {name} loses this seat and anything they ordered for it.'
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
      chooseImage: 'Choose an image first.'
    },

    payBlurb: "Shown as pay buttons to friends right after they claim a seat. Fill in either, both, or neither -- a button only shows up for the one(s) you've set.",
    ogBlurb: "Shown when this site's link is shared in iMessage, Facebook, Instagram, etc.",
    logoBlurb: 'Shown at the top of this and the reservation page. PNG with a transparent background works best.',

    deleteConfirm: 'Delete this showtime? This cannot be undone.',
    deleteFailed: 'Could not delete. Try again.',
    openFailed: 'Could not open that showtime.',
    notFound: 'Could not find that showtime.',
    auditorium: 'Auditorium {number} ({name})',
    // For a screen with no `name` in seat-layout.js.
    auditoriumUnnamed: 'Auditorium {number}'
  },

  // Shown on both pages when you've been signed out and sending you to
  // sign in again has already been tried once.
  sessionTrouble: 'Session trouble &mdash; <a href="{home}" style="color:#c9a24b;">click here to sign in again</a>.'
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
