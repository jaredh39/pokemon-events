// Posts newly-listed events to a Discord webhook.
//
// The useful signal is "this event just appeared in the feed", not "registration
// opened": Registration_start exists on only ~16% of events and 87% of those open
// the same day as the event (it is the door-registration window, not an advance
// sign-up). Prereleases, by contrast, are posted about 25 days ahead -- which is
// exactly the window in which a popular one fills up.
//
// Knowing an event is new requires remembering the ones already seen, so this
// keeps a small state file. It stores guid -> event date and prunes entries once
// the event is in the past, so it cannot grow without bound.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEEN_PATH = path.join(ROOT, 'state', 'seen.json');
const DATA_PATH = path.join(ROOT, 'site', 'data.json');

// Validated categorical palette, as integers for Discord's embed colour.
const COLOR = { prerelease: 0x1baf7a, cup: 0x2a78d6, challenge: 0xeb6834, mixed: 0x2a78d6 };
const LABEL = { prerelease: 'Prerelease', cup: 'Cup', challenge: 'Challenge', league: 'League', friendly: 'Friendly' };

// Discord's limits: 25 fields per embed, 10 embeds per message, 6000 chars total.
// Staying well inside them keeps one batch to a single readable message.
const FIELDS_PER_EMBED = 10;
const EMBEDS_PER_MESSAGE = 4;

const log = (...a) => console.log(...a);

function fmtWhen(start) {
  const [date, time] = start.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  if (!time) return day;
  let [hh, mm] = time.split(':').map(Number);
  const ap = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  return `${day} · ${hh}:${String(mm).padStart(2, '0')} ${ap}`;
}

// \b treats an apostrophe as a word boundary, which yields "Chris'S Comics".
// Only capitalise a letter that does not follow a letter or an apostrophe.
function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/(^|[^a-z'])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase())
    .replace(/\b(Ca|Wa|Usa|Us|Tcg|Glc|Vgc)\b/g, (c) => c.toUpperCase());
}

// Stores enter admission freehand: "$15", "20.00", "30", "Free Entry".
function money(a) {
  const s = String(a || '').trim();
  return /^\d+(\.\d{1,2})?$/.test(s) ? `$${s}` : s;
}

function field(e) {
  const city = titleCase((e.address.split(',')[1] || '').trim());
  const bits = [];
  if (e.admission) bits.push(money(e.admission));
  if (e.format) bits.push(e.format);
  if (e.registrationSite) bits.push(`[Sign up](${e.registrationSite})`);
  else if (e.website) bits.push(`[Details](${e.website})`);
  bits.push(`[Map](https://maps.google.com/?q=${encodeURIComponent(e.address)})`);

  return {
    name: `${LABEL[e.category] ?? e.typeName} · ${fmtWhen(e.start)}`.slice(0, 256),
    value: `**${titleCase(e.venue)}**${city ? ` — ${city}` : ''}\n${bits.join(' · ')}`.slice(0, 1024),
    inline: false,
  };
}

async function post(webhook, body) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') || 2);
    log(`  rate limited, retrying in ${retry}s`);
    await new Promise((r) => setTimeout(r, retry * 1000));
    return post(webhook, body);
  }
  if (!res.ok) {
    throw new Error(`Discord returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function send(webhook, events, dashboardUrl) {
  const cats = new Set(events.map((e) => e.category));
  const color = cats.size === 1 ? COLOR[[...cats][0]] ?? COLOR.mixed : COLOR.mixed;

  // Soonest first -- the ones you need to act on fastest.
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));
  const embeds = [];
  for (let i = 0; i < sorted.length; i += FIELDS_PER_EMBED) {
    const chunk = sorted.slice(i, i + FIELDS_PER_EMBED);
    embeds.push({
      title: i === 0
        ? `${sorted.length} new event${sorted.length === 1 ? '' : 's'} near Cupertino`
        : `…continued (${i + 1}–${i + chunk.length})`,
      url: i === 0 ? dashboardUrl : undefined,
      color,
      fields: chunk.map(field),
      footer: i + FIELDS_PER_EMBED >= sorted.length
        ? { text: 'Play! Pokémon Event Locator · spots are not published — check the sign-up link' }
        : undefined,
      timestamp: i === 0 ? new Date().toISOString() : undefined,
    });
  }

  for (let i = 0; i < embeds.length; i += EMBEDS_PER_MESSAGE) {
    await post(webhook, {
      username: 'Play! Pokémon Watch',
      embeds: embeds.slice(i, i + EMBEDS_PER_MESSAGE),
    });
  }
}

async function main() {
  const config = JSON.parse(await readFile(path.join(ROOT, 'config.json'), 'utf8'));
  const notify = config.notify ?? {};
  if (notify.enabled === false) {
    log('Notifications disabled in config.');
    return;
  }

  const data = JSON.parse(await readFile(DATA_PATH, 'utf8'));
  const watched = data.events.filter(
    (e) => notify.metros.includes(e.metro) && notify.categories.includes(e.category),
  );

  let seen = null;
  try {
    seen = JSON.parse(await readFile(SEEN_PATH, 'utf8'));
  } catch {
    seen = null; // first run
  }

  const fresh = seen ? watched.filter((e) => !(e.guid in seen)) : [];

  // Rebuild state: everything currently watched, plus previously-seen events
  // that have not happened yet (so a temporarily-delisted event cannot re-alert).
  const next = {};
  for (const e of watched) next[e.guid] = e.date;
  for (const [guid, date] of Object.entries(seen ?? {})) {
    if (date >= data.from) next[guid] = date;
  }

  await mkdir(path.dirname(SEEN_PATH), { recursive: true });
  await writeFile(SEEN_PATH, `${JSON.stringify(next, null, 0)}\n`);

  if (!seen) {
    log(`Seeded notification state with ${watched.length} existing events (no alerts sent on first run).`);
    return;
  }

  log(`Watching ${watched.length} events; ${fresh.length} new since last run.`);
  if (!fresh.length) return;

  const webhook = process.env.DISCORD_WEBHOOK;
  if (!webhook) {
    log('DISCORD_WEBHOOK not set -- state updated, no message sent.');
    return;
  }

  await send(webhook, fresh, notify.dashboardUrl);
  log(`Posted ${fresh.length} new event(s) to Discord.`);
  for (const e of fresh) log(`  ${e.date} ${LABEL[e.category]} — ${e.venue}`);
}

const runDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (runDirectly) {
  main().catch((err) => {
    console.error(`Notify failed: ${err.message}`);
    process.exit(1);
  });
}

export { field, fmtWhen, send };
