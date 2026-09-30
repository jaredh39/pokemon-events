// Collects sanctioned Play! Pokemon TCG events from the official Event Locator.
//
// The locator (https://events.pokemon.com) is an OutSystems app sitting behind
// Imperva bot protection. Replaying its DataActionGetEventList POST directly --
// even with the right X-CSRFToken, OutSystems-locale header and session cookies --
// returns a challenge page. So we drive the real UI in Chromium and read the
// responses the app makes for itself.
//
// We deliberately keep UI interaction to a minimum (city search + Search Events)
// and do all product/type/date filtering locally against the JSON, because every
// extra click on their filter panel is another thing that can break.

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCATOR_URL = 'https://events.pokemon.com/en-us/events';
const EVENT_LIST_RE = /DataActionGetEventList/;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// The locator's own display names, mapped to the categories we filter on.
const TYPE_MAP = {
  Cup: 'cup',
  Challenge: 'challenge',
  Prerelease: 'prerelease',
  League: 'league',
  'Friendly Tournament': 'friendly',
};

// Category is only set on tournament rows; league play carries the format in
// its Attributes instead. There is no capacity/spots field anywhere in the
// payload -- that lives on the organiser's own registration page.
const FORMAT_MAP = { tcg_std: 'Standard', tcg_lim: 'Limited', tcg_glc: 'GLC' };

const log = (...a) => console.log(...a);

/* ------------------------------------------------------------------ */
/* normalisation                                                       */
/* ------------------------------------------------------------------ */

// Timestamps are inconsistent across the locator's two row shapes, and getting
// this wrong silently mis-times most of the data:
//
//   tournament   (Cup / Challenge / Prerelease / Friendly)
//                naive venue wall-clock with a FAKE Z. "18:00:00Z" means 6 PM
//                local. Parsing it as UTC shifts it to 11 AM.
//
//   play_session (all League play)
//                a GENUINE UTC instant. "2026-09-30T01:00:00Z" is 6 PM Pacific
//                on Sep 29. Stripping the Z turns league night into 1 AM.
//
// Each event's own description confirms the split: the tournament whose
// Registration_start is 17:00Z reads "registration opens at 5pm", while the
// play_session at 01:00Z reads "event will start at 6pm".
function toVenueLocal(utcIso, timeZone) {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return String(utcIso || '').replace(/Z$/, '');
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      })
        .formatToParts(d)
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, p.value]),
    );
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;
  } catch {
    // Unknown/absent IANA zone -- fall back to naive rather than dropping the row.
    return String(utcIso || '').replace(/Z$/, '');
  }
}

function localStart(raw, activityType, timeZone) {
  const s = String(raw || '');
  if (!s) return '';
  if (activityType === 'play_session' && timeZone) return toVenueLocal(s, timeZone);
  // Registration fields use an explicit "+00:00" where Start_date uses "Z";
  // both are the same fake-UTC wall clock, so strip either suffix.
  return s.replace(/(Z|\+00:00)$/, '');
}

function normalise(item, metro) {
  const e = item.Events ?? {};
  const addr = e.Address ?? {};
  const contact = e.Contact_information ?? {};
  const group = e.ActivityGroup ?? {};
  const activityType = e.Activity_type || '';
  const tz = addr.Timezone || metro.timezone;
  const start = localStart(e.Start_date, activityType, tz);
  const attributes = (e.Attributes?.List ?? []).map((a) => a?.Display_name).filter(Boolean);
  const divisions = pickDivisions(e.Activity_division_info);

  return {
    guid: e.Guid || '',
    metro: metro.id,
    category: TYPE_MAP[item.EventTypeName] ?? 'other',
    typeName: item.EventTypeName || '',
    activityType,
    // League rows carry no event name -- the venue name is the meaningful label.
    name: (e.Name || '').trim(),
    // Address.Name is the authoritative venue name and is present on every row,
    // including Challenge/Cup/Prerelease rows that render without a league name
    // in the site's own cards.
    venue: (addr.Name || '').trim(),
    address: (addr.Full_address || '').trim(),
    lat: Number(addr.Latitude) || null,
    lon: Number(addr.Longitude) || null,
    timezone: addr.Timezone || '',
    start,
    date: start.slice(0, 10),
    registrationStart: localStart(e.Registration_start, activityType, tz),
    registrationEnd: localStart(e.Registration_end, activityType, tz),
    admission: (e.Admission || '').trim(),
    products: e.Products?.List ?? [],
    website: (e.Event_website || '').trim(),
    registrationSite: (e.Third_party_registration_website || '').trim(),
    email: (contact.Email || '').trim(),
    phone: (contact.Phone || '').trim(),
    details: (e.Details || '').trim(),
    league: (group.Display_name || '').trim(),
    leagueId: (group.Display_Id || '').trim(),
    status: e.Status || '',
    // Official event id, useful for looking an event up with the organiser.
    displayId: (e.Display_id || '').trim(),
    format: FORMAT_MAP[e.Category] || (attributes.includes('Gym Leader Challenge') ? 'GLC' : ''),
    attributes,
    // Per-division pricing, only present on the rare event that sets it.
    divisionAdmission: divisions,
    venueKey: `${metro.id}|${(addr.Name || addr.Full_address || '').trim()}`,
  };
}

// Only worth carrying when a division actually differs from the flat Admission.
function pickDivisions(info) {
  const out = {};
  for (const div of ['Juniors', 'Seniors', 'Masters']) {
    const a = (info?.[div]?.Admission || '').trim();
    if (a) out[div] = a;
  }
  return Object.keys(out).length ? out : null;
}

// Contact_information is the ORGANISER's contact for one event, not the store's
// switchboard, so it is never copied onto sibling events. Instead every distinct
// value seen at a venue is aggregated here and shown as venue-level information,
// which roughly triples usable coverage without misattributing anyone.
function buildVenues(events) {
  const map = new Map();
  const add = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };

  for (const e of events) {
    let v = map.get(e.venueKey);
    if (!v) {
      v = {
        key: e.venueKey, metro: e.metro, venue: e.venue, address: e.address,
        lat: e.lat, lon: e.lon, league: e.league, leagueId: e.leagueId,
        phones: [], emails: [], websites: [], registrationSites: [],
        events: 0, byCategory: {}, nextEvent: null,
      };
      map.set(e.venueKey, v);
    }
    v.events++;
    v.byCategory[e.category] = (v.byCategory[e.category] || 0) + 1;
    if (!v.nextEvent || e.start < v.nextEvent) v.nextEvent = e.start;
    add(v.phones, e.phone);
    add(v.emails, e.email);
    add(v.websites, e.website);
    add(v.registrationSites, e.registrationSite);
  }

  return [...map.values()].sort(
    (a, b) => a.metro.localeCompare(b.metro) || b.events - a.events || a.venue.localeCompare(b.venue),
  );
}

/* ------------------------------------------------------------------ */
/* page driving                                                        */
/* ------------------------------------------------------------------ */

async function dismissCookieBanner(page) {
  // There are two "Reject All" buttons in the DOM; only one is on screen.
  const btn = page.locator('button:has-text("Reject All"):visible').first();
  try {
    await btn.waitFor({ state: 'visible', timeout: 20000 });
    await btn.click();
    log('    cookie banner: rejected non-essential');
  } catch {
    log('    cookie banner: not shown');
  }
}

// The locator opens in "Locations" mode on a fresh profile, where the search
// button reads "Search Locations" and returns stores rather than events. Flip
// the Locations/Events switch, driving it off the button's own label so this
// self-corrects whichever mode the app happens to start in.
async function ensureEventsMode(page) {
  const searchBtn = page
    .locator('button:has-text("Search Locations"):visible, button:has-text("Search Events"):visible')
    .first();
  await searchBtn.waitFor({ state: 'visible', timeout: 60000 });

  for (let attempt = 0; attempt < 3; attempt++) {
    const label = (await searchBtn.innerText()).trim();
    if (/Search Events/i.test(label)) {
      if (attempt > 0) log('    mode: switched to Events');
      return;
    }
    const toggle = page.locator('input[id$="DoubleSwitch"]').first();
    try {
      await toggle.click({ timeout: 10000 });
    } catch {
      await toggle.click({ force: true, timeout: 10000 });
    }
    await page.waitForTimeout(900);
  }
  throw new Error('Could not switch the locator out of Locations mode into Events mode.');
}

// Returns the suggestion text we actually committed to, so a run can be audited.
async function searchCity(page, query) {
  const input = page.locator('input[placeholder="Enter your city"]:visible').first();
  await input.waitFor({ state: 'visible', timeout: 45000 });
  await input.click();
  await input.fill('');
  // The Google Places widget only emits predictions for real keystrokes.
  await input.pressSequentially(query, { delay: 70 });

  const suggestion = page.locator('.pac-container .pac-item').first();
  let chosen = '';
  try {
    await suggestion.waitFor({ state: 'visible', timeout: 20000 });
    chosen = (await suggestion.innerText()).replace(/\s+/g, ' ').trim();
    await suggestion.click();
  } catch {
    throw new Error(
      `No location suggestion appeared for "${query}". Note the locator's ` +
        `autocomplete only accepts cities -- a bare ZIP code returns nothing.`,
    );
  }

  // The app only accepts a location that was committed via the dropdown --
  // typed text alone trips a "Please enter a location." validation error.
  await page.waitForTimeout(600);

  const searchBtn = page.locator('button:has-text("Search Events"):visible').first();
  await searchBtn.waitFor({ state: 'visible', timeout: 20000 });
  await searchBtn.click();

  return chosen;
}

// Results lazy-load as you scroll (the app pages at MaxRecords: 50), so keep
// scrolling until the captured set stops growing.
async function drainResults(page, captured) {
  let stableRounds = 0;
  let previous = -1;

  for (let i = 0; i < 60 && stableRounds < 5; i++) {
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(1200);
    const n = captured.size;
    if (n === previous) stableRounds++;
    else {
      stableRounds = 0;
      previous = n;
    }
  }
}

// The app prints "N Play! Pokemon event(s) found" -- a free cross-check that we
// captured everything rather than silently truncating.
async function readReportedCount(page) {
  try {
    const text = await page.locator('body').innerText();
    const m = text.match(/([\d,]+)\s+Play! Pok.mon event\(s\) found/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  } catch {
    return null;
  }
}

async function collectMetro(browser, metro) {
  log(`  ${metro.label} (${metro.query})`);

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    timezoneId: metro.timezone,
  });
  const page = await context.newPage();

  const captured = new Map();
  page.on('response', async (res) => {
    if (!EVENT_LIST_RE.test(res.url())) return;
    try {
      const json = await res.json();
      for (const item of json?.data?.EventList?.List ?? []) {
        if (item?.Events?.Guid) captured.set(item.Events.Guid, item);
      }
    } catch {
      // Non-JSON here means a bot-protection challenge page rather than data.
    }
  });

  try {
    await page.goto(LOCATOR_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await dismissCookieBanner(page);
    await ensureEventsMode(page);
    const chosen = await searchCity(page, metro.query);
    log(`    resolved to: ${chosen}`);

    // First payload can take a while; the app shows skeletons meanwhile.
    const deadline = Date.now() + 90000;
    while (captured.size === 0 && Date.now() < deadline) {
      await page.waitForTimeout(1000);
    }
    if (captured.size === 0) {
      throw new Error('No event data returned within 90s.');
    }

    await drainResults(page, captured);
    const reported = await readReportedCount(page);
    log(`    captured ${captured.size} raw rows (site reported ${reported ?? '?'})`);

    return {
      rows: [...captured.values()].map((item) => normalise(item, metro)),
      reported,
      resolvedTo: chosen,
    };
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function dateOnly(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

async function main() {
  const config = JSON.parse(await readFile(path.join(ROOT, 'config.json'), 'utf8'));

  const today = new Date();
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + config.windowDays);
  const from = dateOnly(today);
  const to = dateOnly(horizon);

  log(`Collecting ${config.product.toUpperCase()} events ${from} -> ${to}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const events = [];
  const metros = [];
  const failures = [];

  try {
    for (const metro of config.metros) {
      try {
        const { rows, reported, resolvedTo } = await collectMetro(browser, metro);

        const kept = rows.filter(
          (r) =>
            r.products.includes(config.product) &&
            r.date >= from &&
            r.date <= to &&
            r.guid,
        );

        events.push(...kept);
        metros.push({
          ...metro,
          resolvedTo,
          reportedTotal: reported,
          rawRows: rows.length,
          events: kept.length,
        });
        log(`    kept ${kept.length} ${config.product} events in window`);
      } catch (err) {
        log(`    FAILED: ${err.message}`);
        failures.push({ metro: metro.id, error: err.message });
        metros.push({ ...metro, resolvedTo: null, reportedTotal: null, rawRows: 0, events: 0, error: err.message });
      }
    }
  } finally {
    await browser.close();
  }

  // A run that collected nothing anywhere should fail loudly rather than
  // overwrite a good snapshot with an empty one.
  if (events.length === 0) {
    throw new Error(
      `Collected 0 events across all metros. Refusing to write an empty snapshot. ` +
        failures.map((f) => `${f.metro}: ${f.error}`).join('; '),
    );
  }

  events.sort((a, b) => a.start.localeCompare(b.start) || a.venue.localeCompare(b.venue));

  const payload = {
    generatedAt: new Date().toISOString(),
    product: config.product,
    radiusMiles: config.radiusMiles,
    windowDays: config.windowDays,
    from,
    to,
    defaultTypes: config.defaultTypes,
    metros,
    failures,
    venues: buildVenues(events),
    events,
  };

  const outDir = path.join(ROOT, 'site');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'data.json'), JSON.stringify(payload, null, 1));

  log(`\nWrote site/data.json -- ${events.length} events across ${metros.length} metros`);
  if (failures.length) {
    log(`WARNING: ${failures.length} metro(s) failed; snapshot is partial.`);
    process.exitCode = 1;
  }
}

// Only scrape when run directly, so the timestamp helpers can be imported and
// tested without launching a browser.
const runDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (runDirectly) {
  main().catch((err) => {
    console.error(`\nCollection failed: ${err.message}`);
    process.exit(1);
  });
}

export { localStart, toVenueLocal, normalise, buildVenues, pickDivisions, TYPE_MAP };
