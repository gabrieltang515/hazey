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
