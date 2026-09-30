# Play! Pokémon TCG event dashboard

A self-refreshing snapshot of **sanctioned Pokémon TCG events** within 25 miles of
two metros, covering the next 60 days:

- **Bay Area** — centred on Cupertino, CA
- **Seattle** — centred on Seattle, WA

GitHub Actions re-collects the data every 6 hours and redeploys the dashboard to
GitHub Pages. There is no server to run and nothing to keep awake.

## How it works

| Piece | What it does |
|---|---|
| `scripts/collect.mjs` | Drives the official Event Locator in headless Chromium and captures the JSON the app fetches for itself. Writes `site/data.json`. |
| `site/index.html` | Static dashboard. Fetches `data.json`, filters client-side. No build step. |
| `.github/workflows/refresh.yml` | Runs the collector on a 6-hour cron, then publishes `site/` to Pages. |
| `config.json` | Metros, radius, look-ahead window, default event types. |

## Why it drives a browser instead of calling the API

The locator is an OutSystems app, and its data call is a plain JSON POST:

```
POST /EventLocator/screenservices/EventLocator/MainFlow/Home/DataActionGetEventList
```

That looks trivially scriptable, and it isn't. The site sits behind Imperva bot
protection. Replaying that exact request — correct `X-CSRFToken`, correct
`OutSystems-locale`, live session cookies, issued from the page's own origin via
both `fetch` and `XMLHttpRequest` — returns an HTML challenge page ("Pardon Our
Interruption") while the app's own identical request succeeds.

So the collector drives the real UI and reads the responses the app makes. It is
slower (~30s per metro) and completely reliable.

## Deliberate design choices

**Minimal UI interaction.** The collector only picks a city and clicks Search.
Product, event-type and date filtering all happen locally against the JSON. Every
click on their filter panel is another selector that can break, and filtering in
JavaScript cannot.

**Timestamps follow two different rules, and the `Z` is only sometimes real.**
This is the single easiest thing to get wrong here:

| Row shape | Format | Example |
|---|---|---|
| `tournament` (Cup, Challenge, Prerelease, Friendly) | naive venue wall-clock with a **fake** `Z` | `18:00:00Z` means 6 PM local |
| `play_session` (all League play) | a **genuine** UTC instant | `2026-09-30T01:00:00Z` is 6 PM Pacific on Sep 29 |

Apply either rule to both and the output looks plausible while being wrong:
treating everything as naive puts league night at 1:00 AM; treating everything
as UTC moves tournaments to 11:00 AM. The collector branches on `Activity_type`
and converts `play_session` rows into venue-local time using the venue's own
IANA `Address.Timezone`. Each event's description text confirms the split —
the tournament whose `Registration_start` is `17:00Z` reads "registration opens
at 5pm", while the play_session at `01:00Z` reads "event will start at 6pm".

**Venue names come from `Address.Name`.** The site's own rendered cards only print
a league name on `League` rows, so venues that host nothing but Cups, Challenges
and Prereleases appear unnamed. The underlying JSON names every one of them.

**A ZIP code cannot be searched.** The locator's autocomplete is restricted to
cities, so `98109` produces no suggestion and cannot be committed. Seattle is
searched as a city; its centroid is ~2 miles from 98109, which is immaterial
against a 25-mile radius.

**There is no capacity or "spots remaining" field.** The full per-event key set
is `Guid, Activity_type, Subtype, Name, Display_id, Products, Category,
Start_date, Address, Event_website, Registration_start, Registration_end,
Details, Third_party_registration_website, Contact_information, Admission,
Activity_division_info, Series, Status, Attributes, ActivityGroup` — nothing
capacity-shaped anywhere, and the Locations endpoint returns even less
(`Display_name`, `Address`, `Has_qualifying_activities`). Roughly 10% of events
mention limits in free-text `Details`. Live spot counts only exist on the
organiser's own registration page, so the dashboard surfaces
`Third_party_registration_website` as a prominent **Sign up** link.

**Contacts are aggregated per venue, not copied between events.**
`Contact_information` is the *organiser's* contact for one event, so propagating
it across a venue's other events would misattribute people. Instead
`buildVenues()` collects every distinct phone, email and site seen at a venue and
the Stores view presents them as venue-level information. That lifts usable
contact coverage from 19% of events to 49% without asserting anything false.

**An empty run is a failure, not a snapshot.** If the collector gets zero events
it throws instead of writing an empty `data.json`, so a broken selector can never
silently replace good data with an empty dashboard. The previous deploy stays up
and the dashboard's own freshness banner flags it.

## Discord notifications

`scripts/notify.mjs` posts newly-listed events to a Discord webhook after each
collection. Configured in `config.json` under `notify` — currently Bay Area
Prereleases, Cups and Challenges.

**Why "newly listed" and not "registration opened":** `Registration_start` is
present on only 95 of 580 events, and 83 of those open *the same day as the
event* — it is the door-registration window, not an advance sign-up. Prereleases,
by contrast, appear in the feed about 25 days ahead, which is the window in which
a popular one fills. So the alert fires when an event first appears.

**This is the one piece that keeps state.** Knowing an event is new requires
remembering what was already seen, so `state/seen.json` maps event guid → date
and is committed by CI each run. Entries are pruned once the event is in the
past, so it cannot grow without bound (currently ~2 KB). Two deliberate details:

- **The first run seeds silently.** Without this it would fire ~44 alerts at once.
- **State is written after the post succeeds**, so a failed Discord call cannot
  mark events as seen and swallow them permanently.

Pushes made with `GITHUB_TOKEN` do not re-trigger workflows, so the state commit
cannot loop. A useful side effect: those commits keep the repo active, which
prevents GitHub from auto-disabling the schedule after 60 days of inactivity.

### Setting it up

1. In Discord: create a server (or use one you own) → a channel → **Edit Channel
   → Integrations → Webhooks → New Webhook** → *Copy Webhook URL*.
2. Store it as a repo secret — run this yourself so the URL never passes through
   a chat log:
   ```bash
   gh secret set DISCORD_WEBHOOK --repo jaredh39/pokemon-events
   ```
3. On the Discord mobile app, set that channel's notifications to **All Messages**.

Anyone holding the webhook URL can post to that channel, so keep it in the secret
and out of the repo. To pause alerts, set `notify.enabled` to `false` in
`config.json`; the collector and dashboard are unaffected.

## Local development

```bash
npm install
npx playwright install chromium
npm run collect     # writes site/data.json
npm run serve       # preview at http://localhost:4173
```

`site/data.json` is generated and git-ignored; CI builds it fresh on every run.

## Maintenance notes

- **Scheduled workflows are disabled after 60 days of repo inactivity.** GitHub
  emails first. Any push re-enables them.
- **If a run starts failing**, it is almost certainly a selector in
  `collect.mjs`. The likely suspects are the cookie banner, the
  Locations/Events switch (`input[id$="DoubleSwitch"]`), and the Google Places
  dropdown (`.pac-container .pac-item`).
- **The dashboard shows its own age.** Amber past 26 hours, red past 72. If it
  goes amber, check the Actions tab before trusting what is on screen.

## Data

Sourced from the official [Play! Pokémon Event Locator](https://events.pokemon.com/en-us/events).
Event listings belong to The Pokémon Company International. Always confirm with
the store before travelling — organisers change and cancel events.
