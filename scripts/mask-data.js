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
