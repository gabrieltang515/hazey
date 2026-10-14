export const REGIONS = ["north", "south", "east", "west", "central"];
export const SOURCE_URL = "https://data.gov.sg/datasets/d_fe37906a0182569d891506e815e819b7/view";

// NEA's 24-hour PSI bands. `max` is inclusive; the last band is open-ended.
export const PSI_BANDS = [
  { key: "good", label: "Good", range: "0–50", max: 50 },
  { key: "moderate", label: "Moderate", range: "51–100", max: 100 },
  { key: "unhealthy", label: "Unhealthy", range: "101–200", max: 200 },
  { key: "very-unhealthy", label: "Very unhealthy", range: "201–300", max: 300 },
  { key: "hazardous", label: "Hazardous", range: "Above 300", max: Infinity }
];

// NEA's 1-hour PM2.5 concentration bands (µg/m³). The keys reuse the PSI colour tones.
export const PM25_BANDS = [
  { key: "good", label: "Normal", band: "I", range: "0–55", max: 55 },
  { key: "moderate", label: "Elevated", band: "II", range: "56–150", max: 150 },
  { key: "unhealthy", label: "High", band: "III", range: "151–250", max: 250 },
  { key: "very-unhealthy", label: "Very high", band: "IV", range: "251 and above", max: Infinity }
];

const UNKNOWN = { label: "Unavailable", band: "", key: "unknown" };

export function category(value) {
  if (!Number.isFinite(value) || value < 0) return { label: UNKNOWN.label, key: UNKNOWN.key };
  const { label, key } = PSI_BANDS.find(band => value <= band.max);
  return { label, key };
}

export function pm25Band(value) {
  if (!Number.isFinite(value) || value < 0) return UNKNOWN;
  const { label, band, key } = PM25_BANDS.find(entry => value <= entry.max);
  return { label, band, key };
}

export function regionName(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

const sgt = options => new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", ...options });
const fullFormat = sgt({ day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const clockFormat = sgt({ hour: "numeric", minute: "2-digit", hour12: true });
const dayFormat = sgt({ day: "numeric", month: "short" });

export function singaporeTime(timestamp) {
  return fullFormat.format(new Date(timestamp));
}

// "6:00 pm" today, or "13 Oct, 11:00 pm" for another Singapore date.
export function singaporeClock(timestamp, now = Date.now()) {
  const date = new Date(timestamp);
  const clock = clockFormat.format(date);
  return dayFormat.format(date) === dayFormat.format(new Date(now)) ? clock : `${dayFormat.format(date)}, ${clock}`;
}
