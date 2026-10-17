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
