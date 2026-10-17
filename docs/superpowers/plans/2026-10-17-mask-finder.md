# Free N95 Mask Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the nearest free N95 mask collection points with stock, from HazeMaskGoWhere, on the dashboard, in the bot (`/masks`) and in channel posts.

**Architecture:** The five-minute cron also fetches HazeMaskGoWhere's two JSON files, validates and normalizes them, and saves each one as a row in D1. `GET /api/masks`, the bot and the channel all read that saved copy, so the last good list survives an outage and is marked stale after 30 minutes. The dashboard computes the nearest points in the browser with the existing shelter-finder geometry. One search fills both the shelter and mask lists.

**Tech Stack:** Cloudflare Workers (plain ESM), D1 (SQLite), buildless HTML/CSS/JS, Node's built-in test runner with `node:sqlite`, and the Chrome DevTools browser check in `scripts/check-browser.js`.

**Spec:** `docs/superpowers/specs/2026-10-17-mask-finder-design.md`

## Global Constraints

- **Cloudflare Free only.** Use the existing Worker `hazey`, the D1 binding `PSI_DB` and the `*/5 * * * *` trigger in `wrangler.jsonc`. Don't add resources, paid services or secrets.
- **Code style:** plain ESM, buildless browser code and no new dependencies. Match the surrounding code: terse comments, `Object.assign(document.createElement(...))` DOM building, and curly quotes (’) in user-facing copy.
- **Times:** display in Asia/Singapore via `singaporeClock` and `singaporeTime` from `public/psi.js`.
- **Logs:** never log tokens, locations or postal codes.
- **CSP:** `public/_headers` stays unchanged. The browser calls only same-origin `/api/masks` and `/api/postal`.
- **Source files:** `https://www.gowhere.gov.sg/hazemask/data/data.csv.json` (CC counters, `cc`) and `https://www.gowhere.gov.sg/hazemask/data/data.webhook.json` (vending machines, `vending`). Never use `data.json`.
- **Official links:** `https://www.gowhere.gov.sg/hazemask` (short form `go.gov.sg/hazemask`) and the FAQ `https://www.gowhere.gov.sg/hazemask/faq`.
- **Staleness:** a source is stale when `now - fetched_at > 30 minutes`.
- **Active:** `active` means at least one non-stale source has a site with stock `in` or `limited`.
- **Collectable:** a site is collectable when its stock isn't `out` or `offline`. The dashboard and bot list only collectable sites.
- **Migrations:** apply `migrations/0005_mask_sites.sql` to production D1 **before** deploying code that uses it.
- **Running commands:** run `npm test` from the repository root. If `node`/`npm` are missing from PATH, use `sh scripts/hazey.sh test`.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `public/masks.js` | create | Shared labels, official URLs, `collectable`, `stockUpdatedAt`, `maskPlaces` (browser, bot, channel) |
| `src/postal.js` | modify | Export `inSingapore(lat, lng)` (used by OneMap lookups and mask validation) |
| `src/mask-data.js` | create | HazeMaskGoWhere fetch, validation, normalization, D1 save and load |
| `migrations/0005_mask_sites.sql` | create | `mask_sources` and `bot_location_requests` tables |
| `src/nearby.js` | create | Shared location/postal-code input handling for `/shelter` and `/masks` |
| `src/shelters.js` | modify | Use `nearbyCommand` |
| `src/masks.js` | create | `/masks` bot reply |
| `src/worker.js` | modify | `/api/masks`, scheduled mask refresh and pruning, `/masks` routing, pending location requests, help text |
| `src/telegram.js` | modify | `masks` in `BOT_COMMANDS` |
| `src/broadcast.js` | modify | "Free N95 masks" block and button while `active` |
| `public/index.html`, `public/styles.css`, `public/app.js` | modify | `#masks` section, shared finder, hero link, footer credit; rename shared `shelter-*` classes to `place-*` |
| `scripts/check-browser.js` | modify | Mask section assertions; scoped shelter selectors |
| `tests/mask-fixtures.js` | create | HazeMaskGoWhere-shaped test data (not a test file; `node --test` ignores it) |
| `tests/masks.test.js` | create | Pure normalization and helper tests |
| `tests/worker.test.js` | modify | Storage, API, scheduled, bot and channel tests |
| `HANDOVER.md` | modify | Release record |

---

### Task 1: Shared mask helpers and HazeMaskGoWhere normalization

**Files:**
- Create: `public/masks.js`
- Create: `src/mask-data.js`
- Create: `tests/mask-fixtures.js`
- Create: `tests/masks.test.js`
- Modify: `src/postal.js`

**Interfaces:**
- Produces:
  - `public/masks.js` exports:
    - `MASK_FINDER_URL`, `MASK_SHORT_URL` (strings)
    - `MASK_KINDS` (`{ cc, vending }` → label)
    - `MASK_STOCK` (`{ in, limited, out, offline, unknown }` → label)
    - `collectable(site) → boolean`
    - `stockUpdatedAt(sources) → ISO string | null`
    - `maskPlaces({ cc, vending }) → string`
  - `src/postal.js` exports `inSingapore(lat, lng) → boolean`.
  - `src/mask-data.js` exports:
    - `MASK_SOURCES` (`{ cc: url, vending: url }`)
    - `normalizeMaskSites(body, source) → { sites, dropped }`. It throws `Error("Unexpected HazeMaskGoWhere format")` when `body.data` isn't an array.
  - A site has the shape `{ name, kind: "cc"|"vending", address, postal: string|null, lat, lng, hours: string|null, spot: string|null, stock: "in"|"limited"|"out"|"offline"|"unknown" }`.
  - `tests/mask-fixtures.js` exports `maskEntry(options)`, `ccFile()` and `vendingFile()`.

- [ ] **Step 1: Create the test fixtures**

Create `tests/mask-fixtures.js`:

```js
// HazeMaskGoWhere-shaped test data around 572 Hougang St 51 (530572), from the 16 October 2026 files.
const FLAGS = {
  stock: ["stocksAvailable", "limitedStocksAvailable", "outOfStock"],
  machine: ["available", "notAvailable"],
  collectionOption: ["vendingMachine", "ccCounter"]
};

export function maskEntry({ name, address = "1 Test Road", postalCode = "123456", lat, lng, option = "ccCounter",
  stock = "stocksAvailable", machine = null, hours = "Monday to Sunday, 10am to 6pm", description = null }) {
  const chosen = { stock, machine, collectionOption: option };
  return {
    address, postalCode, name, contactNumber: "60000000", description, LON: lng, LAT: lat, operatingHoursFreeText: hours,
    filters: [
      { category: "region", options: [{ name: "north-east", flag: true }] },
      ...Object.entries(FLAGS).map(([category, names]) => ({ category, options: names.map(flag => ({ name: flag, flag: flag === chosen[category] })) }))
    ]
  };
}

// Five valid CC counters (one out of stock) and two invalid entries.
export const ccFile = () => ({ lastUpdated: "16 Oct 2026", data: [
  maskEntry({ name: "Ci Yuan CC", address: "51 Hougang Ave 9 #01-01", postalCode: "538776", lat: 1.375322537735674, lng: 103.8829319300397 }),
  maskEntry({ name: "Punggol CC", address: "3 Hougang Ave 6", postalCode: "538808", lat: 1.374369988219469, lng: 103.8919119303212, stock: "outOfStock" }),
  maskEntry({ name: "Buangkok CC", address: "70 Compassvale Bow #01-25", postalCode: "544692", lat: 1.382981632033452, lng: 103.8927210077455 }),
  maskEntry({ name: "Hougang CC", address: "35 Hougang Ave 3", postalCode: "538840", lat: 1.364751243812483, lng: 103.8927279945726, stock: "limitedStocksAvailable" }),
  maskEntry({ name: "Tanjong Pagar CC", address: "101 Cantonment Road", postalCode: "089774", lat: 1.27617, lng: 103.84158 }),
  maskEntry({ name: "Nowhere CC", lat: 0, lng: 0 }),
  maskEntry({ name: "  ", lat: 1.3, lng: 103.8 })
] });

// One machine out of service, one with limited stock.
export const vendingFile = () => ({ lastUpdated: "16 Oct 2026", data: [
  maskEntry({ name: "Hougang Social Service Office (SSO)", address: "662 Hougang Avenue 4", postalCode: "530662", description: "Near lift lobby B",
    lat: 1.374376894, lng: 103.8828749, option: "vendingMachine", stock: null, machine: "notAvailable", hours: "Daily, 24 hours" }),
  maskEntry({ name: "Hougang Bus Interchange", address: "840 Hougang Central", postalCode: "538757", description: "Near Boarding Berth 1",
    lat: 1.370894574, lng: 103.8931575, option: "vendingMachine", stock: "limitedStocksAvailable", machine: "available", hours: "Daily,\n 24 hours" })
] });
```

- [ ] **Step 2: Write the failing tests**

Create `tests/masks.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMaskSites } from "../src/mask-data.js";
import { MASK_KINDS, MASK_STOCK, collectable, maskPlaces, stockUpdatedAt } from "../public/masks.js";
import { ccFile, maskEntry, vendingFile } from "./mask-fixtures.js";

test("HazeMaskGoWhere entries normalize to sites with kind, stock, hours and spot; invalid entries are dropped", () => {
  const cc = normalizeMaskSites(ccFile(), "cc");
  assert.equal(cc.dropped, 2);
  assert.deepEqual(cc.sites.map(site => site.name), ["Ci Yuan CC", "Punggol CC", "Buangkok CC", "Hougang CC", "Tanjong Pagar CC"]);
  assert.deepEqual(cc.sites[0], { name: "Ci Yuan CC", kind: "cc", address: "51 Hougang Ave 9 #01-01", postal: "538776",
    lat: 1.375322537735674, lng: 103.8829319300397, hours: "Monday to Sunday, 10am to 6pm", spot: null, stock: "in" });
  assert.deepEqual(cc.sites.map(site => site.stock), ["in", "out", "in", "limited", "in"]);
  assert.equal(cc.sites[4].postal, "089774", "leading zeros survive");
  const vending = normalizeMaskSites(vendingFile(), "vending");
  assert.equal(vending.dropped, 0);
  assert.deepEqual(vending.sites.map(site => [site.kind, site.stock, site.spot, site.hours]), [
    ["vending", "offline", "Near lift lobby B", "Daily, 24 hours"],
    ["vending", "limited", "Near Boarding Berth 1", "Daily, 24 hours"]
  ]);
  assert.equal("contactNumber" in vending.sites[0], false, "contact numbers are not kept");
});

test("out of service beats stock flags, the most cautious stock flag wins, and the file decides an unflagged kind", () => {
  const offline = maskEntry({ name: "Machine", lat: 1.3, lng: 103.8, option: null, stock: "stocksAvailable", machine: "notAvailable" });
  const [machine] = normalizeMaskSites({ data: [offline] }, "vending").sites;
  assert.equal(machine.stock, "offline");
  assert.equal(machine.kind, "vending");
  const conflicting = maskEntry({ name: "Counter", lat: 1.3, lng: 103.8 });
  for (const option of conflicting.filters.find(filter => filter.category === "stock").options) option.flag = option.name !== "limitedStocksAvailable";
  assert.equal(normalizeMaskSites({ data: [conflicting] }, "cc").sites[0].stock, "out");
  const bare = maskEntry({ name: "Unknown", lat: "1.3", lng: "103.8", stock: null, postalCode: "12345", hours: "  " });
  const [site] = normalizeMaskSites({ data: [bare] }, "cc").sites;
  assert.deepEqual([site.stock, site.postal, site.hours, site.lat], ["unknown", null, null, 1.3]);
});

test("a file without a data array is a failed fetch; an empty list is valid", () => {
  assert.throws(() => normalizeMaskSites({ code: 0, data: { items: [] } }, "cc"), /Unexpected HazeMaskGoWhere format/);
  assert.throws(() => normalizeMaskSites(null, "cc"), /Unexpected HazeMaskGoWhere format/);
  assert.deepEqual(normalizeMaskSites({ lastUpdated: "16 Oct 2026", data: [] }, "cc"), { sites: [], dropped: 0 });
  assert.deepEqual(normalizeMaskSites({ data: [null, "x", { name: "No coordinates", address: "1 Road" }] }, "cc"), { sites: [], dropped: 3 });
});

test("shared mask helpers: collectable points, stock time and place counts", () => {
  assert.deepEqual(["in", "limited", "unknown", "out", "offline"].map(stock => collectable({ stock })), [true, true, true, false, false]);
  assert.ok(Object.keys(MASK_STOCK).length === 5 && MASK_KINDS.cc === "CC counter" && MASK_KINDS.vending === "Vending machine");
  assert.equal(stockUpdatedAt({ cc: { updatedAt: "cc" }, vending: { updatedAt: "vending" } }), "vending");
  assert.equal(stockUpdatedAt({ cc: { updatedAt: "cc" }, vending: null }), "cc");
  assert.equal(stockUpdatedAt({ cc: null, vending: null }), null);
  assert.equal(maskPlaces({ cc: 4, vending: 1 }), "4 CC counters and 1 vending machine");
  assert.equal(maskPlaces({ cc: 0, vending: 2 }), "2 vending machines");
  assert.equal(maskPlaces({ cc: 1, vending: 0 }), "1 CC counter");
});
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `node --test tests/masks.test.js`
Expected: FAIL with `Cannot find module '…/src/mask-data.js'`.

- [ ] **Step 4: Export `inSingapore` from `src/postal.js`**

In `src/postal.js`, replace:

```js
const SINGAPORE = { south: 1.15, north: 1.48, west: 103.59, east: 104.1 };

export const validPostalCode = code => typeof code === "string" && /^\d{6}$/.test(code);
```

with:

```js
const SINGAPORE = { south: 1.15, north: 1.48, west: 103.59, east: 104.1 };

export const validPostalCode = code => typeof code === "string" && /^\d{6}$/.test(code);
export const inSingapore = (lat, lng) => lat > SINGAPORE.south && lat < SINGAPORE.north && lng > SINGAPORE.west && lng < SINGAPORE.east;
```

and replace:

```js
  if (!(lat > SINGAPORE.south && lat < SINGAPORE.north && lng > SINGAPORE.west && lng < SINGAPORE.east)) return null;
```

with:

```js
  if (!inSingapore(lat, lng)) return null;
```

- [ ] **Step 5: Create `public/masks.js`**

```js
// Free N95 mask distribution, shared by the dashboard, the Telegram bot and the channel. Collection points and
// stock come from HazeMaskGoWhere, the government's mask locator (NEA haze situation update, 14 October 2026).
export const MASK_FINDER_URL = "https://www.gowhere.gov.sg/hazemask";
export const MASK_SHORT_URL = "go.gov.sg/hazemask";

export const MASK_KINDS = { cc: "CC counter", vending: "Vending machine" };
export const MASK_STOCK = { in: "In stock", limited: "Limited stock", out: "Out of stock", offline: "Out of service", unknown: "Stock unknown" };

// Points worth sending someone to: anything not known to be empty or out of service.
export const collectable = site => site.stock !== "out" && site.stock !== "offline";

// The vending machine file carries the live stock; CC counters change rarely.
export const stockUpdatedAt = sources => (sources?.vending ?? sources?.cc)?.updatedAt ?? null;

// "4 CC counters and 1 vending machine" from { cc, vending } counts.
export function maskPlaces(counts) {
  return [[counts.cc, "CC counter"], [counts.vending, "vending machine"]]
    .filter(([count]) => count > 0)
    .map(([count, noun]) => `${count} ${noun}${count === 1 ? "" : "s"}`)
    .join(" and ");
}
```

- [ ] **Step 6: Create `src/mask-data.js` with normalization**

```js
// Free N95 mask collection points from HazeMaskGoWhere (https://www.gowhere.gov.sg/hazemask). These are the JSON
// files the official page loads, not a published open dataset, so every failure falls back to linking that site.
// They send no CORS headers, so the Worker relays them.
import { inSingapore } from "./postal.js";

export const MASK_SOURCES = {
  cc: "https://www.gowhere.gov.sg/hazemask/data/data.csv.json",
  vending: "https://www.gowhere.gov.sg/hazemask/data/data.webhook.json"
};

const text = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
// The option names flagged true in one of an entry's filter categories.
function flagged(entry, category) {
  const filter = Array.isArray(entry.filters) ? entry.filters.find(item => item?.category === category) : null;
  return Array.isArray(filter?.options) ? filter.options.filter(option => option?.flag === true).map(option => option.name) : [];
}

function maskSite(entry, source) {
  if (!entry || typeof entry !== "object") return null;
  const name = text(entry.name), address = text(entry.address);
  const lat = Number(entry.LAT), lng = Number(entry.LON);
  if (!name || !address || !inSingapore(lat, lng)) return null;
  const option = flagged(entry, "collectionOption");
  const stock = flagged(entry, "stock");
  const postal = text(String(entry.postalCode ?? ""));
  return {
    name, kind: option.includes("vendingMachine") ? "vending" : option.includes("ccCounter") ? "cc" : source,
    address, postal: /^\d{6}$/.test(postal) ? postal : null, lat, lng,
    hours: text(entry.operatingHoursFreeText) || null, spot: text(entry.description) || null,
    // An out-of-service machine has nothing to offer, and the most cautious stock flag wins.
    stock: flagged(entry, "machine").includes("notAvailable") ? "offline"
      : stock.includes("outOfStock") ? "out" : stock.includes("limitedStocksAvailable") ? "limited"
      : stock.includes("stocksAvailable") ? "in" : "unknown"
  };
}

// `body` is one HazeMaskGoWhere file, { lastUpdated, data: [...] }; `source` is "cc" or "vending".
export function normalizeMaskSites(body, source) {
  if (!Array.isArray(body?.data)) throw new Error("Unexpected HazeMaskGoWhere format");
  const sites = body.data.map(entry => maskSite(entry, source)).filter(Boolean);
  return { sites, dropped: body.data.length - sites.length };
}
```

- [ ] **Step 7: Run the tests to make sure they pass**

Run: `node --test tests/masks.test.js`
Expected: 4 tests pass.

Run: `npm test`
Expected: all tests pass. The existing postal tests still pass, which shows `lookupPostal` behaves the same.

- [ ] **Step 8: Commit**

```bash
git add public/masks.js src/mask-data.js src/postal.js tests/mask-fixtures.js tests/masks.test.js
git commit -m "Normalize HazeMaskGoWhere mask points and add shared mask helpers"
```

---

### Task 2: Saved mask list, `/api/masks` and the scheduled refresh

**Files:**
- Create: `migrations/0005_mask_sites.sql`
- Modify: `src/mask-data.js` (append)
- Modify: `src/worker.js` (imports, `/api/masks` route, `scheduled`)
- Modify: `tests/worker.test.js` (imports, `nea` helper, `channelHarness`, new tests)

**Interfaces:**
- Consumes: `MASK_SOURCES` and `normalizeMaskSites` (Task 1).
- Produces, from `src/mask-data.js`:
  - `MASK_STALE_AFTER` (ms)
  - `saveMaskSource(env, source, sites, fetchedAt, modifiedAt) → Promise`
  - `refreshMasks(env, now?) → Promise<void>`. It never rejects for upstream failures; each source failure is logged.
  - `loadMasks(env, now?) → Promise<{ sites, sources: { cc, vending }, inStock: { cc, vending }, active }>`. Each source is `{ fetchedAt, updatedAt, stale } | null`, with ISO strings.
- Produces: `GET /api/masks` → `loadMasks` JSON.
- The test helpers `maskFile(body, modified?)` and `EMPTY_MASKS` live in `tests/worker.test.js`.

- [ ] **Step 1: Create the migration**

Create `migrations/0005_mask_sites.sql`:

```sql
-- Free N95 mask collection points saved from HazeMaskGoWhere, one row per file.
CREATE TABLE IF NOT EXISTS mask_sources (
  source TEXT PRIMARY KEY CHECK (source IN ('cc', 'vending')),
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  source_modified_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Update the test helpers in `tests/worker.test.js`**

Add these imports after the existing `import { ONEMAP_SEARCH_URL } from "../src/postal.js";` line:

```js
import { MASK_SOURCES, loadMasks, normalizeMaskSites, refreshMasks, saveMaskSource } from "../src/mask-data.js";
import { ccFile, vendingFile } from "./mask-fixtures.js";
```

Replace:

```js
const nea = url => Response.json(url === PM25_API_URL ? pm25Fixture() : fixture());
```

with:

```js
// Scheduled runs also fetch HazeMaskGoWhere; by default it lists nothing.
const EMPTY_MASKS = { lastUpdated: "16 Oct 2026", data: [] };
const maskSource = url => Object.keys(MASK_SOURCES).find(source => MASK_SOURCES[source] === url);
const maskFile = (body, modified) => Response.json(body, modified ? { headers: { "Last-Modified": new Date(modified).toUTCString() } } : {});
const nea = url => maskSource(url) ? Response.json(EMPTY_MASKS) : Response.json(url === PM25_API_URL ? pm25Fixture() : fixture());
```

In `channelHarness`, replace:

```js
    if (url.endsWith("/setMyCommands")) return Response.json({ ok: true, result: true });
```

with:

```js
    if (maskSource(url)) {
      if (options.masksDown) return new Response("unavailable", { status: 503 });
      return Response.json(options.masks?.[maskSource(url)] ?? EMPTY_MASKS);
    }
    if (url.endsWith("/setMyCommands")) return Response.json({ ok: true, result: true });
```

- [ ] **Step 3: Write the failing tests**

Append to `tests/worker.test.js`:

```js
test("mask refreshes save each HazeMaskGoWhere file on its own and never replace a newer saved copy", async t => {
  const { db, env } = setup(t);
  const now = Date.parse("2026-10-16T15:00:00Z");
  let ccResponse = () => maskFile(ccFile(), now - 60 * 60_000), vendingDown = false;
  t.mock.method(globalThis, "fetch", async url => {
    if (url === MASK_SOURCES.cc) return ccResponse();
    if (url === MASK_SOURCES.vending) return vendingDown ? new Response("busy", { status: 503 }) : maskFile(vendingFile(), now - 5 * 60_000);
    assert.fail(`Unexpected fetch: ${url}`);
  });
  const errors = t.mock.method(console, "error", () => {});
  const rows = () => Object.fromEntries(db.prepare("SELECT * FROM mask_sources").all().map(row => [row.source, row]));
  await refreshMasks(env, now);
  assert.equal(JSON.parse(rows().cc.payload).length, 5);
  assert.equal(JSON.parse(rows().vending.payload).length, 2);
  assert.equal(rows().vending.source_modified_at, now - 5 * 60_000, "stock time is the file's Last-Modified");
  assert.deepEqual(errors.mock.calls.map(call => call.arguments.join(" ")), ["Mask site refresh (cc): 5 valid of 7"]);

  vendingDown = true;
  ccResponse = () => maskFile(ccFile(), now - 2 * 60 * 60_000);
  await refreshMasks(env, now + 5 * 60_000);
  assert.equal(rows().vending.fetched_at, now, "a failed fetch keeps the saved copy");
  assert.equal(rows().cc.fetched_at, now, "an older file never replaces a newer saved one");
  assert.ok(errors.mock.calls.some(call => call.arguments.join(" ") === "Mask site refresh failed (vending): HazeMaskGoWhere request failed (503)"));

  ccResponse = () => new Response("<!doctype html><title>GoWhere</title>", { headers: { "Content-Type": "text/html" } });
  await refreshMasks(env, now + 10 * 60_000);
  assert.equal(rows().cc.fetched_at, now, "a page instead of JSON is a failed fetch");
  ccResponse = () => maskFile(ccFile());
  await refreshMasks(env, now + 15 * 60_000);
  assert.equal(rows().cc.source_modified_at, now + 15 * 60_000, "no Last-Modified: the fetch time stands in");
});

test("/api/masks serves the saved points, marks a source stale after 30 minutes and says when distribution is running", async t => {
  const { env, ctx } = setup(t);
  const masks = async () => (await worker.fetch(new Request("https://hazey.example/api/masks"), env, ctx)).json();
  assert.deepEqual(await masks(), { sites: [], sources: { cc: null, vending: null }, inStock: { cc: 0, vending: 0 }, active: false });
  const now = Date.now();
  await saveMaskSource(env, "cc", normalizeMaskSites(ccFile(), "cc").sites, now - 31 * 60_000, now - 60 * 60_000);
  await saveMaskSource(env, "vending", normalizeMaskSites(vendingFile(), "vending").sites, now - 60_000, now - 2 * 60_000);
  const body = await masks();
  assert.equal(body.sites.length, 7);
  assert.deepEqual([body.sources.cc.stale, body.sources.vending.stale], [true, false]);
  assert.equal(body.sources.vending.updatedAt, new Date(now - 2 * 60_000).toISOString());
  assert.equal(body.sources.cc.fetchedAt, new Date(now - 31 * 60_000).toISOString());
  assert.deepEqual(body.inStock, { cc: 0, vending: 1 }, "stale sources don't count");
  assert.equal(body.active, true);
  assert.equal((await worker.fetch(new Request("https://hazey.example/api/masks", { method: "POST" }), env, ctx)).status, 405);

  const later = now + 60 * 60_000;
  await saveMaskSource(env, "vending", normalizeMaskSites(vendingFile(), "vending").sites, later - 30 * 60_000, later);
  assert.equal((await loadMasks(env, later)).sources.vending.stale, false, "exactly 30 minutes is still fresh");
  assert.equal((await loadMasks(env, later + 1)).active, false, "nothing fresh has stock");
});

test("scheduled runs refresh mask points alongside PSI, and neither outage blocks the other", async t => {
  const { db, env } = setup(t);
  delete env.TELEGRAM_BOT_TOKEN;
  let masksDown = false, psiDown = false;
  t.mock.method(globalThis, "fetch", async url => {
    if (maskSource(url)) {
      if (masksDown) throw new TypeError("fetch failed");
      return maskFile(url === MASK_SOURCES.cc ? ccFile() : vendingFile());
    }
    if (psiDown) return new Response("unavailable", { status: 503 });
    return url.includes("?date=") ? Response.json({ code: 0, data: { items: [] } }) : nea(url);
  });
  const errors = t.mock.method(console, "error", () => {});
  const count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  const run = async () => {
    const pending = [];
    await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
  };
  await run();
  assert.deepEqual([count("mask_sources"), count("psi_snapshot")], [2, 1]);
  masksDown = true;
  db.prepare("DELETE FROM psi_snapshot").run();
  await run();
  assert.deepEqual([count("mask_sources"), count("psi_snapshot")], [2, 1], "PSI saves during a mask outage, and saved points survive");
  assert.ok(errors.mock.calls.some(call => call.arguments.join(" ") === "Mask site refresh failed (cc): fetch failed"));
  masksDown = false; psiDown = true;
  db.prepare("DELETE FROM mask_sources").run();
  await run();
  assert.equal(count("mask_sources"), 2, "masks save during a PSI outage");
});
```

- [ ] **Step 4: Run the tests to make sure they fail**

Run: `node --test tests/worker.test.js`
Expected: FAIL. The three new tests error with `refreshMasks is not a function` (it isn't exported yet), so the whole file fails to import. Every other test was passing before this step.

- [ ] **Step 5: Add saving, refreshing and loading to `src/mask-data.js`**

Append to `src/mask-data.js`:

```js
export const MASK_STALE_AFTER = 30 * 60_000;

// An older copy of a file (by Last-Modified) never replaces a newer saved one.
export function saveMaskSource(env, source, sites, fetchedAt, modifiedAt) {
  return env.PSI_DB.prepare(
    "INSERT INTO mask_sources (source, payload, fetched_at, source_modified_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(source) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, source_modified_at = excluded.source_modified_at " +
    "WHERE excluded.source_modified_at >= mask_sources.source_modified_at"
  ).bind(source, JSON.stringify(sites), fetchedAt, modifiedAt).run();
}

async function refreshMaskSource(env, source, now) {
  const response = await fetch(MASK_SOURCES[source], { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`HazeMaskGoWhere request failed (${response.status})`);
  const { sites, dropped } = normalizeMaskSites(await response.json(), source);
  if (dropped) console.error(`Mask site refresh (${source}): ${sites.length} valid of ${sites.length + dropped}`);
  // The JSON's own lastUpdated is only a date, so the file's Last-Modified gives the stock time.
  const modified = Date.parse(response.headers.get("Last-Modified") ?? "");
  await saveMaskSource(env, source, sites, now, Number.isFinite(modified) ? modified : now);
}

// Each file is saved on its own: one failing never blocks the other, and a failure keeps the saved copy.
export async function refreshMasks(env, now = Date.now()) {
  const sources = Object.keys(MASK_SOURCES);
  const results = await Promise.allSettled(sources.map(source => refreshMaskSource(env, source, now)));
  results.forEach((result, i) => {
    if (result.status === "rejected") console.error(`Mask site refresh failed (${sources[i]}):`, result.reason.message);
  });
}

// The saved list for /api/masks, the bot and the channel. `active` means distribution is running: a fresh source
// lists at least one point with stock.
export async function loadMasks(env, now = Date.now()) {
  const { results } = await env.PSI_DB.prepare("SELECT source, payload, fetched_at, source_modified_at FROM mask_sources ORDER BY source").all();
  const sources = { cc: null, vending: null }, sites = [], inStock = { cc: 0, vending: 0 };
  for (const row of results) {
    const stale = now - row.fetched_at > MASK_STALE_AFTER;
    sources[row.source] = { fetchedAt: new Date(row.fetched_at).toISOString(), updatedAt: new Date(row.source_modified_at).toISOString(), stale };
    for (const site of JSON.parse(row.payload)) {
      sites.push(site);
      if (!stale && (site.stock === "in" || site.stock === "limited")) inStock[site.kind]++;
    }
  }
  return { sites, sources, inStock, active: inStock.cc + inStock.vending > 0 };
}
```

- [ ] **Step 6: Wire up the Worker**

In `src/worker.js`, add this after `import { shelterCommand } from "./shelters.js";`:

```js
import { loadMasks, refreshMasks } from "./mask-data.js";
```

In `fetch`, add this directly after the `/api/history` block (`return json(await history(env));` and its closing `}`):

```js
      if (path === "/api/masks") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
        return json(await loadMasks(env));
      }
```

In `scheduled`, add this directly after the first `ctx.waitUntil(...)` statement (the one ending with `.catch(error => console.error("History maintenance failed:", error.message)));`):

```js
    // Mask points refresh on their own: neither a mask nor a PSI outage blocks the other.
    ctx.waitUntil(refreshMasks(env).catch(error => console.error("Mask site refresh failed:", error.message)));
```

- [ ] **Step 7: Run the tests to make sure they pass**

Run: `npm test`
Expected: all tests pass, including the 3 new ones. The existing scheduled and channel tests see an empty mask list and are unchanged.

- [ ] **Step 8: Commit**

```bash
git add migrations/0005_mask_sites.sql src/mask-data.js src/worker.js tests/worker.test.js
git commit -m "Save HazeMaskGoWhere mask points every five minutes and serve them at /api/masks"
```

---

### Task 3: `/masks` in the Telegram bot

**Files:**
- Create: `src/nearby.js`
- Create: `src/masks.js`
- Modify: `src/shelters.js`
- Modify: `src/worker.js` (help text, location routing, `/masks` branch, pending requests, pruning)
- Modify: `src/telegram.js` (`BOT_COMMANDS`)
- Modify: `migrations/0005_mask_sites.sql` (append `bot_location_requests`)
- Modify: `tests/worker.test.js`

**Interfaces:**
- Consumes:
  - `loadMasks(env)` (Task 2)
  - `collectable`, `stockUpdatedAt`, `MASK_KINDS`, `MASK_STOCK`, `MASK_FINDER_URL`, `MASK_SHORT_URL` (Task 1)
  - `nearest`, `formatDistance`, `directionsUrl` from `public/geo.js`
  - `singaporeClock` from `public/psi.js`
- Produces:
  - `src/nearby.js`: `LOCATION_KEYBOARD` and `nearbyCommand({ command, things, short, count, location, argument, isPrivate, reply }) → Promise<{ text, reply_markup? }>`.
  - `src/masks.js`: `masksReply({ origin, label, masks, appUrl, now? })` and `masksCommand({ location, argument, isPrivate, masks, appUrl, now? })`.
  - `shelterCommand` keeps its signature and output exactly.
- The `seedMasks(env, { fetchedAt?, edit? })` test helper lives in `tests/worker.test.js`.

- [ ] **Step 1: Add the pending-request table to the migration**

Append to `migrations/0005_mask_sites.sql`:

```sql

-- A private chat that sent plain /masks: its next shared location within ten minutes gets mask points.
-- Only the chat ID is kept, never the location.
CREATE TABLE IF NOT EXISTS bot_location_requests (
  chat_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('masks')),
  expires_at INTEGER NOT NULL
);
```

- [ ] **Step 2: Write the failing tests**

In `tests/worker.test.js`, in the test `"/pm25 replies with banded 1-hour PM2.5 only; /psi replies with PSI only; help lists both"`, add this after the `/shelter — nearest haze shelters…` assertion:

```js
  assert.match(replies[3], /\/masks — free N95 mask points near your location\n\/masks 530572 — mask points near a postal code/);
```

In the test `"scheduled runs refresh the bot command menu at minute 10…"`, replace:

```js
  assert.deepEqual(calls[0].body.commands.map(command => command.command), ["psi", "pm25", "shelter", "help", "start"]);
```

with:

```js
  assert.deepEqual(calls[0].body.commands.map(command => command.command), ["psi", "pm25", "shelter", "masks", "help", "start"]);
```

Append to `tests/worker.test.js`:

```js
// Saves the fixture files as if fetched at `fetchedAt`; `edit` changes the normalized sites first.
async function seedMasks(env, { fetchedAt = Date.now(), edit = sites => sites } = {}) {
  await saveMaskSource(env, "cc", edit(normalizeMaskSites(ccFile(), "cc").sites), fetchedAt, fetchedAt - 60 * 60_000);
  await saveMaskSource(env, "vending", edit(normalizeMaskSites(vendingFile(), "vending").sites), fetchedAt, fetchedAt - 5 * 60_000);
}

test("/masks with a postal code replies with the three nearest mask points with stock, eligibility and the stock time", async t => {
  const { env, ctx } = setup(t);
  env.PUBLIC_APP_URL = "https://hazey.example";
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.startsWith(ONEMAP_SEARCH_URL)) return Response.json({ results: [{ POSTAL: "530572", LATITUDE: "1.378270724882904", LONGITUDE: "103.8874850986399" }] });
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  await seedMasks(env);
  assert.equal((await worker.fetch(webhook(70, "/masks 530572"), env, ctx)).status, 200);
  const [reply] = replies;
  assert.match(reply.text, /^Nearest free N95 mask points to postal code 530572\n\n1\. Ci Yuan CC — 600 m\nCC counter • In stock\n51 Hougang Ave 9 #01-01, Singapore 538776\nMonday to Sunday, 10am to 6pm\n\n2\. Buangkok CC — 780 m\n/);
  assert.match(reply.text, /\n3\. Hougang Bus Interchange — 1\.0 km\nVending machine • Limited stock\n840 Hougang Central, Singapore 538757\nNear Boarding Berth 1\nDaily, 24 hours\n/);
  assert.doesNotMatch(reply.text, /Punggol CC|Hougang Social Service Office/, "out of stock and out of service are left out");
  assert.match(reply.text, /Pregnant women, children aged 7 to 16/);
  assert.match(reply.text, /\nStock from HazeMaskGoWhere, updated .+\. Live stock: go\.gov\.sg\/hazemask$/);
  const rows = reply.reply_markup.inline_keyboard;
  assert.equal(rows.length, 4);
  assert.equal(rows[0][0].text, "Directions: Ci Yuan CC");
  assert.equal(rows[3][0].url, "https://hazey.example/#masks");
  await worker.fetch(webhook(71, "/mask 530572"), env, ctx);
  assert.equal(replies[1].text, reply.text, "/mask is an alias");
});

test("plain /masks offers the location button and the next shared location finds mask points; otherwise locations find shelters", async t => {
  const { db, env, ctx } = setup(t);
  const replies = [];
  let telegramDown = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (telegramDown) return Response.json({ ok: false }, { status: 500 });
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  const errors = t.mock.method(console, "error", () => {});
  await seedMasks(env);
  const here = { latitude: 1.37827, longitude: 103.88749 };
  const pendingRows = () => db.prepare("SELECT count(*) AS n FROM bot_location_requests").get().n;
  await worker.fetch(webhook(80, "/masks"), env, ctx);
  assert.equal(replies[0].text, "Share your location to find the 3 nearest free N95 mask points, or send a postal code, e.g. /masks 530572.\n\nYour location is only used to find mask points and isn’t stored.");
  assert.equal(replies[0].reply_markup.keyboard[0][0].request_location, true);
  assert.equal(pendingRows(), 1);
  telegramDown = true;
  assert.equal((await worker.fetch(telegramMessage(81, { location: here }), env, ctx)).status, 502);
  assert.equal(pendingRows(), 1, "a failed reply keeps the request for Telegram's retry");
  telegramDown = false;
  await worker.fetch(telegramMessage(81, { location: here }), env, ctx);
  assert.match(replies[1].text, /^Nearest free N95 mask points to your location\n\n1\. Ci Yuan CC — 600 m\n/);
  assert.equal(pendingRows(), 0, "used once");
  await worker.fetch(telegramMessage(82, { location: here }), env, ctx);
  assert.match(replies[2].text, /^Nearest haze shelters to your location/);

  await worker.fetch(webhook(83, "/masks"), env, ctx);
  await worker.fetch(webhook(84, "/shelter"), env, ctx);
  assert.equal(pendingRows(), 0, "plain /shelter cancels a pending /masks request");
  await worker.fetch(telegramMessage(85, { location: here }), env, ctx);
  assert.match(replies[5].text, /^Nearest haze shelters/);

  await worker.fetch(webhook(86, "/masks"), env, ctx);
  db.prepare("UPDATE bot_location_requests SET expires_at = ?").run(Date.now() - 1);
  await worker.fetch(telegramMessage(87, { location: here }), env, ctx);
  assert.match(replies[7].text, /^Nearest haze shelters/, "an expired request falls back to shelters");

  await worker.fetch(telegramMessage(88, { chat: { id: -100, type: "group" }, text: "/masks" }), env, ctx);
  assert.equal(replies[8].text, "Send /masks with a postal code, e.g. /masks 530572. To use your location, message me privately.");
  assert.equal(db.prepare("SELECT count(*) AS n FROM bot_location_requests WHERE chat_id = -100").get().n, 0);
  assert.ok(errors.mock.calls.every(call => !/1\.37827|103\.88749/.test(call.arguments.join(" "))), "locations never reach the logs");
});

test("/masks without saved data links HazeMaskGoWhere; stale stock is flagged; empty and out-of-stock lists say so", async t => {
  const { env, ctx } = setup(t);
  const replies = [];
  let searches = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.startsWith(ONEMAP_SEARCH_URL)) { searches++; return Response.json({ results: [{ POSTAL: "530572", LATITUDE: "1.37827", LONGITUDE: "103.88749" }] }); }
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  await worker.fetch(webhook(90, "/masks 530572"), env, ctx);
  assert.equal(replies[0].text, "Couldn’t load the free N95 mask list right now. Find collection points on HazeMaskGoWhere: https://www.gowhere.gov.sg/hazemask");
  assert.deepEqual(replies[0].reply_markup.inline_keyboard, [[{ text: "Open HazeMaskGoWhere ↗", url: "https://www.gowhere.gov.sg/hazemask" }]]);
  assert.equal(searches, 0, "no list, no OneMap lookup");
  await seedMasks(env, { fetchedAt: Date.now() - 45 * 60_000 });
  await worker.fetch(webhook(91, "/masks 530572"), env, ctx);
  assert.match(replies[1].text, /\n⚠️ Stock may be out of date: Hazey last checked at .+\.\nStock from HazeMaskGoWhere/);
  await seedMasks(env, { edit: sites => sites.map(site => ({ ...site, stock: "out" })) });
  await worker.fetch(webhook(92, "/masks 530572"), env, ctx);
  assert.match(replies[2].text, /^None of the listed free N95 mask points has stock right now\.\n\nStock from HazeMaskGoWhere/);
  assert.equal(replies[2].reply_markup.inline_keyboard[0][0].url, "https://www.gowhere.gov.sg/hazemask");
  await seedMasks(env, { edit: () => [] });
  await worker.fetch(webhook(93, "/masks 530572"), env, ctx);
  assert.equal(replies[3].text, "No free N95 mask collection points are listed right now. Check HazeMaskGoWhere for updates: https://www.gowhere.gov.sg/hazemask");
});

test("scheduled runs prune expired /masks location requests", async t => {
  const { db, env } = setup(t);
  delete env.TELEGRAM_BOT_TOKEN;
  t.mock.method(globalThis, "fetch", async url => url.includes("?date=") ? Response.json({ code: 0, data: { items: [] } }) : nea(url));
  db.prepare("INSERT INTO bot_location_requests VALUES (1, 'masks', ?), (2, 'masks', ?)").run(Date.now() - 1, Date.now() + 60_000);
  const pending = [];
  await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.deepEqual(db.prepare("SELECT chat_id FROM bot_location_requests").all().map(row => row.chat_id), [2]);
});
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `node --test tests/worker.test.js`
Expected: FAIL in the help test, the menu test and the four new tests (`/masks` currently gets the help text). All existing shelter tests still pass.

- [ ] **Step 4: Create `src/nearby.js`**

```js
// Shared input handling for /shelter and /masks: a location shared in a private chat, or a postal code.
// Locations and postal codes are used for the reply only: never stored, and never written to logs.
import { lookupPostal, validPostalCode } from "./postal.js";

export const LOCATION_KEYBOARD = { keyboard: [[{ text: "📍 Share my location", request_location: true }]], one_time_keyboard: true, resize_keyboard: true };

// `things` names the results in prompts ("haze shelters") and `short` in the privacy line ("shelters").
// `reply(origin, label)` builds the answer once the place is known. Resolves to { text, reply_markup? }.
export async function nearbyCommand({ command, things, short, count, location, argument, isPrivate, reply }) {
  const example = `/${command} 530572`;
  if (location) return reply(location, "your location");
  const code = argument.replace(/\s/g, "");
  if (!code) {
    return isPrivate
      ? { text: `Share your location to find the ${count} nearest ${things}, or send a postal code, e.g. ${example}.\n\nYour location is only used to find ${short} and isn’t stored.`, reply_markup: LOCATION_KEYBOARD }
      : { text: `Send /${command} with a postal code, e.g. ${example}. To use your location, message me privately.` };
  }
  if (!validPostalCode(code)) return { text: `Postal codes have six digits, e.g. ${example}.` };
  let place;
  try {
    place = await lookupPostal(code);
  } catch (error) {
    console.error("Postal code lookup failed:", error.message);
    return isPrivate
      ? { text: "Postal code lookup is unavailable right now. Share your location instead, or try again shortly.", reply_markup: LOCATION_KEYBOARD }
      : { text: "Postal code lookup is unavailable right now. Please try again shortly." };
  }
  if (!place) return { text: `Couldn’t find postal code ${code}. Check the number and try again.` };
  return reply(place, `postal code ${code}`);
}
```

- [ ] **Step 5: Make `/shelter` use it**

In `src/shelters.js`, replace the import line:

```js
import { lookupPostal, validPostalCode } from "./postal.js";
```

with:

```js
import { nearbyCommand } from "./nearby.js";
```

Delete these two lines:

```js
const POSTAL_EXAMPLE = "/shelter 530572";
const LOCATION_KEYBOARD = { keyboard: [[{ text: "📍 Share my location", request_location: true }]], one_time_keyboard: true, resize_keyboard: true };
```

Replace the whole `shelterCommand` function (from `// Resolves to { text, reply_markup? } for a /shelter command…` to the end of the file) with:

```js
// Resolves to { text, reply_markup? } for a /shelter command, or for a location shared in a private chat.
export function shelterCommand({ location, argument, isPrivate, regions, appUrl }) {
  return nearbyCommand({ command: "shelter", things: "haze shelters", short: "shelters", count: COUNT, location, argument, isPrivate,
    reply: (origin, label) => shelterReply({ origin, label, regions, appUrl }) });
}
```

Run: `npm test`
Expected: the shelter tests (`/shelter with a postal code…`, `a privately shared location finds shelters…`, `postal lookup failures…`) still pass. Only the tests listed in Step 3 fail.

- [ ] **Step 6: Create `src/masks.js`**

```js
// /masks for the Telegram bot: the nearest free N95 mask points with stock, from the saved HazeMaskGoWhere list.
// Locations and postal codes are used for this reply only: never stored, and never written to logs.
import { MASK_FINDER_URL, MASK_KINDS, MASK_SHORT_URL, MASK_STOCK, collectable, stockUpdatedAt } from "../public/masks.js";
import { directionsUrl, formatDistance, nearest } from "../public/geo.js";
import { singaporeClock } from "../public/psi.js";
import { nearbyCommand } from "./nearby.js";

const COUNT = 3;
// NEA haze situation update, 14 October 2026.
const ELIGIBILITY = "Who can collect: Pioneer and Merdeka Generation, CHAS Blue and Orange cardholders, Medical Fee Exemption Card holders and ComCare recipients at a CC or vending machine. Pregnant women, children aged 7 to 16 and people with conditions such as asthma at CCs only. Bring the eligible person’s NRIC.";
const OFFICIAL_BUTTON = [{ text: "Open HazeMaskGoWhere ↗", url: MASK_FINDER_URL }];

function stockLines(masks, now) {
  const updated = stockUpdatedAt(masks.sources);
  const stale = Object.values(masks.sources).filter(source => source?.stale);
  const lines = [`Stock from HazeMaskGoWhere${updated ? `, updated ${singaporeClock(updated, now)}` : ""}. Live stock: ${MASK_SHORT_URL}`];
  if (stale.length) lines.unshift(`⚠️ Stock may be out of date: Hazey last checked at ${singaporeClock(Math.min(...stale.map(source => Date.parse(source.fetchedAt))), now)}.`);
  return lines;
}

// `masks` is the saved list from loadMasks.
export function masksReply({ origin, label, masks, appUrl, now = Date.now() }) {
  const closest = nearest(origin, masks.sites.filter(collectable), COUNT);
  if (!closest.length) {
    return { text: ["None of the listed free N95 mask points has stock right now.", "", ...stockLines(masks, now)].join("\n"),
      reply_markup: { inline_keyboard: [OFFICIAL_BUTTON] } };
  }
  const text = [
    closest[0].km > 30
      ? `The nearest free N95 mask point is ${formatDistance(closest[0].km)} from ${label}. These points are in Singapore only.`
      : `Nearest free N95 mask points to ${label}`,
    "",
    ...closest.flatMap((site, i) => [
      `${i + 1}. ${site.name} — ${formatDistance(site.km)}`,
      `${MASK_KINDS[site.kind]} • ${MASK_STOCK[site.stock]}`,
      site.postal ? `${site.address}, Singapore ${site.postal}` : site.address,
      ...[site.spot, site.hours].filter(Boolean),
      ""
    ]),
    ELIGIBILITY,
    ...stockLines(masks, now)
  ].join("\n");
  const rows = closest.map(site => [{ text: `Directions: ${site.name}`, url: directionsUrl(site) }]);
  if (appUrl) rows.push([{ text: "Open the mask finder ↗", url: new URL("#masks", appUrl).href }]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

// Resolves to { text, reply_markup? } for /masks, or for a location shared after plain /masks.
export async function masksCommand({ location, argument, isPrivate, masks, appUrl, now = Date.now() }) {
  if (!masks?.sites.length) {
    const listed = masks && (masks.sources.cc || masks.sources.vending);
    return {
      text: listed
        ? `No free N95 mask collection points are listed right now. Check HazeMaskGoWhere for updates: ${MASK_FINDER_URL}`
        : `Couldn’t load the free N95 mask list right now. Find collection points on HazeMaskGoWhere: ${MASK_FINDER_URL}`,
      reply_markup: { inline_keyboard: [OFFICIAL_BUTTON] }
    };
  }
  return nearbyCommand({ command: "masks", things: "free N95 mask points", short: "mask points", count: COUNT, location, argument, isPrivate,
    reply: (origin, label) => masksReply({ origin, label, masks, appUrl, now }) });
}
```

- [ ] **Step 7: Add `masks` to the bot menu**

In `src/telegram.js`, replace:

```js
  { command: "shelter", description: "Nearest haze shelters; share your location or add a postal code" },
```

with:

```js
  { command: "shelter", description: "Nearest haze shelters; share your location or add a postal code" },
  { command: "masks", description: "Nearest free N95 mask points; share your location or add a postal code" },
```

- [ ] **Step 8: Route `/masks` in `src/worker.js`**

Add this after `import { shelterCommand } from "./shelters.js";`:

```js
import { masksCommand } from "./masks.js";
```

Replace the `HELP` constant with:

```js
const HELP = "Welcome to Hazey ☁️\n\nGet the latest NEA air quality readings for Singapore, and find the nearest haze shelters and free N95 mask points.\n\n/psi — 24-hour PSI, all regions\n/psi north — PSI for one region\n/pm25 — 1-hour PM2.5, all regions\n/pm25 north — PM2.5 for one region\n/shelter — nearest haze shelters to your location\n/shelter 530572 — haze shelters near a postal code\n/masks — free N95 mask points near your location\n/masks 530572 — mask points near a postal code\n\nRegions: north, south, east, west, central.\n/help — these commands\n\nReadings refresh every 5 minutes; NEA publishes the underlying readings on its own schedule.";
```

Add these directly above `async function handleTelegram(request, env, ctx) {`:

```js
const LOCATION_REQUEST_TTL = 10 * 60_000;

// A shared location answers plain /masks sent in the last ten minutes; otherwise it finds shelters.
async function locationCommand(env, chatId) {
  const request = await env.PSI_DB.prepare("SELECT kind FROM bot_location_requests WHERE chat_id = ? AND expires_at > ?").bind(chatId, Date.now()).first();
  return request ? "masks" : "shelter";
}

// Only the chat ID is kept, never a location. Offering the location button for /masks records the request;
// answering a location, or plain /shelter, clears it so the latest request wins.
function locationRequest(env, chatId, command, argument, reply) {
  if (command === "masks" && reply.reply_markup?.keyboard) {
    return [env.PSI_DB.prepare(
      "INSERT INTO bot_location_requests (chat_id, kind, expires_at) VALUES (?, 'masks', ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET kind = excluded.kind, expires_at = excluded.expires_at"
    ).bind(chatId, Date.now() + LOCATION_REQUEST_TTL)];
  }
  if ((command === "masks" || command === "shelter") && !argument) {
    return [env.PSI_DB.prepare("DELETE FROM bot_location_requests WHERE chat_id = ?").bind(chatId)];
  }
  return [];
}
```

In `handleTelegram`, replace:

```js
  // A location shared in a private chat asks for the nearest shelters; locations in groups are ignored.
  const { latitude, longitude } = message.location ?? {};
  const location = isPrivate && Number.isFinite(latitude) && Number.isFinite(longitude) ? { lat: latitude, lng: longitude } : null;
  const parsed = parseCommand(message.text, env.TELEGRAM_BOT_USERNAME) ?? (location && { command: "shelter", argument: "" });
  if (!parsed) return json({ ok: true });
  const { command, argument } = parsed;
  if (!["start", "help", "psi", "pm25", "shelter"].includes(command) && !isPrivate) return json({ ok: true });
```

with:

```js
  // A location shared in a private chat finds shelters, or mask points after plain /masks; locations in groups are ignored.
  const { latitude, longitude } = message.location ?? {};
  const location = isPrivate && Number.isFinite(latitude) && Number.isFinite(longitude) ? { lat: latitude, lng: longitude } : null;
  const parsed = parseCommand(message.text, env.TELEGRAM_BOT_USERNAME) ?? (location && { command: await locationCommand(env, message.chat.id), argument: "" });
  if (!parsed) return json({ ok: true });
  const { argument } = parsed;
  const command = parsed.command === "mask" ? "masks" : parsed.command;
  if (!["start", "help", "psi", "pm25", "shelter", "masks"].includes(command) && !isPrivate) return json({ ok: true });
```

Replace:

```js
      reply = await shelterCommand({ location, argument, isPrivate, regions: snapshot && !isStale(snapshot) ? snapshot.regions : null, appUrl });
    }
```

with:

```js
      reply = await shelterCommand({ location, argument, isPrivate, regions: snapshot && !isStale(snapshot) ? snapshot.regions : null, appUrl });
    } else if (command === "masks") {
      // The saved HazeMaskGoWhere list; replies never wait for a refresh.
      const masks = await loadMasks(env).catch(() => null);
      reply = await masksCommand({ location, argument, isPrivate, masks, appUrl });
    }
```

Replace:

```js
    await env.PSI_DB.prepare("UPDATE telegram_updates SET state = 'sent' WHERE update_id = ?").bind(update.update_id).run();
    return json({ ok: true });
```

with:

```js
    await env.PSI_DB.batch([
      env.PSI_DB.prepare("UPDATE telegram_updates SET state = 'sent' WHERE update_id = ?").bind(update.update_id),
      ...locationRequest(env, message.chat.id, command, argument, reply)
    ]);
    return json({ ok: true });
```

In `scheduled`, replace:

```js
      env.PSI_DB.prepare("DELETE FROM telegram_updates WHERE received_at < ?").bind(Date.now() - 7 * 24 * 60 * 60_000).run()
```

with:

```js
      env.PSI_DB.prepare("DELETE FROM telegram_updates WHERE received_at < ?").bind(Date.now() - 7 * 24 * 60 * 60_000).run(),
      env.PSI_DB.prepare("DELETE FROM bot_location_requests WHERE expires_at <= ?").bind(Date.now()).run()
```

- [ ] **Step 9: Run the tests to make sure they pass**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add migrations/0005_mask_sites.sql src/nearby.js src/masks.js src/shelters.js src/telegram.js src/worker.js tests/worker.test.js
git commit -m "Add /masks to the bot: nearest free N95 mask points by location or postal code"
```

---

### Task 4: Channel posts point to free masks while distribution is running

**Files:**
- Modify: `src/broadcast.js`
- Modify: `tests/worker.test.js`

**Interfaces:**
- Consumes: `loadMasks(env, now)` (Task 2), and `maskPlaces` and `MASK_SHORT_URL` (Task 1).
- Produces: `channelMessage(snapshot, kind, { appUrl, botUsername, masks }, now)`, where `masks` is optional `loadMasks` output.

- [ ] **Step 1: Write the failing test**

Append to `tests/worker.test.js`:

```js
test("channel posts point to free N95 masks while distribution is running, at any PSI level, and stop when the list goes stale", async t => {
  const { tick, messages } = channelHarness(t);
  t.mock.method(console, "error", () => {});
  const masks = { cc: ccFile(), vending: vendingFile() };
  await tick("2026-10-14T05:55:00+08:00", 150, { masks }); // saves the list; nothing is due
  await tick("2026-10-14T06:00:00+08:00", 150, { masks });
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /\n\nFree N95 masks:\nEligible groups can collect free N95 masks at 4 CC counters and 1 vending machine with stock now\.\nFind one: https:\/\/hazey\.example\/#masks or send \/masks to @hazey_psi_bot\nOfficial list: go\.gov\.sg\/hazemask\n\nMOH guidance/);
  assert.deepEqual(messages[0].reply_markup.inline_keyboard.map(row => row[0].url), ["https://hazey.example", "https://hazey.example/#masks"]);
  await tick("2026-10-14T06:20:00+08:00", 220, { masks });
  assert.match(messages[1].text, /Haze shelters:[\s\S]*Free N95 masks:/);
  assert.deepEqual(messages[1].reply_markup.inline_keyboard.map(row => row[0].url), ["https://hazey.example", "https://hazey.example/#shelters", "https://hazey.example/#masks"]);
  await tick("2026-10-14T07:00:00+08:00", 220, { masksDown: true }); // last saved at 06:20, 40 minutes ago
  assert.equal(messages.length, 3);
  assert.doesNotMatch(messages[2].text, /Free N95 masks/);
  assert.equal(messages[2].reply_markup.inline_keyboard.length, 2);
});
```

- [ ] **Step 2: Run the test to make sure it fails**

Run: `node --test tests/worker.test.js`
Expected: FAIL in the new test (no "Free N95 masks" block). Everything else passes.

- [ ] **Step 3: Add the block to `src/broadcast.js`**

Replace the import lines:

```js
import { category, regionList, shelterNotice, singaporeTime } from "../public/psi.js";
import { isStale } from "./psi.js";
import { telegramApi } from "./telegram.js";
```

with:

```js
import { category, regionList, shelterNotice, singaporeTime } from "../public/psi.js";
import { MASK_SHORT_URL, maskPlaces } from "../public/masks.js";
import { isStale } from "./psi.js";
import { loadMasks } from "./mask-data.js";
import { telegramApi } from "./telegram.js";
```

Replace:

```js
// Above 200 (NEA's trigger for opening haze shelters) the post also points to the shelter finder.
export function channelMessage(snapshot, kind, { appUrl = null, botUsername = null } = {}, now = Date.now()) {
```

with:

```js
// Above 200 (NEA's trigger for opening haze shelters) the post also points to the shelter finder. While free N95
// masks are being given out (`masks.active`, from loadMasks), it points to the mask finder at any PSI level.
export function channelMessage(snapshot, kind, { appUrl = null, botUsername = null, masks = null } = {}, now = Date.now()) {
```

Replace:

```js
    lines.push("Call the centre before you go to confirm the room and its opening hours.");
  }
```

with:

```js
    lines.push("Call the centre before you go to confirm the room and its opening hours.");
  }
  if (masks?.active) {
    const find = [appUrl && new URL("#masks", appUrl).href, botUsername && `send /masks to @${botUsername}`].filter(Boolean);
    lines.push("", "Free N95 masks:", `Eligible groups can collect free N95 masks at ${maskPlaces(masks.inStock)} with stock now.`);
    if (find.length) lines.push(`Find one: ${find.join(" or ")}`);
    lines.push(`Official list: ${MASK_SHORT_URL}`);
  }
```

In `broadcastChannel`, replace:

```js
      const reply = { chat_id: channel, text: channelMessage(snapshot, breach ? "breach" : active ? "hourly" : "regular", { appUrl, botUsername }, now),
        link_preview_options: { is_disabled: true } };
      if (appUrl) {
        reply.reply_markup = { inline_keyboard: [[{ text: "View Hazey dashboard", url: appUrl }]] };
        if (high > 200) reply.reply_markup.inline_keyboard.push([{ text: "Find a haze shelter", url: new URL("#shelters", appUrl).href }]);
      }
```

with:

```js
      // A mask list that can't be read never blocks the post.
      const masks = await loadMasks(env, now).catch(() => null);
      const reply = { chat_id: channel, text: channelMessage(snapshot, breach ? "breach" : active ? "hourly" : "regular", { appUrl, botUsername, masks }, now),
        link_preview_options: { is_disabled: true } };
      if (appUrl) {
        reply.reply_markup = { inline_keyboard: [[{ text: "View Hazey dashboard", url: appUrl }]] };
        if (high > 200) reply.reply_markup.inline_keyboard.push([{ text: "Find a haze shelter", url: new URL("#shelters", appUrl).href }]);
        if (masks?.active) reply.reply_markup.inline_keyboard.push([{ text: "Find free N95 masks", url: new URL("#masks", appUrl).href }]);
      }
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test`
Expected: all tests pass. The existing channel tests are unchanged because their mask list is empty.

- [ ] **Step 5: Commit**

```bash
git add src/broadcast.js tests/worker.test.js
git commit -m "Point channel posts to free N95 masks while distribution is running"
```

---

### Task 5: Dashboard mask section, shared finder and hero link

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`
- Modify: `scripts/check-browser.js`

**Interfaces:**
- Consumes:
  - `GET /api/masks` (Task 2)
  - `MASK_KINDS`, `MASK_STOCK`, `collectable`, `maskPlaces`, `stockUpdatedAt` from `public/masks.js` (Task 1)
  - the existing `/api/postal`
- Produces:
  - DOM IDs: `#masks`, `#masks-meta`, `#mask-status`, `#mask-locate-button`, `#mask-postal-form`, `#mask-postal-input`, `#mask-postal-button`, `#mask-results`, `#mask-message`, `#mask-list`, `#mask-eligibility` and `#mask-jump`.
  - Shared classes: `place-*`, `hero-jump` and `eligibility*`.

- [ ] **Step 1: Rename the shared finder classes**

Run:

```bash
perl -pi -e 's/\.shelter-jump/.hero-jump/g; s/\.shelter(?=[-\s,{.:\[])/.place/g' public/styles.css
perl -pi -e 's/class="shelter-jump"/class="hero-jump"/; s/class="shelter-/class="place-/g' public/index.html
perl -pi -e "s/\.shelter-name/#shelter-list .place-name/g; s/\.shelter-distance/#shelter-list .place-distance/g" scripts/check-browser.js
grep -n "shelter" public/styles.css
```

Expected: the only remaining `shelter` matches in `styles.css` are `.overview, .shelters …` (two lines) and the `/* Haze shelters */` comment. IDs such as `id="shelter-status"` are unchanged.

- [ ] **Step 2: Add the markup in `public/index.html`**

Replace the meta description with:

```html
  <meta name="description" content="Live NEA 24-hour PSI and 1-hour PM2.5 for Singapore’s north, south, east, west, and central regions, with 24-hour trends, the nearest community haze shelters and free N95 mask collection points.">
```

Replace:

```html
          <p class="hero-jump" id="shelter-jump" hidden><a href="#shelters">Find a haze shelter near you</a></p>
```

with:

```html
          <p class="hero-jump" id="shelter-jump" hidden><a href="#shelters">Find a haze shelter near you</a></p>
          <p class="hero-jump" id="mask-jump" hidden><a href="#masks">Find free N95 masks near you</a></p>
```

In the shelters section, replace:

```html
            <p class="place-privacy">Your location stays on this device. Postal codes are looked up with OneMap and aren’t stored.</p>
```

with:

```html
            <p class="place-privacy">Your location stays on this device. Postal codes are looked up with OneMap and aren’t stored. One search fills both the shelter and mask lists.</p>
```

Directly after the shelters section's closing `</section>`, before `<section class="telegram" …>`, insert:

```html
      <section class="masks" id="masks" aria-labelledby="masks-title">
        <div class="section-head">
          <div>
            <h2 id="masks-title">Free N95 masks near you</h2>
            <p class="section-meta" id="masks-meta">Collection points from HazeMaskGoWhere, the government’s mask locator</p>
          </div>
        </div>
        <div class="place-layout">
          <div class="place-intro">
            <p class="place-status" id="mask-status" data-band="unknown">Loading mask collection points</p>
            <div class="place-finder">
              <button class="primary-button" id="mask-locate-button" type="button">Use my location</button>
              <form class="postal-form" id="mask-postal-form" novalidate>
                <label for="mask-postal-input">Or enter a postal code</label>
                <div class="postal-row">
                  <input id="mask-postal-input" name="postal" type="text" inputmode="numeric" autocomplete="postal-code" placeholder="6 digits" spellcheck="false" aria-describedby="mask-message">
                  <button class="ghost-button" id="mask-postal-button" type="submit">Find</button>
                </div>
              </form>
            </div>
            <p class="place-privacy">Your location stays on this device. Postal codes are looked up with OneMap and aren’t stored. One search fills both the shelter and mask lists.</p>
          </div>
          <div class="place-results is-empty" id="mask-results">
            <p class="place-message" id="mask-message" role="status">Loading mask collection points</p>
            <ol class="place-list" id="mask-list"></ol>
          </div>
        </div>
        <div class="eligibility" id="mask-eligibility">
          <h3>Who can collect</h3>
          <div class="eligibility-groups">
            <div>
              <p class="eligibility-where">At a CC counter or a vending machine</p>
              <ul>
                <li>Pioneer and Merdeka Generation</li>
                <li>CHAS Blue and Orange cardholders</li>
                <li>Medical Fee Exemption Card holders</li>
                <li>ComCare recipients</li>
              </ul>
            </div>
            <div>
              <p class="eligibility-where">At CC counters only</p>
              <ul>
                <li>Pregnant women</li>
                <li>Children aged 7 to 16</li>
                <li>People with medical conditions such as asthma</li>
              </ul>
            </div>
          </div>
          <p class="eligibility-note">Bring the eligible person’s NRIC; someone else can collect on their behalf. Each pack has two masks. As announced by NEA on 14 October 2026; see the <a href="https://www.gowhere.gov.sg/hazemask/faq" target="_blank" rel="noopener noreferrer">official FAQ</a>.</p>
        </div>
        <p class="place-note">Out-of-stock points and vending machines that are out of service are left out. Distances are in a straight line. <a href="https://www.gowhere.gov.sg/hazemask" target="_blank" rel="noopener noreferrer">Check live stock on HazeMaskGoWhere ↗</a></p>
      </section>
```

In the footer, after the haze shelter credit paragraph, add:

```html
      <p class="footer-credit">Free N95 mask collection points and stock from <a href="https://www.gowhere.gov.sg/hazemask" target="_blank" rel="noopener noreferrer">HazeMaskGoWhere</a>, Government of Singapore.</p>
```

- [ ] **Step 3: Add the styles in `public/styles.css`**

Replace:

```css
.overview, .shelters { margin-top: clamp(40px, 5vw, 56px); padding-top: clamp(28px, 4vw, 44px); border-top: 1px solid var(--line); }
.overview .section-head, .shelters .section-head { margin-bottom: 14px; }
```

with:

```css
.overview, .shelters, .masks { margin-top: clamp(40px, 5vw, 56px); padding-top: clamp(28px, 4vw, 44px); border-top: 1px solid var(--line); }
.overview .section-head, .shelters .section-head, .masks .section-head { margin-bottom: 14px; }
```

Replace:

```css
/* Haze shelters */
.hero-jump { margin-top: 18px; font-size: 14px; font-weight: 600; }
```

with:

```css
/* Haze shelters and free N95 mask points share one finder */
.hero-jump { margin-top: 18px; font-size: 14px; font-weight: 600; }
.hero-jump:not([hidden]) ~ .hero-jump { margin-top: 6px; }
```

After the `.place-name { … }` line, add:

```css
.place-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 4px; font-size: 12.5px; color: var(--muted); }
```

After the `.place-note { … }` line, add:

```css
.eligibility { margin-top: 28px; padding: 18px 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--sunken); }
.eligibility h3 { font: 600 15px/1.3 var(--sans); letter-spacing: -0.005em; }
.eligibility-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 32px; margin-top: 12px; }
.eligibility-where { margin-bottom: 4px; font-size: 13px; font-weight: 600; color: var(--ink-2); }
.eligibility ul { margin: 0; padding-left: 18px; font-size: 14px; line-height: 1.55; color: var(--ink-2); }
.eligibility-note { margin-top: 12px; max-width: 72ch; font-size: 13px; color: var(--muted); }
```

In the `@media (max-width: 640px)` block, after `.place { align-items: start; padding: 12px 14px; }`, add:

```css
  .eligibility { padding: 16px; }
  .eligibility-groups { grid-template-columns: 1fr; }
```

- [ ] **Step 4: Update `public/app.js`**

Add this after the `import { SHELTER_KINDS, … } from "./geo.js";` line:

```js
import { MASK_KINDS, MASK_STOCK, collectable, maskPlaces, stockUpdatedAt } from "./masks.js";
```

Replace the `state` object with:

```js
const state = {
  data: null, history: null, historyKey: "", loading: false, mapReady: false,
  metric: storage.get("hazey-metric") === "pm25" ? "pm25" : "psi", newUntil: 0,
  // `masks` is undefined until /api/masks first answers, then null if it never could. `nearby` is the latest search.
  masks: undefined, nearby: null
};
```

Replace everything from `/* ---------- Haze shelters ---------- */` up to, but not including, `/* ---------- Loading ---------- */` with:

```js
/* ---------- Nearby: haze shelters and free N95 mask points ---------- */
// One search, by device location or postal code, fills both lists. Locations never leave the browser.

byId("shelters-meta").textContent = `Air-conditioned rooms at ${SHELTERS.length} community clubs and residents’ centres, from the People’s Association list as at ${SHELTERS_AS_AT}`;

function renderShelterStatus() {
  const regions = state.data?.regions ?? [];
  const status = byId("shelter-status");
  if (!regions.length) return;
  const highest = Math.max(...regions.map(region => region.psi));
  const where = regionList(regions.filter(region => region.psi === highest).map(region => region.key));
  status.dataset.band = category(highest).key;
  status.textContent = shelterNotice(highest, where);
  byId("shelter-jump").hidden = highest <= 200;
}

// `prefix` is "shelter" or "mask", naming the section's message, list and results elements.
function setResults(prefix, text, items = []) {
  byId(`${prefix}-message`).textContent = text;
  byId(`${prefix}-list`).replaceChildren(...items);
  byId(`${prefix}-results`).classList.toggle("is-empty", !items.length);
}

// A result with its distance and directions. `meta` is an optional line under the name; `details` follow the address.
function placeItem(place, details, meta = null) {
  const item = Object.assign(document.createElement("li"), { className: "place" });
  const body = Object.assign(document.createElement("div"), { className: "place-body" });
  body.append(Object.assign(document.createElement("h3"), { className: "place-name", textContent: place.name }));
  if (meta) body.append(meta);
  body.append(Object.assign(document.createElement("p"), { className: "place-address", textContent: place.postal ? `${place.address}, Singapore ${place.postal}` : place.address }));
  for (const text of details) body.append(Object.assign(document.createElement("p"), { className: "place-kind", textContent: text }));
  const side = Object.assign(document.createElement("div"), { className: "place-side" });
  const link = Object.assign(document.createElement("a"), {
    className: "place-link", textContent: "Directions", target: "_blank", rel: "noopener noreferrer",
    href: directionsUrl(place)
  });
  link.append(Object.assign(document.createElement("span"), { className: "sr-only", textContent: ` to ${place.name} in Google Maps` }));
  side.append(Object.assign(document.createElement("p"), { className: "place-distance", textContent: formatDistance(place.km) }), link);
  item.append(body, side);
  return item;
}

function showShelters(origin, label) {
  const closest = nearest(origin, SHELTERS, 5);
  setResults("shelter", closest[0].km > 30
    ? `The nearest shelter is ${formatDistance(closest[0].km)} from ${label}. These shelters are in Singapore only.`
    : `Nearest to ${label}`, closest.map(shelter => placeItem(shelter, [SHELTER_KINDS[shelter.kind]])));
}

const STOCK_TONES = { in: "good", limited: "moderate", unknown: "unknown" };

function maskItem(site) {
  const meta = Object.assign(document.createElement("p"), { className: "place-meta" });
  const badge = Object.assign(document.createElement("span"), { className: "badge", textContent: MASK_STOCK[site.stock] });
  badge.dataset.band = STOCK_TONES[site.stock] ?? "unknown";
  meta.append(badge, MASK_KINDS[site.kind]);
  return placeItem(site, [site.spot, site.hours].filter(Boolean), meta);
}

const masksListed = masks => Boolean(masks && (masks.sources.cc || masks.sources.vending));

function renderMasks() {
  const masks = state.masks;
  const status = byId("mask-status");
  byId("mask-jump").hidden = !masks?.active;
  status.dataset.band = masks?.active ? "good" : "unknown";
  if (!masksListed(masks)) {
    status.textContent = "Couldn’t load the mask list right now. HazeMaskGoWhere has the official list of collection points.";
  } else {
    const counts = { cc: 0, vending: 0 };
    for (const site of masks.sites) counts[site.kind]++;
    if (masks.sites.length) byId("masks-meta").textContent = `${maskPlaces(counts)}, from HazeMaskGoWhere`;
    const stale = Object.values(masks.sources).filter(source => source?.stale);
    const updated = singaporeClock(stockUpdatedAt(masks.sources));
    const open = masks.inStock.cc + masks.inStock.vending;
    status.textContent = stale.length
      ? `Stock may be out of date: Hazey last checked at ${singaporeClock(Math.min(...stale.map(source => Date.parse(source.fetchedAt))))}. Check live stock on HazeMaskGoWhere before you go.`
      : !masks.sites.length ? "No collection points are listed right now."
      : open ? `Stock updated ${updated}: ${maskPlaces(masks.inStock)} ${open === 1 ? "has" : "have"} masks.`
      : `Stock updated ${updated}: none of the listed points has masks right now.`;
  }
  renderMaskResults();
}

function renderMaskResults() {
  const { masks, nearby } = state;
  if (nearby?.message) return setResults("mask", nearby.message);
  if (masks === undefined) return setResults("mask", "Loading mask collection points");
  if (!masksListed(masks)) return setResults("mask", "Couldn’t load the mask list right now. Check HazeMaskGoWhere for collection points.");
  if (!nearby) return setResults("mask", "Your five nearest mask points with stock will appear here.");
  const closest = nearest(nearby.origin, masks.sites.filter(collectable), 5);
  if (!closest.length) return setResults("mask", "None of the listed mask points has stock right now.");
  setResults("mask", closest[0].km > 30
    ? `The nearest mask point is ${formatDistance(closest[0].km)} from ${nearby.label}. These points are in Singapore only.`
    : `Nearest with stock to ${nearby.label}`, closest.map(maskItem));
}

// `nearby` is { message } while a search is busy or after it fails, or { origin, label } once it succeeds.
function setNearby(nearby) {
  state.nearby = nearby;
  if (nearby.origin) showShelters(nearby.origin, nearby.label);
  else setResults("shelter", nearby.message);
  renderMaskResults();
}

const finders = ["", "mask-"].map(prefix => ({
  locate: byId(`${prefix}locate-button`), form: byId(`${prefix}postal-form`),
  input: byId(`${prefix}postal-input`), submit: byId(`${prefix}postal-button`)
}));

function setFinderBusy(busy) {
  for (const finder of finders) finder.locate.disabled = finder.submit.disabled = busy;
}

function locate() {
  if (!navigator.geolocation) {
    setNearby({ message: "This browser can’t share your location. Enter a postal code instead." });
    return;
  }
  setFinderBusy(true);
  setNearby({ message: "Finding your location" });
  navigator.geolocation.getCurrentPosition(position => {
    setFinderBusy(false);
    setNearby({ origin: { lat: position.coords.latitude, lng: position.coords.longitude }, label: "your location" });
  }, error => {
    setFinderBusy(false);
    setNearby({ message: error.code === error.PERMISSION_DENIED
      ? "Location access is off for this site. Enter a postal code instead."
      : "Couldn’t get your location. Try again, or enter a postal code." });
  }, { enableHighAccuracy: false, timeout: 15_000, maximumAge: 5 * 60_000 });
}

async function searchPostal(finder) {
  const value = finder.input.value;
  const code = value.replace(/\s/g, "");
  // Both boxes show the same search.
  for (const other of finders) other.input.value = value;
  if (!/^\d{6}$/.test(code)) {
    for (const other of finders) other.input.setAttribute("aria-invalid", "true");
    setNearby({ message: "Enter a six-digit postal code." });
    finder.input.focus();
    return;
  }
  for (const other of finders) other.input.removeAttribute("aria-invalid");
  setFinderBusy(true);
  setNearby({ message: `Looking up ${code}` });
  try {
    const response = await fetch(`/api/postal?code=${code}`, { signal: AbortSignal.timeout(12_000) });
    if (response.status === 404) {
      setNearby({ message: `Couldn’t find postal code ${code}. Check the number and try again.` });
      return;
    }
    if (!response.ok) throw new Error("Lookup unavailable");
    const place = await response.json();
    if (!Number.isFinite(place?.lat) || !Number.isFinite(place?.lng)) throw new Error("Invalid lookup");
    setNearby({ origin: place, label: `postal code ${code}` });
  } catch {
    setNearby({ message: "Postal code lookup is unavailable right now. Use your location, or try again shortly." });
  } finally {
    setFinderBusy(false);
  }
}

for (const finder of finders) {
  finder.locate.addEventListener("click", locate);
  finder.form.addEventListener("submit", event => {
    event.preventDefault();
    searchPostal(finder);
  });
}

```

In the Loading section, add these directly after the `validSnapshot` function:

```js
function validMasks(data) {
  return Array.isArray(data?.sites) && typeof data.active === "boolean" && Boolean(data.sources) && Boolean(data.inStock);
}

// Mask points load on their own; a failure keeps the last loaded list and never affects the readings.
async function loadMaskPoints() {
  try {
    const response = await fetch("/api/masks", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Mask points unavailable");
    const data = await response.json();
    if (!validMasks(data)) throw new Error("Invalid mask points");
    state.masks = data;
  } catch {
    state.masks ??= null;
  }
  renderMasks();
}
```

At the end of the file, after the final `load();`, add:

```js
loadMaskPoints();
setInterval(() => { if (!document.hidden) loadMaskPoints(); }, 5 * 60_000);
```

- [ ] **Step 5: Extend the browser check**

In `scripts/check-browser.js`, insert this directly after the `assert.ok(shelterLayout.scrollWidth <= shelterLayout.width, …)` line:

```js
      // Free N95 mask points: the searches above also fill the mask list, and a search there fills the shelters.
      let masks;
      for (let attempt = 0; attempt < 30; attempt++) {
        masks = await evaluate("({ status: document.getElementById('mask-status').textContent, message: document.getElementById('mask-message').textContent, names: Array.from(document.querySelectorAll('#mask-list .place-name'), e => e.textContent), badges: Array.from(document.querySelectorAll('#mask-list .badge'), e => e.textContent), jump: !document.getElementById('mask-jump').hidden, eligibility: document.querySelectorAll('#mask-eligibility li').length, official: Boolean(document.querySelector('#masks a[href=\"https://www.gowhere.gov.sg/hazemask\"]')) })");
        if (!masks.status.startsWith("Loading")) break;
        await delay(400);
      }
      const maskData = await evaluate("fetch('/api/masks', { cache: 'no-store' }).then(response => response.json())");
      const withStock = maskData.sites.filter(site => site.stock !== "out" && site.stock !== "offline").length;
      assert.equal(masks.eligibility, 7, `${viewport.name}: eligibility lists seven groups`);
      assert.ok(masks.official, `${viewport.name}: HazeMaskGoWhere is linked`);
      assert.equal(masks.jump, maskData.active, `${viewport.name}: hero mask link follows distribution`);
      if (withStock) {
        assert.equal(masks.names.length, Math.min(5, withStock), `${viewport.name}: nearest mask points with stock`);
        assert.ok(masks.badges.every(text => ["In stock", "Limited stock", "Stock unknown"].includes(text)), `${viewport.name}: stock badges`);
        assert.match(masks.message, /postal code 089774/, `${viewport.name}: the shelter search also filled the mask list`);
      } else {
        assert.equal(masks.names.length, 0);
        assert.match(masks.message, /Couldn’t load|None of the listed/, `${viewport.name}: an empty mask list says why`);
      }
      await evaluate("document.getElementById('mask-postal-input').value = '530572'; document.getElementById('mask-postal-form').requestSubmit()");
      const fromMasks = await shelters();
      assert.equal(fromMasks.names[0], "Ang Mo Kio-Hougang Pinetree RN", `${viewport.name}: a mask search fills the shelter list too`);
      assert.match(fromMasks.message, /postal code 530572/);
      const maskLayout = await evaluate("({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })");
      assert.ok(maskLayout.scrollWidth <= maskLayout.width, `${viewport.name}: no horizontal overflow with mask results`);
```

In the final `console.log` line, replace `shelter finder (location, postal code, bad input), ` with `shelter finder (location, postal code, bad input), mask finder (${masks.names.length} points), `.

- [ ] **Step 6: Run the Node tests**

Run: `npm test`
Expected: all tests pass (no Worker changes in this task).

- [ ] **Step 7: Run the browser check locally**

```bash
npm run db:local
npx wrangler dev --test-scheduled --port 8787
```

In a second terminal, run the scheduled job once so local D1 has real mask points and readings:

```bash
curl -s -X POST "http://127.0.0.1:8787/cdn-cgi/local/explorer/api/local/scheduled?worker=hazey" -H "Content-Type: application/json" -d "{\"cron\":\"*/5 * * * *\",\"scheduled_time\":$(date +%s)000}"
curl -s http://127.0.0.1:8787/api/masks | head -c 400
npm run check:browser -- http://127.0.0.1:8787
```

Expected: `/api/masks` shows `sites` with real HazeMaskGoWhere names and both sources present. The browser check prints `desktop: … mask finder (5 points) …` and the same for `mobile`. Open the screenshots it saves in the system temp directory (`hazey-desktop.png`, `hazey-mobile.png`, `-dark` variants) and inspect the `#masks` section in light and dark. Check that badges are readable, the eligibility box sits under the results, the phone layout stacks, and there's no overflow.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/styles.css public/app.js scripts/check-browser.js
git commit -m "Add the free N95 mask finder to the dashboard; one search fills shelters and masks"
```

---

### Task 6: Verify, record and release

**Files:**
- Modify: `HANDOVER.md`

- [ ] **Step 1: Full verification**

```bash
npm test
npx wrangler deploy --dry-run
```

Expected: all tests pass, and the dry run succeeds with a bundle size within a few KiB of 83 KiB. Record the test count.

- [ ] **Step 2: Review the copy from real code**

Print a sample `/masks` reply and a sample channel block from real data:

```bash
node --input-type=module -e '
import { normalizeMaskSites } from "./src/mask-data.js";
import { masksReply } from "./src/masks.js";
import { channelMessage } from "./src/broadcast.js";
const get = async url => (await fetch(url)).json();
const cc = normalizeMaskSites(await get("https://www.gowhere.gov.sg/hazemask/data/data.csv.json"), "cc").sites;
const vending = normalizeMaskSites(await get("https://www.gowhere.gov.sg/hazemask/data/data.webhook.json"), "vending").sites;
const now = new Date().toISOString();
const masks = { sites: [...cc, ...vending], sources: { cc: { fetchedAt: now, updatedAt: now, stale: false }, vending: { fetchedAt: now, updatedAt: now, stale: false } },
  inStock: { cc: cc.filter(s => ["in","limited"].includes(s.stock)).length, vending: vending.filter(s => ["in","limited"].includes(s.stock)).length } };
masks.active = masks.inStock.cc + masks.inStock.vending > 0;
console.log(masksReply({ origin: { lat: 1.37827, lng: 103.88749 }, label: "postal code 530572", masks, appUrl: "https://hazey.gabrieltang515.workers.dev" }).text);
const snapshot = { readingAt: now, regions: ["north","south","east","west","central"].map((key, i) => ({ key, name: key[0].toUpperCase() + key.slice(1), psi: 150 + i })), pm25: null };
console.log("\n---\n" + channelMessage(snapshot, "regular", { appUrl: "https://hazey.gabrieltang515.workers.dev", botUsername: "hazey_sg_bot", masks }));
'
```

Expected: the reply lists three nearby real points with stock, and the channel post has the "Free N95 masks:" block with real counts. Read both for wording.

- [ ] **Step 3: Update `HANDOVER.md`**

Add a new top section, "Free N95 mask finder — built 17 October 2026", following the style of the existing release sections. It should cover:
- **Source:** the HazeMaskGoWhere files, with the caveat that they are unpublished, and the terms of use the owner still has to check.
- **Data path:** the D1 tables (`mask_sources`, `bot_location_requests`), `/api/masks`, staleness at 30 minutes and the `active` rule.
- **Bot:** `/masks` and `/mask`, the 10-minute pending location request (chat ID only), and the hourly menu sync that picks up `masks`.
- **Channel:** the "Free N95 masks" block and button while `active`.
- **Dashboard:** the `#masks` section, the shared finder and the hero link.
- **Verification:** test count, dry run, local browser check and screenshots reviewed.

Update:
- the status line at the top
- the "Remaining steps" list: add "Confirm `/masks` in Telegram (owner)" with `/masks 530572` and plain `/masks` plus Share location
- the resources table: migrations `0001`–`0005` once applied
- the Architecture bullets for `/api/masks` and the Telegram commands

- [ ] **Step 4: Commit and push the branch**

```bash
git add HANDOVER.md
git commit -m "Record free N95 mask finder build in handover"
git push -u origin mask-finder
```

- [ ] **Step 5: Ask the owner to approve deployment**

Show the screenshots and the sample bot and channel texts. Deploy only after the owner says yes.

- [ ] **Step 6: Deploy (after approval)**

```bash
npx wrangler d1 migrations apply PSI_DB --remote   # applies 0005_mask_sites.sql before the code that needs it
npx wrangler deploy
```

Then:
- after the next five-minute cron, `curl -s https://hazey.gabrieltang515.workers.dev/api/masks | head -c 300` shows both sources
- `npx wrangler tail hazey` shows no `Mask site refresh failed` lines
- `npm run check:browser -- https://hazey.gabrieltang515.workers.dev` passes at both widths
- `curl -sI https://hazey.gabrieltang515.workers.dev/ | grep -i content-security` shows the unchanged CSP

- [ ] **Step 7: Record the deployment and merge**

Update `HANDOVER.md` with the deployed version ID, the production checks and the time of the first mask refresh. Commit, then fast-forward `main` to the branch and push both:

```bash
git add HANDOVER.md
git commit -m "Record free N95 mask finder deployment in handover"
git switch main && git merge --ff-only mask-finder && git push origin main mask-finder
```

Don't describe `/masks` as verified live until the owner confirms a real reply in Telegram.
