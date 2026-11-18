// What someone's movie pass says right now: their next showtime, whether
// they owe anything, their ticket once it's ready. A pure function of the
// data and the clock, so the sweep in server.js can rebuild every pass,
// compare, and push only the ones that changed.
//
// Two looks (see README.md, "The movie pass"): Wallet's classic event
// ticket until the AMC QR is on the pass, Apple's poster event ticket from
// then. Wallet's poster style only renders with a barcode, and a barcode
// can't be shown greyed out, so the switch to the poster is the "your
// ticket is ready" moment.
//
// Notifications come from fields with a changeMessage: Wallet alerts when
// such a field's value changes. So a field only carries one in the version
// where its new value is worth an alert, and every other change is silent.

const { normalizeSeats, concessionsGrandTotal, isHostSeat } = require('../seats');

const TIME_ZONE = 'America/Los_Angeles';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_REMINDER_MS = 7 * DAY_MS;
const DAY_REMINDER_MS = DAY_MS;
const PAY_REMINDER_MS = 4 * HOUR_MS;
const LOCK_SCREEN_LEAD_MS = 1.5 * HOUR_MS;
// How long a showtime's end is guessed to be after its start (semantics
// want an end; nothing here knows the running time).
const RUNNING_MS = 3 * HOUR_MS;

const METREON = {
  name: 'AMC Metreon 16',
  address: '135 4th St #3000, San Francisco, CA 94103',
  // Apple Maps place ID, from MapKit (MKMapItem.identifier).
  placeID: 'IEFA03AAF404DD9DA',
  latitude: 37.7843643,
  longitude: -122.4034055
};

function money(n) {
  return '$' + (Math.round(n * 100) / 100).toFixed(2);
}

// "2026-11-21" in San Francisco for an instant.
function localDate(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  return p;
}

function fmt(ms, opts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, ...opts }).format(new Date(ms));
}
const clock = (ms) => fmt(ms, { hour: 'numeric', minute: '2-digit' });
const monthDay = (ms) => fmt(ms, { month: 'short', day: 'numeric' });
const weekdayDate = (ms) => fmt(ms, { weekday: 'short', month: 'short', day: 'numeric' });

// "11/21/26", the date in every pay note.
function shortDate(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y ? `${m}/${d}/${String(y).slice(-2)}` : '';
}

// Seat ids in reading order: row letter, then number.
function compareSeats(a, b) {
  const ra = /^([A-Z]+)(\d+)$/.exec(a);
  const rb = /^([A-Z]+)(\d+)$/.exec(b);
  if (!ra || !rb) return a.localeCompare(b);
  return ra[1].localeCompare(rb[1]) || Number(ra[2]) - Number(rb[2]);
}

function auditorium(screen) {
  const m = /-(\d+)$/.exec(String(screen || ''));
  return m ? m[1] : '';
}

function lineLabel(l) {
  const options = (l.options || []).filter(Boolean);
  return l.name + (l.qty > 1 ? ' ×' + l.qty : '') + (options.length ? ' (' + options.join(', ') + ')' : '');
}

const field = (key, label, value, extra) => ({ key, label, value, ...(extra || {}) });

// Everything about one person's seats on the showtime: who's in each,
// what's owed, whose order holds them.
function seatSummary(showtime, seatIds, person) {
  const raw = showtime.seats || {};
  const seats = normalizeSeats(raw);
  const price = typeof showtime.price === 'number' ? showtime.price : 0;
  const ids = seatIds.filter((id) => seats[id] && seats[id].status === 'assigned').slice();
  const own = (id) => raw[id] && raw[id].personId === person.id && !raw[id].guest;
  ids.sort((a, b) => (own(b) - own(a)) || compareSeats(a, b));

  let ticket = 0;
  let food = 0;
  let foodOrdered = 0;
  const lines = [];
  const swapSeats = [];
  ids.forEach((id) => {
    const s = seats[id];
    const host = isHostSeat(raw[id]);
    const swaps = !!showtime.aListSwap && !!person.amcAList && own(id);
    if (swaps) swapSeats.push(id);
    if (!host && !swaps && !s.paid && price > 0) ticket += price;
    const total = concessionsGrandTotal(s.concessions);
    foodOrdered += total;
    if (!host && showtime.ordersClosed && !s.concessionsPaid) food += total;
    (s.concessions || []).forEach((l) => lines.push((ids.length > 1 ? id + ': ' : '') + lineLabel(l)));
  });
  return {
    ids,
    own: ids.filter(own),
    who: ids.map((id) => (own(id) ? `${id} You` : `${id} ${seats[id].name}${raw[id] && raw[id].guest ? ' (guest)' : ''}`)),
    ticket: Math.round(ticket * 100) / 100,
    food: Math.round(food * 100) / 100,
    foodOrdered: Math.round(foodOrdered * 100) / 100,
    lines,
    swapSeats
  };
}

// The AMC pass to show: the one holding their own seat, else the one
// holding most of their seats. Null when none holds any of them.
function pickOrder(passes, ids, ownIds) {
  const scored = passes
    .filter((p) => p.barcode && p.barcode.message)
    .map((p) => ({ p, own: p.seats.filter((id) => ownIds.includes(id)).length, n: p.seats.filter((id) => ids.includes(id)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.own - a.own || b.n - a.n);
  return scored.length ? { pass: scored[0].p, others: scored.slice(1).map((x) => x.p) } : null;
}

function venmoLink(handle, amount, note) {
  if (!handle) return null;
  return `https://venmo.com/${encodeURIComponent(handle)}?txn=pay&amount=${amount.toFixed(2)}&note=${encodeURIComponent(note)}`;
}

// Early access the host gave (ctx.earlyAccess: { title }): one field that
// alerts when it changes to a new movie, and says so on the back until the
// movie's showtimes are over. Always present, so the alert is a change of
// value rather than a field appearing.
function earlyAccessField(ctx) {
  const ea = ctx.earlyAccess;
  return ea
    ? field('earlyAccess', 'Early access', `${ea.title} tickets available. Tap "View Schedule" to reserve a seat.`, { changeMessage: '%@' })
    : field('earlyAccess', 'Early access', 'None right now');
}

// Wallet titles a pass's notifications with its organizationName, so it's
// the notification title: fixed. Changing it per alert (tried 2026-11-17)
// got a generic "Event Ticket changed" alert on the phone, as did an
// alert text without %@ (both changed together, so either could be it).
function notificationTitle() {
  return 'Canopy Tickets';
}

// The pass for someone with nothing coming up -- unless they've been given
// early access to a movie, which then takes the front.
function emptyPass(ctx) {
  const ea = ctx.earlyAccess;
  return {
    poster: false,
    json: {
      ...base(ctx),
      eventTicket: {
        primaryFields: [ea ? field('title', 'Early access', ea.title) : field('title', 'Next showtime', 'Nothing booked')],
        secondaryFields: [field('book', ea ? 'Pick your seats at' : 'Book at', ctx.siteHost)],
        backFields: [
          earlyAccessField(ctx),
          field('about', 'About this pass', 'Shows your next showtime as soon as you book one, and updates by itself. Keep Automatic Updates and Allow Notifications on.')
        ]
      },
      featuredActions: [{ identifier: 'showtimes', type: 'viewSchedule', url: ctx.siteUrl + '?tab=movies' }]
    }
  };
}

function base(ctx) {
  return {
    formatVersion: 1,
    passTypeIdentifier: ctx.passTypeIdentifier,
    teamIdentifier: ctx.teamIdentifier,
    serialNumber: ctx.serialNumber,
    authenticationToken: ctx.authenticationToken,
    webServiceURL: ctx.webServiceURL,
    organizationName: notificationTitle(ctx),
    description: 'Canopy movie pass',
    // From the poster (lib/wallet/images.js posterColors) when there is one.
    backgroundColor: (ctx.colors && ctx.colors.background) || 'rgb(20,20,22)',
    foregroundColor: 'rgb(255,255,255)',
    labelColor: (ctx.colors && (ctx.poster ? ctx.colors.posterLabel : ctx.colors.label)) || 'rgb(220,220,220)',
    sharingProhibited: true
  };
}

// ctx: identity (passTypeIdentifier, teamIdentifier, serialNumber,
// authenticationToken, webServiceURL), siteUrl, siteHost, venmoHandle,
// person { id, amcAList }, next { showtime, seatIds, startsAt } or null,
// passes (AMC passes on that showtime), upcoming [{ showtime, seatIds,
// startsAt }] after it, hasPoster, now.
function buildPass(ctx) {
  const { next, person, now } = ctx;
  if (!next) return emptyPass(ctx);
  const { showtime, startsAt } = next;
  const title = showtime.title || 'Movie';
  const s = seatSummary(showtime, next.seatIds, person);
  const owed = Math.round((s.ticket + s.food) * 100) / 100;
  const today = localDate(now);
  const isToday = showtime.date === today;
  const isTomorrow = showtime.date === localDate(now + DAY_MS);
  const aud = auditorium(showtime.screen);
  const seatList = s.ids.join(', ');
  const swapOnly = s.swapSeats.length > 0 && s.swapSeats.length === s.ids.length;

  // The ticket: on the day of the show, once nothing's owed, from the AMC
  // order holding their seat (an A-List swap seat isn't on the host's order).
  const qrSeats = s.ids.filter((id) => !s.swapSeats.includes(id));
  const order = isToday && owed === 0 && qrSeats.length ? pickOrder(ctx.passes || [], qrSeats, s.own) : null;
  const poster = !!order && ctx.hasPoster;

  // Top right: the date, then Tomorrow, then Today.
  const when = field('when', 'Date', isToday ? 'Today' : isTomorrow ? 'Tomorrow' : monthDay(startsAt));

  // The one changeable right-hand field.
  let status;
  if (swapOnly) status = field('ticket', 'Ticket', 'A-List Swap');
  else if (order) status = field('paid', 'Ticket', 'Paid ✓');
  else if (isToday && owed > 0) status = field('owe', 'You owe', money(owed));
  else if (isToday) status = field('ticket', 'Ticket', 'Available Soon');
  else if (showtime.ordersClosed && s.food > 0) status = field('food', 'Food', money(s.food) + ' unpaid');
  else if (s.foodOrdered > 0 && !showtime.ordersClosed) status = field('food', 'Food', money(s.foodOrdered) + ' ✓');
  else status = field('ticket', 'Ticket', s.ticket > 0 ? 'Unpaid' : 'Paid ✓');

  // Reminders, one field: a week out, 24 hours out, and 4 hours out if
  // anything's still owed. Each carries its alert only in its own window;
  // outside them the text changes silently.
  //
  // The buttons the alerts name are Wallet's: "Order" / "Order Delivery"
  // is the order action (Order Delivery or Pickup), which opens Tickets'
  // My Showtimes, where food is ordered and the pay button is.
  const untilStart = startsAt - now;
  const canOrder = !showtime.ordersClosed && !person.amcAList;
  let reminder;
  const alert = { changeMessage: '%@' };
  if (untilStart <= PAY_REMINDER_MS && owed > 0) {
    const what = s.ticket > 0 ? 'Unpaid ticket' : 'Unpaid concessions';
    reminder = field('reminder', 'Reminder', `Reminder: ${what}. Tap "Order Delivery" to pay.`, alert);
  } else if (isToday) {
    reminder = field('reminder', 'Reminder', `${title} is today at ${clock(startsAt)}. Seats ${seatList}.`);
  } else if (untilStart <= DAY_REMINDER_MS) {
    // A-List members order their own food from AMC.
    const food = person.amcAList ? ' Order food in the AMC app.' : canOrder ? ' Tap "Order" to order concessions.' : '';
    reminder = field('reminder', 'Reminder', `${title} is tomorrow at ${clock(startsAt)}.${food}`, alert);
  } else if (untilStart <= WEEK_REMINDER_MS) {
    // Booked inside the week, this is the first they hear: "coming up",
    // not "a week away".
    const when = untilStart > WEEK_REMINDER_MS - DAY_MS ? 'is a week away' : 'is coming up';
    reminder = field('reminder', 'Reminder', `${title} ${when}: ${weekdayDate(startsAt)} at ${clock(startsAt)}.`, alert);
  } else {
    reminder = field('reminder', 'Reminder', 'This pass reminds you a week before and the day before.');
  }

  // Concessions: alerts once, when the host finalizes an order with food
  // on it that hasn't been paid for.
  let concessions;
  // Never for A-List members: their food isn't on the host's order.
  if (showtime.ordersClosed && s.food > 0 && !person.amcAList) {
    concessions = field('concessions', 'Concessions', 'Concessions ordered. Tap "Order Delivery" to pay.', alert);
  } else if (s.lines.length) {
    concessions = field('concessions', 'Concessions', s.lines.join('\n') + `\n${money(s.foodOrdered)}` + (showtime.ordersClosed ? ', paid' : ''));
  } else {
    concessions = field('concessions', 'Concessions', person.amcAList ? 'None' : 'None ordered');
  }

  const back = [reminder, earlyAccessField(ctx)];
  if (owed > 0) {
    const note = `${title} (${shortDate(showtime.date)}, ${s.ids.join(', ')})` + (s.food > 0 ? (s.ticket > 0 ? ' + concessions' : ' concessions') : '');
    const href = venmoLink(ctx.venmoHandle, owed, note);
    const parts = [s.ticket > 0 ? `Tickets ${money(s.ticket)}` : null, s.food > 0 ? `food ${money(s.food)}` : null].filter(Boolean).join(' + ');
    back.push(field('pay', `You owe ${money(owed)}`, parts, href ? { attributedValue: `${parts}. <a href="${href}">Pay for Ticket</a>` } : undefined));
  }
  back.push(field('seatsWho', 'Your seats', s.who.join('\n')));
  back.push(concessions);
  if (s.swapSeats.length) back.push(field('swap', 'A-List Swap', 'Text the host to organize it. Your own ticket comes from AMC, not this pass.'));
  if (order && order.others.length) {
    const rest = order.others.flatMap((p) => p.seats.filter((id) => s.ids.includes(id)));
    back.push(field('split', 'Second order', `${rest.join(', ')} ${rest.length > 1 ? 'are' : 'is'} on another AMC order. Open ${ctx.siteHost} to show it.`));
  }
  back.push(field('theaterAddress', 'Theater', `${METREON.name}${aud ? ', Auditorium ' + aud : ''}\n${METREON.address}`, { dataDetectorTypes: ['PKDataDetectorTypeAddress'] }));
  const later = (ctx.upcoming || []).slice(0, 5).map((u) => `${u.showtime.title || 'Movie'} · ${weekdayDate(u.startsAt)}, ${clock(u.startsAt)} · ${u.seatIds.slice().sort(compareSeats).join(', ')}`);
  if (later.length) back.push(field('next', 'Also coming up', later.join('\n')));
  back.push(field('about', 'About this pass', 'Always shows your next showtime and updates by itself. Keep Automatic Updates and Allow Notifications on.'));

  const ticket = {
    headerFields: [when],
    primaryFields: [field('title', 'Movie', title)],
    secondaryFields: [field('time', 'Time', clock(startsAt)), field('theater', 'Theater', (showtime.theater || '').trim() || METREON.name)],
    // Auditorium, seat, ticket: what's needed at the door, in one row.
    auxiliaryFields: [
      ...(aud ? [field('auditorium', 'Auditorium', aud)] : []),
      field('seats', s.ids.length > 1 ? 'Seats' : 'Seat', seatList),
      status
    ],
    backFields: back
  };

  // The order action while food can be ordered, and while anything's owed
  // (it's how the pay alerts say to pay).
  const showOrder = canOrder || owed > 0;
  const json = {
    ...base({ ...ctx, poster }),
    ...(poster ? { preferredStyleSchemes: ['posterEventTicket', 'eventTicket'] } : {}),
    eventTicket: ticket,
    semantics: {
      eventType: 'PKEventTypeMovie',
      eventName: title,
      eventStartDate: new Date(startsAt).toISOString(),
      eventEndDate: new Date(startsAt + RUNNING_MS).toISOString(),
      // The poster face shows the venue name but not venueRoom, and the
      // auditorium is what people need at the door: so it's in the name.
      venueName: aud ? `${METREON.name} \u00b7 Aud ${aud}` : METREON.name,
      ...(aud ? { venueRoom: `Auditorium ${aud}` } : {}),
      venuePlaceID: METREON.placeID,
      venueLocation: { latitude: METREON.latitude, longitude: METREON.longitude },
      seats: s.ids.map((id) => ({ seatNumber: id }))
    },
    // Suggested on the lock screen from 1.5 hours before until 20 minutes
    // after the start, by time only: no locations, so walking past the
    // Metreon on another day doesn't bring it up.
    relevantDate: new Date(startsAt).toISOString(),
    relevantDates: [{ startDate: new Date(startsAt - LOCK_SCREEN_LEAD_MS).toISOString(), endDate: new Date(startsAt + 20 * 60 * 1000).toISOString() }],
    // Wallet shows two. Order (concessions) while food orders are open,
    // and View Schedule always: Pay for Ticket has no button type, so the
    // second place is free.
    featuredActions: [
      ...(showOrder ? [{ identifier: 'concessions', type: 'order', url: ctx.siteUrl }] : []),
      // On the day: directions to the Metreon (Wallet's Go to Location,
      // from the Apple Maps place) instead of View Schedule.
      isToday
        ? { identifier: 'theater', type: 'place', placeIdentifier: METREON.placeID }
        : { identifier: 'showtimes', type: 'viewSchedule', url: ctx.siteUrl + '?tab=movies' }
    ]
  };
  if (order) {
    const b = order.pass.barcode;
    // No altText: like the day-of screen, the code is shown, not its digits.
    json.barcodes = [{ format: b.format || 'PKBarcodeFormatQR', message: b.message, messageEncoding: 'iso-8859-1' }];
  }
  return { poster, json };
}

module.exports = { buildPass, localDate, METREON, WEEK_REMINDER_MS, DAY_REMINDER_MS, PAY_REMINDER_MS };
