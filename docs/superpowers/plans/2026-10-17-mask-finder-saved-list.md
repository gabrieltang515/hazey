# Mask Finder Saved-List Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live HazeMaskGoWhere fetch with a saved list of mask collection points that is generated from an ordinary connection, plus an on/off switch, so the mask finder works even though HazeMaskGoWhere blocks Cloudflare.

**Architecture:** `scripts/build-mask-sites.js` fetches and normalizes HazeMaskGoWhere's two files and writes `public/mask-sites.js`. The dashboard, `/masks` and the channel all read that file. `MASK_DISTRIBUTION: "on"` in `wrangler.jsonc` vars turns the feature on; `/api/psi` reports it to the browser as `masksActive`. The live-fetch code, `/api/masks` and all stock/staleness logic are removed, and migration `0006` drops the unused `mask_sources` table.

**Tech Stack:** Cloudflare Workers (plain ESM), D1, buildless HTML/CSS/JS, `node --test` with `node:sqlite`, Chrome DevTools browser check.

**Spec:** `docs/superpowers/specs/2026-10-17-mask-finder-design.md`, section "Revision, 17 October 2026: saved list instead of live stock".

## Global Constraints

- **Cloudflare Free only.** Use the existing Worker `hazey` and D1 binding `PSI_DB`. No new resources, paid services or secrets.
- **Code style:** plain ESM, buildless browser code, no new dependencies. Match the surrounding code: terse comments, `Object.assign(document.createElement(...))` DOM building, curly quotes (’) in user-facing copy.
- **Times:** display in Asia/Singapore with `singaporeTime` from `public/psi.js`.
- **Logs:** never log tokens, locations or postal codes.
- **CSP:** `public/_headers` stays unchanged.
- **No stock:** Hazey must never show or claim stock. Every list points to HazeMaskGoWhere (`https://www.gowhere.gov.sg/hazemask`, short form `go.gov.sg/hazemask`) for live stock.
- **Switch:** distribution is on only when `env.MASK_DISTRIBUTION === "on"`.
- **Unchanged behaviour:**
  - `/shelter` wording
  - the 10-minute pending location request after plain `/masks`
  - the `/mask` alias
  - one search filling both lists
  - the eligibility box
  - existing element IDs
- **Running commands:** `npm test` from the repository root. Node 22 and npx are on PATH.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `scripts/mask-data.js` | move from `src/mask-data.js`, trim | HazeMaskGoWhere sources, User-Agent, normalization (no stock) |
| `scripts/build-mask-sites.js` | create | Generates `public/mask-sites.js` |
| `public/mask-sites.js` | generated | `MASK_SITES`, `MASK_SITES_AS_AT` |
| `public/masks.js` | modify | Shared labels, URLs, `maskPlaces`, `maskCounts`; stock helpers removed in Task 2 |
| `src/masks.js` | rewrite | `/masks` reply from the saved list; `maskDistribution(env)` |
| `src/worker.js` | modify | `/api/psi` gains `masksActive`; `/api/masks` and the scheduled mask refresh removed |
| `src/broadcast.js` | modify | Channel mask block from the saved list while on |
| `migrations/0006_drop_mask_sources.sql` | create | Drops `mask_sources` |
| `wrangler.jsonc` | modify | `MASK_DISTRIBUTION: "on"` |
| `public/index.html`, `public/app.js`, `public/styles.css`, `scripts/check-browser.js` | modify | Dashboard reads the saved list; section and hero link follow `masksActive` |
| `tests/masks.test.js`, `tests/worker.test.js` | modify | Tests for the above |

---

### Task 1: Saved mask list for the Worker, bot and channel

**Files:**
- Move and modify: `src/mask-data.js` → `scripts/mask-data.js`
- Create: `scripts/build-mask-sites.js`, `migrations/0006_drop_mask_sources.sql`
- Generate: `public/mask-sites.js`
- Modify: `public/masks.js`, `src/masks.js`, `src/worker.js`, `src/broadcast.js`, `wrangler.jsonc`, `tests/masks.test.js`, `tests/worker.test.js`

**Interfaces:**
- Produces:
  - `scripts/mask-data.js` exports `MASK_SOURCES`, `USER_AGENT` and `normalizeMaskSites(body, source) → { sites, dropped }`. Each site is `{ name, kind, address, postal, lat, lng, hours, spot }`, with no `stock`.
  - `public/mask-sites.js` exports `MASK_SITES` (array of sites) and `MASK_SITES_AS_AT` (ISO string).
  - `public/masks.js` gains `maskCounts(sites) → { cc, vending }`.
  - `src/masks.js` exports `maskDistribution(env) → boolean`, `masksReply({ origin, label, appUrl })` and `masksCommand({ location, argument, isPrivate, active, appUrl })`.
  - `channelMessage(snapshot, kind, { appUrl, botUsername, masks }, now)`, where `masks` is `{ cc, vending }` counts or `null`.
  - `/api/psi` JSON gains `masksActive: boolean`.
- Removed: `refreshMasks`, `loadMasks`, `saveMaskSource`, `MASK_STALE_AFTER` use in the Worker, and `GET /api/masks` (now 404 through the existing `/api/` fallback).

- [ ] **Step 1: Move and trim the normalization module**

Run `git mv src/mask-data.js scripts/mask-data.js`, then replace the whole file with:

```js
// Free N95 mask collection points from HazeMaskGoWhere (https://www.gowhere.gov.sg/hazemask): the two JSON files the
// official page loads. Used by scripts/build-mask-sites.js. The Worker can't fetch them itself: HazeMaskGoWhere's CDN
// answers requests from Cloudflare's network with HTTP 403.
import { inSingapore } from "../src/postal.js";

export const MASK_SOURCES = {
  cc: "https://www.gowhere.gov.sg/hazemask/data/data.csv.json",
  vending: "https://www.gowhere.gov.sg/hazemask/data/data.webhook.json"
};
// The CDN also refuses requests without a User-Agent.
export const USER_AGENT = "Hazey/1.0 (+https://hazey.gabrieltang515.workers.dev)";

// Capped so a runaway upstream string can't push a Telegram reply past its 4096-character limit.
const text = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 200) : "";
// The option names flagged true in one of an entry's filter categories.
function flagged(entry, category) {
  const filter = Array.isArray(entry.filters) ? entry.filters.find(item => item?.category === category) : null;
  return Array.isArray(filter?.options) ? filter.options.filter(option => option?.flag === true).map(option => option.name) : [];
}

// Stock isn't kept: it changes through the day, so Hazey links HazeMaskGoWhere for it.
function maskSite(entry, source) {
  if (!entry || typeof entry !== "object") return null;
  const name = text(entry.name), address = text(entry.address);
  const lat = Number(entry.LAT), lng = Number(entry.LON);
  if (!name || !address || !inSingapore(lat, lng)) return null;
  const option = flagged(entry, "collectionOption");
  const postal = text(String(entry.postalCode ?? ""));
  return {
    name, kind: option.includes("vendingMachine") ? "vending" : option.includes("ccCounter") ? "cc" : source,
    address, postal: /^\d{6}$/.test(postal) ? postal : null, lat, lng,
    hours: text(entry.operatingHoursFreeText) || null, spot: text(entry.description) || null
  };
}

// `body` is one HazeMaskGoWhere file, { lastUpdated, data: [...] }; `source` is "cc" or "vending".
export function normalizeMaskSites(body, source) {
  if (!Array.isArray(body?.data)) throw new Error("Unexpected HazeMaskGoWhere format");
  const sites = body.data.map(entry => maskSite(entry, source)).filter(Boolean);
  if (body.data.length > 0 && sites.length === 0) throw new Error(`No valid HazeMaskGoWhere entries (0 of ${body.data.length})`);
  return { sites, dropped: body.data.length - sites.length };
}
```

- [ ] **Step 2: Create the generator and generate the list**

Create `scripts/build-mask-sites.js`:

```js
// Regenerates public/mask-sites.js from HazeMaskGoWhere's collection-point files. Usage: node scripts/build-mask-sites.js
// Run it from an ordinary connection (HazeMaskGoWhere refuses Cloudflare's network), check the counts it prints, then run
// the tests and redeploy. Rerun it when HazeMaskGoWhere adds, moves or removes collection points.
import { writeFile } from "node:fs/promises";
import { MASK_SOURCES, USER_AGENT, normalizeMaskSites } from "./mask-data.js";

const OUTPUT = new URL("../public/mask-sites.js", import.meta.url);

const sites = [];
for (const [source, url] of Object.entries(MASK_SOURCES)) {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HazeMaskGoWhere ${source} request failed (${response.status})`);
  const { sites: found, dropped } = normalizeMaskSites(await response.json(), source);
  console.log(`${source}: ${found.length} points${dropped ? `, ${dropped} invalid entries dropped` : ""}`);
  sites.push(...found);
}
if (!sites.length) throw new Error("HazeMaskGoWhere lists no collection points; public/mask-sites.js was not changed");
const asAt = new Date().toISOString();
await writeFile(OUTPUT, [
  "// Free N95 mask collection points for Hazey. Generated by scripts/build-mask-sites.js from HazeMaskGoWhere",
  "// (https://www.gowhere.gov.sg/hazemask), Government of Singapore; rerun it rather than hand-editing this file.",
  "// Stock isn't kept: it changes through the day, so Hazey links HazeMaskGoWhere for live stock.",
  `export const MASK_SITES_AS_AT = ${JSON.stringify(asAt)};`,
  "export const MASK_SITES = [",
  sites.map(site => `  ${JSON.stringify(site)}`).join(",\n"),
  "];",
  ""
].join("\n"));
console.log(`Wrote ${sites.length} points to public/mask-sites.js, as at ${asAt}`);
```

Run: `node scripts/build-mask-sites.js`
Expected: `cc: 113 points`, `vending: 37 points` (counts may differ slightly if HazeMaskGoWhere has changed), then `Wrote 150 points …`. If either request fails, stop and report.

- [ ] **Step 3: Add `maskCounts` to `public/masks.js`**

Append to `public/masks.js` (leave the existing exports alone; Task 2 removes the stock helpers):

```js

// { cc, vending } counts of a list of sites.
export function maskCounts(sites) {
  const counts = { cc: 0, vending: 0 };
  for (const site of sites) counts[site.kind]++;
  return counts;
}
```

- [ ] **Step 4: Update `tests/masks.test.js` (normalization without stock, list integrity)**

Change the imports at the top to:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMaskSites } from "../scripts/mask-data.js";
import { MASK_SITES, MASK_SITES_AS_AT } from "../public/mask-sites.js";
import { MASK_KINDS, MASK_STOCK, collectable, maskCounts, maskPlaces, stockUpdatedAt } from "../public/masks.js";
import { ccFile, maskEntry, vendingFile } from "./mask-fixtures.js";
```

Replace the first two tests (`"HazeMaskGoWhere entries normalize…"` and `"out of service beats stock flags…"`) with:

```js
test("HazeMaskGoWhere entries normalize to sites with kind, hours and spot, without stock; invalid entries are dropped", () => {
  const cc = normalizeMaskSites(ccFile(), "cc");
  assert.equal(cc.dropped, 2);
  assert.deepEqual(cc.sites.map(site => site.name), ["Ci Yuan CC", "Punggol CC", "Buangkok CC", "Hougang CC", "Tanjong Pagar CC"]);
  assert.deepEqual(cc.sites[0], { name: "Ci Yuan CC", kind: "cc", address: "51 Hougang Ave 9 #01-01", postal: "538776",
    lat: 1.375322537735674, lng: 103.8829319300397, hours: "Monday to Sunday, 10am to 6pm", spot: null });
  assert.equal(cc.sites[4].postal, "089774", "leading zeros survive");
  const vending = normalizeMaskSites(vendingFile(), "vending");
  assert.equal(vending.dropped, 0);
  assert.deepEqual(vending.sites.map(site => [site.kind, site.spot, site.hours]), [
    ["vending", "Near lift lobby B", "Daily, 24 hours"],
    ["vending", "Near Boarding Berth 1", "Daily, 24 hours"]
  ]);
  assert.equal("contactNumber" in vending.sites[0], false, "contact numbers are not kept");
  assert.equal("stock" in vending.sites[0], false, "stock is not kept");
  assert.equal(normalizeMaskSites({ data: [maskEntry({ name: "x".repeat(500), lat: 1.3, lng: 103.8 })] }, "cc").sites[0].name.length, 200, "long upstream text is capped");
});

test("the file decides an unflagged kind; postal codes and hours fall back to null", () => {
  const [machine] = normalizeMaskSites({ data: [maskEntry({ name: "Machine", lat: 1.3, lng: 103.8, option: null })] }, "vending").sites;
  assert.equal(machine.kind, "vending");
  const [site] = normalizeMaskSites({ data: [maskEntry({ name: "Counter", lat: "1.3", lng: "103.8", postalCode: "12345", hours: "  " })] }, "cc").sites;
  assert.deepEqual([site.kind, site.postal, site.hours, site.lat], ["cc", null, null, 1.3]);
});
```

In the `"shared mask helpers…"` test, add this line after the `maskPlaces({ cc: 1, vending: 0 })` assertion:

```js
  assert.deepEqual(maskCounts([{ kind: "cc" }, { kind: "vending" }, { kind: "cc" }]), { cc: 2, vending: 1 });
```

Append:

```js
test("the saved mask list has valid points of both kinds, without stock, and a generation time", () => {
  assert.ok(MASK_SITES.length >= 100, `only ${MASK_SITES.length} points`);
  assert.ok(Number.isFinite(Date.parse(MASK_SITES_AS_AT)));
  const counts = maskCounts(MASK_SITES);
  assert.ok(counts.cc > 0 && counts.vending > 0);
  assert.equal(counts.cc + counts.vending, MASK_SITES.length, "every point is a CC counter or a vending machine");
  for (const site of MASK_SITES) {
    assert.deepEqual(Object.keys(site).sort(), ["address", "hours", "kind", "lat", "lng", "name", "postal", "spot"], site.name);
    assert.ok(site.name && site.address, site.name);
    assert.ok(site.postal === null || /^\d{6}$/.test(site.postal), site.name);
    assert.ok(site.lat > 1.15 && site.lat < 1.48 && site.lng > 103.59 && site.lng < 104.1, site.name);
  }
});
```

- [ ] **Step 5: Update `tests/worker.test.js` (write the failing tests)**

1. Replace these two import lines:

```js
import { MASK_SOURCES, loadMasks, normalizeMaskSites, refreshMasks, saveMaskSource } from "../src/mask-data.js";
import { ccFile, vendingFile } from "./mask-fixtures.js";
```

with:

```js
import { MASK_SITES } from "../public/mask-sites.js";
import { maskCounts, maskPlaces } from "../public/masks.js";
import { formatDistance, nearest } from "../public/geo.js";
```

2. Replace the block starting `// Scheduled runs also fetch HazeMaskGoWhere; by default it lists nothing.` through the `const nea = …` line with:

```js
const nea = url => Response.json(url === PM25_API_URL ? pm25Fixture() : fixture());
```

3. In `channelHarness`, delete this branch:

```js
    if (maskSource(url)) {
      if (options.masksDown) return new Response("unavailable", { status: 503 });
      return Response.json(options.masks?.[maskSource(url)] ?? EMPTY_MASKS);
    }
```

4. Delete these tests and the helper entirely:
   - `"mask refreshes save each HazeMaskGoWhere file on its own and never replace a newer saved copy"`
   - `"/api/masks serves the saved points, marks a source stale after 30 minutes and says when distribution is running"`
   - `"scheduled runs refresh mask points alongside PSI, and neither outage blocks the other"`
   - `async function seedMasks(…)` and its comment line
   - `"/masks with a postal code replies with the three nearest mask points with stock, eligibility and the stock time"`
   - `"/masks without saved data links HazeMaskGoWhere; stale stock is flagged; empty and out-of-stock lists say so"`
   - `"channel posts point to free N95 masks while distribution is running, at any PSI level, and stop when the list goes stale"`

5. In `"plain /masks offers the location button…"`, replace `await seedMasks(env);` with `env.MASK_DISTRIBUTION = "on";`, and replace:

```js
  assert.match(replies[1].text, /^Nearest free N95 mask points to your location\n\n1\. Ci Yuan CC — 600 m\n/);
```

with:

```js
  assert.ok(replies[1].text.startsWith(`Nearest free N95 mask points to your location\n\n1. ${nearest({ lat: 1.37827, lng: 103.88749 }, MASK_SITES, 1)[0].name} — `));
```

6. In `"a failed /shelter postal lookup that offers the location button cancels a pending /masks request"`, replace `await seedMasks(env);` with `env.MASK_DISTRIBUTION = "on";`.

7. In `"scheduled runs prune expired /masks location requests"`, replace its fetch mock line with:

```js
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(!url.includes("gowhere.gov.sg"), "the Worker never fetches HazeMaskGoWhere");
    return url.includes("?date=") ? Response.json({ code: 0, data: { items: [] } }) : nea(url);
  });
```

8. Append these tests:

```js
test("/masks with a postal code replies with the three nearest saved mask points, eligibility and where the list comes from", async t => {
  const { env, ctx } = setup(t);
  env.PUBLIC_APP_URL = "https://hazey.example";
  env.MASK_DISTRIBUTION = "on";
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.startsWith(ONEMAP_SEARCH_URL)) return Response.json({ results: [{ POSTAL: "530572", LATITUDE: "1.378270724882904", LONGITUDE: "103.8874850986399" }] });
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  const expected = nearest({ lat: 1.378270724882904, lng: 103.8874850986399 }, MASK_SITES, 3);
  assert.equal((await worker.fetch(webhook(70, "/masks 530572"), env, ctx)).status, 200);
  const [reply] = replies;
  const [first] = expected;
  assert.ok(reply.text.startsWith(`Nearest free N95 mask points to postal code 530572\n\n1. ${first.name} — ${formatDistance(first.km)}\n${first.kind === "cc" ? "CC counter" : "Vending machine"}\n`));
  assert.deepEqual(reply.text.match(/^\d\. .+(?= — )/gm), expected.map((site, i) => `${i + 1}. ${site.name}`));
  assert.doesNotMatch(reply.text, /In stock|Limited stock|Out of stock/, "no stock is claimed");
  assert.match(reply.text, /Pregnant women, children aged 7 to 16/);
  assert.match(reply.text, /\nLocations from HazeMaskGoWhere as at .+ SGT\. Stock changes through the day; check live stock before you go: go\.gov\.sg\/hazemask$/);
  const rows = reply.reply_markup.inline_keyboard;
  assert.equal(rows.length, 4);
  assert.equal(rows[0][0].text, `Directions: ${first.name}`);
  assert.equal(rows[3][0].url, "https://hazey.example/#masks");
  await worker.fetch(webhook(71, "/mask 530572"), env, ctx);
  assert.equal(replies[1].text, reply.text, "/mask is an alias");
});

test("with mask distribution off, /masks says so, links HazeMaskGoWhere and offers no location button", async t => {
  const { db, env, ctx } = setup(t);
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(!url.startsWith(ONEMAP_SEARCH_URL), "no postal lookup while off");
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  await worker.fetch(webhook(95, "/masks 530572"), env, ctx);
  assert.equal(replies[0].text, "Free N95 mask distribution isn’t running right now. HazeMaskGoWhere has the latest: https://www.gowhere.gov.sg/hazemask");
  assert.deepEqual(replies[0].reply_markup.inline_keyboard, [[{ text: "Open HazeMaskGoWhere ↗", url: "https://www.gowhere.gov.sg/hazemask" }]]);
  await worker.fetch(webhook(96, "/masks"), env, ctx);
  assert.equal(replies[1].reply_markup.keyboard, undefined);
  assert.equal(db.prepare("SELECT count(*) AS n FROM bot_location_requests").get().n, 0);
});

test("/api/psi tells the dashboard whether free mask distribution is on, and the live mask API is gone", async t => {
  const { env, ctx } = setup(t);
  t.mock.method(globalThis, "fetch", async url => nea(url));
  const psi = async () => (await worker.fetch(new Request("https://hazey.example/api/psi"), env, ctx)).json();
  assert.equal((await psi()).masksActive, false);
  env.MASK_DISTRIBUTION = "on";
  assert.equal((await psi()).masksActive, true);
  assert.equal((await worker.fetch(new Request("https://hazey.example/api/masks"), env, ctx)).status, 404);
});

test("channel posts point to free N95 masks while distribution is on, at any PSI level, and not when it is off", async t => {
  const { tick, env, messages } = channelHarness(t);
  env.MASK_DISTRIBUTION = "on";
  await tick("2026-10-14T06:00:00+08:00", 150);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].text.includes(`\n\nFree N95 masks:\nEligible groups can collect free N95 masks at ${maskPlaces(maskCounts(MASK_SITES))}.\nFind one: https://hazey.example/#masks or send /masks to @hazey_psi_bot\nLive stock: go.gov.sg/hazemask\n\nMOH guidance`));
  assert.deepEqual(messages[0].reply_markup.inline_keyboard.map(row => row[0].url), ["https://hazey.example", "https://hazey.example/#masks"]);
  await tick("2026-10-14T06:20:00+08:00", 220);
  assert.match(messages[1].text, /Haze shelters:[\s\S]*Free N95 masks:/);
  assert.deepEqual(messages[1].reply_markup.inline_keyboard.map(row => row[0].url), ["https://hazey.example", "https://hazey.example/#shelters", "https://hazey.example/#masks"]);
  delete env.MASK_DISTRIBUTION;
  await tick("2026-10-14T07:00:00+08:00", 220);
  assert.equal(messages.length, 3);
  assert.doesNotMatch(messages[2].text, /Free N95 masks/);
  assert.equal(messages[2].reply_markup.inline_keyboard.length, 2);
});
```

Run: `npm test`
Expected: FAIL. The new and changed `/masks`, `/api/psi` and channel tests fail (the code still uses the live list), and Worker tests may fail to import because `src/mask-data.js` has moved. Note the failures.

- [ ] **Step 6: Rewrite `src/masks.js`**

Replace the whole file with:

```js
// /masks for the Telegram bot: the nearest free N95 mask points from the saved HazeMaskGoWhere list, with a link for live
// stock. Locations and postal codes are used for this reply only: never stored, and never written to logs.
import { MASK_SITES, MASK_SITES_AS_AT } from "../public/mask-sites.js";
import { MASK_FINDER_URL, MASK_KINDS, MASK_SHORT_URL } from "../public/masks.js";
import { directionsUrl, formatDistance, nearest } from "../public/geo.js";
import { singaporeTime } from "../public/psi.js";
import { nearbyCommand } from "./nearby.js";

const COUNT = 3;
// NEA haze situation update, 14 October 2026.
const ELIGIBILITY = "Who can collect: Pioneer and Merdeka Generation, CHAS Blue and Orange cardholders, Medical Fee Exemption Card holders and ComCare recipients at a CC or vending machine. Pregnant women, children aged 7 to 16 and people with conditions such as asthma at CCs only. Bring the eligible person’s NRIC.";
const OFFICIAL_BUTTON = [{ text: "Open HazeMaskGoWhere ↗", url: MASK_FINDER_URL }];

// Free mask distribution is on while wrangler.jsonc vars set MASK_DISTRIBUTION to "on"; remove it when distribution ends.
export const maskDistribution = env => env.MASK_DISTRIBUTION === "on";

export function masksReply({ origin, label, appUrl }) {
  const closest = nearest(origin, MASK_SITES, COUNT);
  const text = [
    closest[0].km > 30
      ? `The nearest free N95 mask point is ${formatDistance(closest[0].km)} from ${label}. These points are in Singapore only.`
      : `Nearest free N95 mask points to ${label}`,
    "",
    ...closest.flatMap((site, i) => [
      `${i + 1}. ${site.name} — ${formatDistance(site.km)}`,
      MASK_KINDS[site.kind],
      site.postal ? `${site.address}, Singapore ${site.postal}` : site.address,
      ...[site.spot, site.hours].filter(Boolean),
      ""
    ]),
    ELIGIBILITY,
    `Locations from HazeMaskGoWhere as at ${singaporeTime(MASK_SITES_AS_AT)} SGT. Stock changes through the day; check live stock before you go: ${MASK_SHORT_URL}`
  ].join("\n");
  const rows = closest.map(site => [{ text: `Directions: ${site.name}`, url: directionsUrl(site) }]);
  if (appUrl) rows.push([{ text: "Open the mask finder ↗", url: new URL("#masks", appUrl).href }]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

// Resolves to { text, reply_markup? } for /masks, or for a location shared after plain /masks.
export async function masksCommand({ location, argument, isPrivate, active, appUrl }) {
  if (!active) {
    return { text: `Free N95 mask distribution isn’t running right now. HazeMaskGoWhere has the latest: ${MASK_FINDER_URL}`,
      reply_markup: { inline_keyboard: [OFFICIAL_BUTTON] } };
  }
  return nearbyCommand({ command: "masks", things: "free N95 mask points", short: "mask points", count: COUNT, location, argument, isPrivate,
    reply: (origin, label) => masksReply({ origin, label, appUrl }) });
}
```

- [ ] **Step 7: Update `src/worker.js`**

- Replace `import { masksCommand } from "./masks.js";` with `import { maskDistribution, masksCommand } from "./masks.js";`, and delete the line `import { loadMasks, refreshMasks } from "./mask-data.js";`.
- Replace:

```js
    } else if (command === "masks") {
      // The saved HazeMaskGoWhere list; replies never wait for a refresh.
      const masks = await loadMasks(env).catch(() => null);
      reply = await masksCommand({ location, argument, isPrivate, masks, appUrl });
    }
```

  with:

```js
    } else if (command === "masks") {
      reply = await masksCommand({ location, argument, isPrivate, active: maskDistribution(env), appUrl });
    }
```

- In `/api/psi`, replace `botUsername: botReady ? botUsername : null });` with `botUsername: botReady ? botUsername : null, masksActive: maskDistribution(env) });`.
- Delete the whole `/api/masks` block (4 lines, from `if (path === "/api/masks") {` to its closing `}`).
- In `scheduled`, delete these two lines:

```js
    // Mask points refresh on their own: neither a mask nor a PSI outage blocks the other.
    ctx.waitUntil(refreshMasks(env).catch(error => console.error("Mask site refresh failed:", error.message)));
```

- [ ] **Step 8: Update `src/broadcast.js`**

Replace the two mask import lines:

```js
import { MASK_SHORT_URL, maskPlaces } from "../public/masks.js";
```

and

```js
import { loadMasks } from "./mask-data.js";
```

with:

```js
import { MASK_SHORT_URL, maskCounts, maskPlaces } from "../public/masks.js";
import { MASK_SITES } from "../public/mask-sites.js";
import { maskDistribution } from "./masks.js";
```

(keep `import { isStale } from "./psi.js";` and `import { telegramApi } from "./telegram.js";`).

Replace the comment and signature:

```js
// Above 200 (NEA's trigger for opening haze shelters) the post also points to the shelter finder. While free N95
// masks are being given out (`masks.active`, from loadMasks), it points to the mask finder at any PSI level.
export function channelMessage(snapshot, kind, { appUrl = null, botUsername = null, masks = null } = {}, now = Date.now()) {
```

with:

```js
// Above 200 (NEA's trigger for opening haze shelters) the post also points to the shelter finder. While free N95
// masks are being given out (`masks`: { cc, vending } counts of the saved list), it points to the mask finder at any PSI level.
export function channelMessage(snapshot, kind, { appUrl = null, botUsername = null, masks = null } = {}, now = Date.now()) {
```

Replace:

```js
  if (masks?.active) {
    const find = [appUrl && new URL("#masks", appUrl).href, botUsername && `send /masks to @${botUsername}`].filter(Boolean);
    lines.push("", "Free N95 masks:", `Eligible groups can collect free N95 masks at ${maskPlaces(masks.inStock)} with stock now.`);
    if (find.length) lines.push(`Find one: ${find.join(" or ")}`);
    lines.push(`Official list: ${MASK_SHORT_URL}`);
  }
```

with:

```js
  if (masks) {
    const find = [appUrl && new URL("#masks", appUrl).href, botUsername && `send /masks to @${botUsername}`].filter(Boolean);
    lines.push("", "Free N95 masks:", `Eligible groups can collect free N95 masks at ${maskPlaces(masks)}.`);
    if (find.length) lines.push(`Find one: ${find.join(" or ")}`);
    lines.push(`Live stock: ${MASK_SHORT_URL}`);
  }
```

Replace:

```js
      // A mask list that can't be read never blocks the post.
      const masks = await loadMasks(env, now).catch(() => null);
```

with:

```js
      const masks = maskDistribution(env) ? maskCounts(MASK_SITES) : null;
```

and replace `if (masks?.active) reply.reply_markup.inline_keyboard.push(` with `if (masks) reply.reply_markup.inline_keyboard.push(`.

- [ ] **Step 9: Migration and switch**

Create `migrations/0006_drop_mask_sources.sql`:

```sql
-- HazeMaskGoWhere refuses requests from Cloudflare's network, so the Worker no longer saves mask points; the collection
-- points ship in public/mask-sites.js instead.
DROP TABLE IF EXISTS mask_sources;
```

In `wrangler.jsonc`, replace:

```jsonc
    "PUBLIC_APP_URL": "https://hazey.gabrieltang515.workers.dev"
```

with:

```jsonc
    "PUBLIC_APP_URL": "https://hazey.gabrieltang515.workers.dev",
    "MASK_DISTRIBUTION": "on"
```

- [ ] **Step 10: Run the tests**

Run: `npm test`
Expected: all pass. The dashboard still imports the old stock helpers from `public/masks.js` (those exports remain until Task 2), so nothing browser-side breaks yet. Run `grep -rn "mask-data\|loadMasks\|refreshMasks\|saveMaskSource\|api/masks" src tests scripts public` and confirm the only matches are `scripts/mask-data.js`, `scripts/build-mask-sites.js`, `tests/masks.test.js`, the new `/api/masks` 404 assertion, and `public/app.js` (still fetching `/api/masks` until Task 2).

- [ ] **Step 11: Commit**

```bash
git add -A scripts/mask-data.js src/mask-data.js scripts/build-mask-sites.js public/mask-sites.js public/masks.js src/masks.js src/worker.js src/broadcast.js migrations/0006_drop_mask_sources.sql wrangler.jsonc tests/masks.test.js tests/worker.test.js
git commit -m "Serve mask points from a saved HazeMaskGoWhere list behind a MASK_DISTRIBUTION switch"
```

---

### Task 2: Dashboard reads the saved list and follows the switch

**Files:**
- Modify: `public/masks.js`, `public/index.html`, `public/app.js`, `public/styles.css`, `scripts/check-browser.js`, `tests/masks.test.js`

**Interfaces:**
- Consumes:
  - `MASK_SITES` and `MASK_SITES_AS_AT` from `public/mask-sites.js`
  - `MASK_KINDS`, `maskCounts` and `maskPlaces` from `public/masks.js`
  - `masksActive` in the `/api/psi` response (all from Task 1)

- [ ] **Step 1: Remove the stock helpers from `public/masks.js`**

Replace the file's contents with:

```js
// Free N95 mask distribution, shared by the dashboard, the Telegram bot and the channel. Collection points come from
// HazeMaskGoWhere, the government's mask locator (NEA haze situation update, 14 October 2026), via public/mask-sites.js.
export const MASK_FINDER_URL = "https://www.gowhere.gov.sg/hazemask";
export const MASK_SHORT_URL = "go.gov.sg/hazemask";

export const MASK_KINDS = { cc: "CC counter", vending: "Vending machine" };

// "4 CC counters and 1 vending machine" from { cc, vending } counts.
export function maskPlaces(counts) {
  return [[counts.cc, "CC counter"], [counts.vending, "vending machine"]]
    .filter(([count]) => count > 0)
    .map(([count, noun]) => `${count} ${noun}${count === 1 ? "" : "s"}`)
    .join(" and ");
}

// { cc, vending } counts of a list of sites.
export function maskCounts(sites) {
  const counts = { cc: 0, vending: 0 };
  for (const site of sites) counts[site.kind]++;
  return counts;
}
```

In `tests/masks.test.js`:
- change the `public/masks.js` import to `import { MASK_KINDS, maskCounts, maskPlaces } from "../public/masks.js";`
- rename the test `"shared mask helpers: collectable points, stock time and place counts"` to `"shared mask helpers: labels and place counts"`
- delete its `collectable`, `MASK_STOCK` and the three `stockUpdatedAt` assertions, and replace the `MASK_STOCK` line with `assert.deepEqual(MASK_KINDS, { cc: "CC counter", vending: "Vending machine" });`

- [ ] **Step 2: Update `public/index.html`**

- Change `<section class="masks" id="masks" aria-labelledby="masks-title">` to `<section class="masks" id="masks" aria-labelledby="masks-title" hidden>`.
- Change the mask results message `<p class="place-message" id="mask-message" role="status">Loading mask collection points</p>` to `<p class="place-message" id="mask-message" role="status">Your five nearest mask points will appear here.</p>`.
- Replace the mask section's note paragraph (it starts `<p class="place-note">Out-of-stock points and vending machines that are out of service are left out.`) with:

```html
        <p class="place-note">Stock changes through the day: <a href="https://www.gowhere.gov.sg/hazemask" target="_blank" rel="noopener noreferrer">check live stock on HazeMaskGoWhere ↗</a> before you go. Distances are in a straight line.</p>
```

- Replace the footer credit `Free N95 mask collection points and stock from` with `Free N95 mask collection points from` (the rest of that paragraph stays).

- [ ] **Step 3: Update `public/app.js`**

- Change the `./psi.js` import to also import `singaporeTime` (add it to the existing named imports).
- Replace `import { MASK_KINDS, MASK_STALE_AFTER, MASK_STOCK, collectable, maskPlaces, stockUpdatedAt } from "./masks.js";` with:

```js
import { MASK_KINDS, maskCounts, maskPlaces } from "./masks.js";
import { MASK_SITES, MASK_SITES_AS_AT } from "./mask-sites.js";
```

- In `state`, replace:

```js
  // `masks` is undefined until /api/masks first answers, then null if it never could. `nearby` is the latest search.
  masks: undefined, masksStale: null, nearby: null
```

  with:

```js
  // `nearby` is the latest search for haze shelters and mask points.
  nearby: null
```

- Replace everything from `const STOCK_TONES = { in: "good", limited: "moderate", unknown: "unknown" };` up to, but not including, the comment line `// \`nearby\` is { message } while a search is busy…` with:

```js
byId("masks-meta").textContent = `${maskPlaces(maskCounts(MASK_SITES))}, from HazeMaskGoWhere`;
byId("mask-status").textContent = `Locations as at ${singaporeTime(MASK_SITES_AS_AT)} SGT. Stock changes through the day, so check live stock on HazeMaskGoWhere before you go.`;

// Shown only while free mask distribution is on (MASK_DISTRIBUTION in the Worker's settings, reported by /api/psi).
function renderMasks() {
  const active = state.data?.masksActive === true;
  byId("masks").hidden = !active;
  byId("mask-jump").hidden = !active;
}

function renderMaskResults() {
  const { nearby } = state;
  if (nearby?.message) return setResults("mask", nearby.message);
  if (!nearby) return setResults("mask", "Your five nearest mask points will appear here.");
  const closest = nearest(nearby.origin, MASK_SITES, 5);
  setResults("mask", closest[0].km > 30
    ? `The nearest mask point is ${formatDistance(closest[0].km)} from ${nearby.label}. These points are in Singapore only.`
    : `Nearest to ${nearby.label}`, closest.map(site => placeItem(site, [MASK_KINDS[site.kind], site.spot, site.hours].filter(Boolean))));
}

```

- In `render()`, after the line `renderShelterStatus();` add `renderMasks();`.
- Delete the `validMasks` function and the `loadMaskPoints` function (with its comment) from the Loading section.
- At the end of the file:
  - change `document.addEventListener("visibilitychange", () => { if (!document.hidden) { load(); loadMaskPoints(); } });` back to `document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });`;
  - delete the lines `loadMaskPoints();`, `setInterval(() => { if (!document.hidden) loadMaskPoints(); }, 5 * 60_000);`, and the staleness interval (its comment line and the `setInterval(() => { const key = … }, 20_000);` block).
- Run `grep -n "loadMaskPoints\|staleSources\|masksListed\|MASK_STOCK\|collectable\|stockUpdatedAt\|state.masks\|api/masks" public/app.js` and confirm there are no matches.

- [ ] **Step 4: Update `public/styles.css`**

Delete the `.place-meta { … }` rule (the mask stock badge line no longer exists).

- [ ] **Step 5: Update `scripts/check-browser.js`**

Replace the mask block, from `// Free N95 mask points: the searches above also fill the mask list, and a search there fills the shelters.` through the line `assert.ok(maskLayout.scrollWidth <= maskLayout.width, …);`, with:

```js
      // Free N95 mask points: shown while distribution is on; the searches above also fill the mask list.
      const masksActive = (await evaluate("fetch('/api/psi', { cache: 'no-store' }).then(response => response.json())")).masksActive === true;
      const masks = await evaluate("({ hidden: document.getElementById('masks').hidden, jump: !document.getElementById('mask-jump').hidden, status: document.getElementById('mask-status').textContent, message: document.getElementById('mask-message').textContent, names: Array.from(document.querySelectorAll('#mask-list .place-name'), e => e.textContent), eligibility: document.querySelectorAll('#mask-eligibility li').length, official: Boolean(document.querySelector('#masks a[href=\"https://www.gowhere.gov.sg/hazemask\"]')) })");
      assert.equal(masks.hidden, !masksActive, `${viewport.name}: mask section follows MASK_DISTRIBUTION`);
      assert.equal(masks.jump, masksActive, `${viewport.name}: hero mask link follows MASK_DISTRIBUTION`);
      if (masksActive) {
        assert.equal(masks.names.length, 5, `${viewport.name}: five nearest mask points`);
        assert.match(masks.message, /postal code 089774/, `${viewport.name}: the shelter search also filled the mask list`);
        assert.match(masks.status, /^Locations as at .+ SGT\./, `${viewport.name}: the list says when it was saved`);
        assert.equal(masks.eligibility, 7, `${viewport.name}: eligibility lists seven groups`);
        assert.ok(masks.official, `${viewport.name}: HazeMaskGoWhere is linked`);
        await evaluate("document.getElementById('mask-postal-input').value = '530572'; document.getElementById('mask-postal-form').requestSubmit()");
        const fromMasks = await shelters();
        assert.equal(fromMasks.names[0], "Ang Mo Kio-Hougang Pinetree RN", `${viewport.name}: a mask search fills the shelter list too`);
        assert.match(fromMasks.message, /postal code 530572/);
        const maskLayout = await evaluate("({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })");
        assert.ok(maskLayout.scrollWidth <= maskLayout.width, `${viewport.name}: no horizontal overflow with mask results`);
      }
```

In the final `console.log`, replace `mask finder (${masks.names.length} points)` with `mask finder (${masksActive ? `${masks.names.length} points` : "off"})`.

- [ ] **Step 6: Run the tests and the local browser check**

Run: `npm test`. Expected: all pass.

Run:

```bash
npm run db:local
npx wrangler dev --port 8787
```

(in the background). Wait until it answers, then run `npm run check:browser -- http://127.0.0.1:8787`.

Expected: desktop and mobile pass with `mask finder (5 points)`. If the PM2.5 overview assertion fails because local history is short, that is a local-data condition, not this change: report it and check that the mask lines passed. Read `hazey-desktop.png` and `hazey-mobile.png` from `node -p "require('os').tmpdir()"` and confirm:
- the `#masks` section shows "Locations as at … SGT"
- each result shows its kind, spot and hours, with no stock badges
- the note links live stock
- nothing overflows

Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add public/masks.js public/index.html public/app.js public/styles.css scripts/check-browser.js tests/masks.test.js
git commit -m "Dashboard mask finder reads the saved list and follows the distribution switch"
```

---

### Task 3: Release (controller)

- [ ] `npm test`, `npx wrangler deploy --dry-run`.
- [ ] Update `HANDOVER.md`: replace the live-fetch description in the mask section with the saved-list design, the 403 finding, how to regenerate (`node scripts/build-mask-sites.js`, then test and redeploy) and how to switch off (remove `MASK_DISTRIBUTION`, redeploy). Record the deployed version, migrations `0001`–`0006`, the remaining owner steps (`/masks` in Telegram, terms of use) and the known limit: no live stock, and the list can drift until it's regenerated.
- [ ] Deploy the code first (`npx wrangler deploy`), then apply `0006` (`npx wrangler d1 migrations apply PSI_DB --remote`, confirm with `migrations list`).
- [ ] Production checks:
  - `/api/psi` has `masksActive: true`.
  - `/api/masks` returns 404.
  - `/mask-sites.js` returns 200.
  - The browser check passes at both widths with `mask finder (5 points)`.
  - `wrangler tail` shows no `Mask site refresh failed` lines after the next cron.
- [ ] Commit, fast-forward `main`, push both branches.
