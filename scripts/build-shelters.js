// Regenerates public/shelters.js from the transcribed People's Association haze shelter list,
// adding coordinates from OneMap's postal code search. Usage: node scripts/build-shelters.js
// When PA publishes a new list, transcribe it to a new CSV in docs/, point SOURCE_CSV at it,
// update LIST_AS_AT and LIST_URL, then rerun this script and the tests.
import { readFile, writeFile } from "node:fs/promises";
import { distanceKm } from "../public/geo.js";

const SOURCE_CSV = new URL("../docs/haze-shelters-2026-09.csv", import.meta.url);
const OUTPUT = new URL("../public/shelters.js", import.meta.url);
const LIST_AS_AT = "September 2026";
const LIST_URL = "https://isomer-user-content.by.gov.sg/101/18b0895f-7ef6-4210-949a-5521b7f31e74/Community%20Haze%20Shelters%20at%20CCs,%20ICHs,%20RCs,%20and%20RNs%202026.pdf";
const SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search";
const SINGAPORE = { south: 1.15, north: 1.48, west: 103.59, east: 104.1 };
// Within a CDC district, every shelter should be this close to the district's median point.
const DISTRICT_RADIUS_KM = 16;
const KINDS = [[/\bCC\b/, "cc"], [/\bRC\b/, "rc"], [/\bRN\b|Residents' Network$/, "rn"]];
// Entries whose published address and postal code disagree, checked against OneMap on 15 October 2026.
// The CSV stays as published; these corrections apply when generating.
const CORRECTIONS = {
  // No block 16 exists on this road; the listed postal code 650116 is block 116.
  "Bukit Batok Zone 1 RN": { address: "116 Bukit Batok West Ave 6" },
  // The listed postal code 792451 is block 451B Sengkang West Way, 0.5 km from the listed block and unit.
  "Fernvale Zone K RN": { postal: "791457" },
  // The listed postal code 792441 is the neighbouring block 441B.
  "Fernvale Zone H RN": { postal: "793441" }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseCsv(text) {
  return text.trim().split("\n").map(line => {
    const cells = [];
    let cell = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quoted && char === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) { cells.push(cell); cell = ""; }
      else cell += char;
    }
    return [...cells, cell];
  });
}

// Retries rate limits, server errors, timeouts and network failures.
async function search(postal) {
  const url = `${SEARCH_URL}?searchVal=${postal}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  for (let attempt = 1; ; attempt++) {
    let failure;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) return (await response.json()).results ?? [];
      failure = `HTTP ${response.status}`;
    } catch (error) {
      failure = error.message;
    }
    if (attempt === 4) throw new Error(`OneMap search for ${postal} failed (${failure})`);
    await delay(3_000 * attempt);
  }
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function main() {
  const [header, ...rows] = parseCsv(await readFile(SOURCE_CSV, "utf8"));
  if (header.join() !== "district,name,address,postal_code") throw new Error("Unexpected CSV header");
  const shelters = [], problems = [], warnings = [];
  const unused = new Set(Object.keys(CORRECTIONS));
  for (const row of rows) {
    const [district, name] = row;
    const { address = row[2], postal = row[3] } = CORRECTIONS[name] ?? {};
    unused.delete(name);
    const kind = KINDS.find(([pattern]) => pattern.test(name))?.[1];
    if (!kind || !/^\d{6}$/.test(postal) || !address) { problems.push(`${name}: invalid row`); continue; }
    const results = (await search(postal)).filter(result => result.POSTAL === postal);
    await delay(300); // OneMap allows about 250 searches a minute.
    const block = address.match(/^(?:Blk\s+|No\.\s*)?(\d+)\s?([A-Z]?)\b/i)?.slice(1).join("").toUpperCase();
    const match = results.find(result => result.BLK_NO.toUpperCase() === block) ?? results[0];
    if (!match) { problems.push(`${name}: no OneMap result for ${postal}`); continue; }
    if (block && match.BLK_NO.toUpperCase() !== block) warnings.push(`${name}: "${address}" resolved to ${match.ADDRESS}`);
    const lat = Math.round(Number(match.LATITUDE) * 1e5) / 1e5, lng = Math.round(Number(match.LONGITUDE) * 1e5) / 1e5;
    if (!(lat > SINGAPORE.south && lat < SINGAPORE.north && lng > SINGAPORE.west && lng < SINGAPORE.east)) {
      problems.push(`${name}: coordinates outside Singapore`);
      continue;
    }
    shelters.push({ name, kind, address, postal, lat, lng, district });
  }

  for (const district of new Set(shelters.map(shelter => shelter.district))) {
    const members = shelters.filter(shelter => shelter.district === district);
    const centre = { lat: median(members.map(s => s.lat)), lng: median(members.map(s => s.lng)) };
    for (const shelter of members) {
      const km = distanceKm(centre, shelter);
      if (km > DISTRICT_RADIUS_KM) problems.push(`${shelter.name}: ${km.toFixed(1)} km from the ${district} district's other shelters`);
    }
  }
  for (const name of unused) problems.push(`${name}: correction matches no entry`);
  for (const warning of warnings) console.warn(`Check: ${warning}`);
  if (problems.length) throw new Error(`Not written:\n${problems.join("\n")}`);

  const accessed = new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", day: "numeric", month: "long", year: "numeric" }).format(new Date());
  const lines = shelters.map(({ district, ...shelter }) => `  ${JSON.stringify(shelter)}`);
  await writeFile(OUTPUT, `// Community haze shelters for the Hazey shelter finder. Generated by scripts/build-shelters.js;
// edit the CSV and regenerate rather than hand-editing this file.
//
// List: People's Association, "List of Community Haze Shelters at Community Clubs, Integrated Community
//   Hubs, Residents' Centres and Residents' Network (as at ${LIST_AS_AT})",
//   ${LIST_URL}
//   transcribed to docs/${SOURCE_CSV.pathname.split("/").pop()}.
// Coordinates: OneMap postal code search, Singapore Land Authority. Contains information from OneMap
//   accessed on ${accessed}, made available under the terms of the Singapore Open Data Licence
//   version 1.0 https://www.onemap.gov.sg/legal/opendatalicence.html
// kind: cc = community club, rc = Residents' Committee centre, rn = Residents' Network centre.

export const SHELTERS_AS_AT = ${JSON.stringify(LIST_AS_AT)};

export const SHELTERS = [
${lines.join(",\n")}
];
`);
  console.log(`Wrote ${shelters.length} shelters (${warnings.length} to check by hand).`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
