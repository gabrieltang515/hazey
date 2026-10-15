// Postal code lookup for the shelter finder, using OneMap's free search API (Singapore Land Authority).
// Codes are passed through only: never stored, and never written to logs.
export const ONEMAP_SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search";
const SINGAPORE = { south: 1.15, north: 1.48, west: 103.59, east: 104.1 };

export const validPostalCode = code => typeof code === "string" && /^\d{6}$/.test(code);

// Resolves to { postal, lat, lng }, or null when OneMap has no building with exactly this postal code.
export async function lookupPostal(code) {
  if (!validPostalCode(code)) throw new Error("Invalid postal code");
  const response = await fetch(`${ONEMAP_SEARCH_URL}?searchVal=${code}&returnGeom=Y&getAddrDetails=Y&pageNum=1`, {
    headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`OneMap search failed (${response.status})`);
  const body = await response.json();
  const match = Array.isArray(body?.results) ? body.results.find(result => result?.POSTAL === code) : null;
  if (!match) return null;
  const lat = Number(match.LATITUDE), lng = Number(match.LONGITUDE);
  if (!(lat > SINGAPORE.south && lat < SINGAPORE.north && lng > SINGAPORE.west && lng < SINGAPORE.east)) return null;
  return { postal: code, lat, lng };
}
