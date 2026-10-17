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
