// Free N95 mask distribution, shared by the dashboard, the Telegram bot and the channel. Collection points and
// stock come from HazeMaskGoWhere, the government's mask locator (NEA haze situation update, 14 October 2026).
export const MASK_FINDER_URL = "https://www.gowhere.gov.sg/hazemask";
export const MASK_SHORT_URL = "go.gov.sg/hazemask";

// A source not refreshed for this long is stale.
export const MASK_STALE_AFTER = 30 * 60_000;

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

// { cc, vending } counts of a list of sites.
export function maskCounts(sites) {
  const counts = { cc: 0, vending: 0 };
  for (const site of sites) counts[site.kind]++;
  return counts;
}
