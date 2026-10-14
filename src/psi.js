import { REGIONS, category, pm25Band, regionName, singaporeTime } from "../public/psi.js";

export const API_URL = "https://api-open.data.gov.sg/v2/real-time/api/psi";
export const PM25_API_URL = "https://api-open.data.gov.sg/v2/real-time/api/pm25";
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

function latestItem(body, dataset) {
  if (body?.code !== 0 || !Array.isArray(body.data?.items) || !body.data.items.length) {
    throw new Error(`NEA returned no successful ${dataset} reading`);
  }
  const items = body.data.items.filter(item => Number.isFinite(Date.parse(item.timestamp)));
  const item = items.reduce((latest, candidate) =>
    !latest || Date.parse(candidate.timestamp) > Date.parse(latest.timestamp) ? candidate : latest, null);
  if (!item) throw new Error(`NEA returned no dated ${dataset} reading`);
  return { item, readingAt: timestamp(item.timestamp), sourceUpdatedAt: timestamp(item.updatedTimestamp ?? item.timestamp) };
}

export function normalizePsi(body, now = Date.now()) {
  const { item, readingAt, sourceUpdatedAt } = latestItem(body, "PSI");
  if (Date.parse(readingAt) > now) throw new Error("NEA returned a future PSI observation");
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

// 1-hour PM2.5 is a concentration in µg/m³ from NEA's separate PM2.5 dataset, not a PSI value.
export function normalizePm25(body, now = Date.now()) {
  const { item, readingAt, sourceUpdatedAt } = latestItem(body, "PM2.5");
  if (Date.parse(readingAt) > now) throw new Error("NEA returned a future PM2.5 observation");
  const regions = REGIONS.map(key => {
    const pm25 = item.readings?.pm25_one_hourly?.[key];
    if (!Number.isFinite(pm25) || pm25 < 0) throw new Error(`NEA returned an invalid PM2.5 for ${key}`);
    return { key, name: regionName(key), pm25 };
  });
  return { readingAt, sourceUpdatedAt, fetchedAt: new Date(now).toISOString(), regions };
}

export const HISTORY_FIELDS = { psi: "psi_twenty_four_hourly", pm25: "pm25_one_hourly" };

// Every complete hourly observation in a date-filtered NEA response, for the 24-hour trend charts.
// Incomplete or malformed hours are skipped rather than failing the whole day.
export function historyPoints(body, dataset) {
  if (body?.code !== 0 || !Array.isArray(body.data?.items)) throw new Error(`NEA returned no ${dataset} history`);
  const field = HISTORY_FIELDS[dataset];
  const valid = dataset === "psi" ? Number.isInteger : Number.isFinite;
  return body.data.items.flatMap(item => {
    try {
      const point = { readingAt: timestamp(item.timestamp), sourceUpdatedAt: timestamp(item.updatedTimestamp ?? item.timestamp), values: {} };
      for (const key of REGIONS) {
        const value = item.readings?.[field]?.[key];
        if (!valid(value) || value < 0) return [];
        point.values[key] = value;
      }
      return [point];
    } catch { return []; }
  });
}

export function isStale(snapshot, now = Date.now()) {
  return now - Date.parse(snapshot.fetchedAt) > 15 * 60_000 || now - Date.parse(snapshot.readingAt) > 2 * 60 * 60_000;
}

const pick = (regions, selected) => selected ? regions.filter(r => r.key === selected) : regions;

function psiSection(snapshot, selectedRegion, now) {
  return [
    "Singapore · 24-hour PSI", "",
    ...pick(snapshot.regions, selectedRegion).map(r => `${r.name}: ${r.psi} — ${category(r.psi).label}`),
    "", `Reading: ${singaporeTime(snapshot.readingAt)} SGT`,
    ...(isStale(snapshot, now) ? ["⚠️ Showing saved PSI readings. Fresh data is currently delayed."] : [])
  ];
}

function pm25Section(pm25, selectedRegion, now) {
  if (!pm25) return ["Singapore · 1-hour PM2.5", "", "PM2.5 readings are not available yet. Please try /pm25 again shortly."];
  return [
    "Singapore · 1-hour PM2.5 (µg/m³)", "",
    ...pick(pm25.regions, selectedRegion).map(r => {
      const band = pm25Band(r.pm25);
      return `${r.name}: ${r.pm25} — ${band.label} (Band ${band.band})`;
    }),
    "", `Reading: ${singaporeTime(pm25.readingAt)} SGT`,
    ...(isStale(pm25, now) ? ["⚠️ Showing saved PM2.5 readings. Fresh data is currently delayed."] : [])
  ];
}

export function telegramReading(snapshot, selectedRegion, { dataset = "psi", now = Date.now() } = {}) {
  const pm25 = dataset === "pm25";
  const section = pm25 ? pm25Section(snapshot.pm25, selectedRegion, now) : psiSection(snapshot, selectedRegion, now);
  const hint = pm25 ? "All regions: /pm25 · One region: /pm25 west · PSI: /psi"
    : "All regions: /psi · One region: /psi west · PM2.5: /pm25";
  return [...section, "Source: NEA via data.gov.sg", "", hint].join("\n");
}
