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

// "the West region", "the North and Central regions", "the North, West and Central regions", "all five regions".
export function regionList(keys) {
  if (keys.length === REGIONS.length) return "all five regions";
  const names = keys.map(regionName);
  const joined = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `the ${joined} region${names.length > 1 ? "s" : ""}`;
}

// NEA's community haze shelter arrangements (NEA release, 9 October 2026): air-conditioned rooms at community
// clubs and selected RC and RN centres open when the 24-hour PSI is above 200, and community club shelters stay
// open until 10 pm when it is Hazardous. `highest` is the highest regional 24-hour PSI, `where` its regionList.
export function shelterNotice(highest, where) {
  if (!Number.isFinite(highest)) return "NEA opens haze shelters when the 24-hour PSI goes above 200.";
  if (highest > 300) return `The 24-hour PSI is ${highest} in ${where}, in the Hazardous range. NEA says haze shelters at community clubs stay open until 10 pm.`;
  if (highest > 200) return `The 24-hour PSI is ${highest} in ${where}, above 200, the level at which NEA opens haze shelters.`;
  return `NEA opens haze shelters when the 24-hour PSI goes above 200. The highest now is ${highest}, in ${where}.`;
}

const sgt = options => new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", ...options });
const fullFormat = sgt({ day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const clockFormat = sgt({ hour: "numeric", minute: "2-digit", hour12: true });
const dayFormat = sgt({ day: "numeric", month: "short" });

export function singaporeTime(timestamp) {
  return fullFormat.format(new Date(timestamp));
}

// "18 Oct, 11:00 am": always dated, for channel posts that are read or forwarded later.
export function singaporeDayTime(timestamp) {
  const date = new Date(timestamp);
  return `${dayFormat.format(date)}, ${clockFormat.format(date)}`;
}

// "6:00 pm" today, or "13 Oct, 11:00 pm" for another Singapore date.
export function singaporeClock(timestamp, now = Date.now()) {
  const date = new Date(timestamp);
  const clock = clockFormat.format(date);
  return dayFormat.format(date) === dayFormat.format(new Date(now)) ? clock : `${dayFormat.format(date)}, ${clock}`;
}
