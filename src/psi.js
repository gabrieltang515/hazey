import { REGIONS, category, regionName, singaporeTime } from "../public/psi.js";

export const API_URL = "https://api-open.data.gov.sg/v2/real-time/api/psi";
export const REFRESH_INTERVAL = 5 * 60_000;

function timestamp(value) {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("NEA returned an invalid timestamp");
  }
  return value;
}

function concentration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizePsi(body, now = Date.now()) {
  if (body?.code !== 0 || !Array.isArray(body.data?.items) || !body.data.items.length) {
    throw new Error("NEA returned no successful PSI reading");
  }
  const items = body.data.items.filter(item => Number.isFinite(Date.parse(item.timestamp)));
  const item = items.reduce((latest, candidate) =>
    !latest || Date.parse(candidate.timestamp) > Date.parse(latest.timestamp) ? candidate : latest, null);
  if (!item) throw new Error("NEA returned no dated PSI reading");
  const readingAt = timestamp(item.timestamp);
  const sourceUpdatedAt = timestamp(item.updatedTimestamp ?? item.timestamp);
  const regions = REGIONS.map(key => {
    const psi = item.readings?.psi_twenty_four_hourly?.[key];
    if (!Number.isInteger(psi) || psi < 0) throw new Error(`NEA returned an invalid PSI for ${key}`);
    return {
      key, name: regionName(key), psi,
      pm25: concentration(item.readings?.pm25_twenty_four_hourly?.[key]),
      pm10: concentration(item.readings?.pm10_twenty_four_hourly?.[key])
    };
  });
  return { readingAt, sourceUpdatedAt, fetchedAt: new Date(now).toISOString(), regions };
}

export function isStale(snapshot, now = Date.now()) {
  return now - Date.parse(snapshot.fetchedAt) > 15 * 60_000 || now - Date.parse(snapshot.readingAt) > 2 * 60 * 60_000;
}

export function telegramReading(snapshot, selectedRegion, stale = isStale(snapshot)) {
  const regions = selectedRegion ? snapshot.regions.filter(r => r.key === selectedRegion) : snapshot.regions;
  const lines = regions.map(r => `${r.name}: ${r.psi} — ${category(r.psi).label}`);
  return [
    "Singapore · 24-hour PSI", "", ...lines, "",
    `Reading: ${singaporeTime(snapshot.readingAt)} SGT`,
    ...(stale ? ["⚠️ Showing saved readings. Fresh data is currently delayed."] : []),
    "Source: NEA via data.gov.sg", "", "All regions: /psi · One region: /psi west"
  ].join("\n");
}
