// Shelter finder helpers shared by the dashboard and the Telegram bot. On the dashboard these run in the
// browser, so a visitor's location never leaves their device.
const EARTH_DIAMETER_KM = 12_742;

export const SHELTER_KINDS = { cc: "Community club", rc: "Residents’ Committee centre", rn: "Residents’ Network centre" };

// Google Maps directions to a { lat, lng } destination; the starting point is left to the visitor's device.
export const directionsUrl = place => `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;

// Haversine distance between two { lat, lng } points.
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return EARTH_DIAMETER_KM * Math.asin(Math.sqrt(h));
}

// The `count` places closest to `origin`, nearest first, each with its distance as `km`.
export function nearest(origin, places, count = 5) {
  return places.map(place => ({ ...place, km: distanceKm(origin, place) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, count);
}

// "Under 100 m", "350 m", "1.2 km", "12 km".
export function formatDistance(km) {
  if (km < 0.1) return "Under 100 m";
  const metres = Math.round(km * 100) * 10;
  if (metres < 1000) return `${metres} m`;
  const tenths = Math.round(km * 10) / 10;
  return tenths < 10 ? `${tenths.toFixed(1)} km` : `${Math.round(km)} km`;
}
