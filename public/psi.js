export const REGIONS = ["north", "south", "east", "west", "central"];
export const SOURCE_URL = "https://data.gov.sg/datasets/d_fe37906a0182569d891506e815e819b7/view";

export function category(value) {
  if (!Number.isFinite(value) || value < 0) return { label: "Unavailable", key: "unknown" };
  if (value <= 50) return { label: "Good", key: "good" };
  if (value <= 100) return { label: "Moderate", key: "moderate" };
  if (value <= 200) return { label: "Unhealthy", key: "unhealthy" };
  if (value <= 300) return { label: "Very unhealthy", key: "very-unhealthy" };
  return { label: "Hazardous", key: "hazardous" };
}

export function regionName(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function singaporeTime(timestamp) {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true
  }).format(new Date(timestamp));
}
