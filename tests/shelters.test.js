import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";
import { ONEMAP_SEARCH_URL } from "../src/postal.js";
import { SHELTERS, SHELTERS_AS_AT } from "../public/shelters.js";
import { distanceKm, formatDistance, nearest } from "../public/geo.js";

const env = { ASSETS: { fetch: async () => new Response("asset") } };
const ctx = { waitUntil() {} };
const postal = (code, method = "GET") => worker.fetch(new Request(`https://hazey.example/api/postal?code=${code}`, { method }), env, ctx);
const oneMap = results => Response.json({ found: results.length, totalNumPages: 1, pageNum: 1, results });

test("every published shelter appears once, with a six-digit postal code and coordinates in Singapore", () => {
  const rows = readFileSync(new URL("../docs/haze-shelters-2026-09.csv", import.meta.url), "utf8").trim().split("\n").slice(1);
  assert.equal(SHELTERS_AS_AT, "September 2026");
  assert.deepEqual(SHELTERS.map(shelter => shelter.name).sort(), rows.map(row => row.split(",")[1]).sort());
  assert.equal(new Set(SHELTERS.map(shelter => shelter.name)).size, SHELTERS.length);
  for (const shelter of SHELTERS) {
    assert.ok(shelter.address, shelter.name);
    assert.match(shelter.postal, /^\d{6}$/, shelter.name);
    assert.ok(["cc", "rc", "rn"].includes(shelter.kind), shelter.name);
    assert.ok(shelter.lat > 1.15 && shelter.lat < 1.48 && shelter.lng > 103.59 && shelter.lng < 104.1, shelter.name);
  }
  // The PDF drops leading zeros; central postal codes start with 0.
  assert.equal(SHELTERS.find(shelter => shelter.name === "Tanjong Pagar CC").postal, "089774");
  assert.equal(SHELTERS.filter(shelter => shelter.kind === "cc").length, 106);
});

test("distances use the haversine formula and the nearest shelters come first", () => {
  assert.ok(Math.abs(distanceKm({ lat: 1, lng: 103.8 }, { lat: 2, lng: 103.8 }) - 111.19) < 0.01);
  assert.equal(distanceKm({ lat: 1.3, lng: 103.8 }, { lat: 1.3, lng: 103.8 }), 0);
  const found = nearest({ lat: 1.37827, lng: 103.88749 }, SHELTERS, 5); // 572 Hougang St 51
  assert.equal(found.length, 5);
  assert.equal(found[0].name, "Ang Mo Kio-Hougang Pinetree RN");
  assert.ok(found[0].km < 0.1);
  assert.ok(found.every((shelter, i) => i === 0 || found[i - 1].km <= shelter.km));
  assert.equal(SHELTERS[0].km, undefined, "the shared list is not modified");
});

test("distances read naturally at every boundary", () => {
  assert.equal(formatDistance(0), "Under 100 m");
  assert.equal(formatDistance(0.0999), "Under 100 m");
  assert.equal(formatDistance(0.1), "100 m");
  assert.equal(formatDistance(0.349), "350 m");
  assert.equal(formatDistance(0.999), "1.0 km");
  assert.equal(formatDistance(1.24), "1.2 km");
  assert.equal(formatDistance(9.96), "10 km");
  assert.equal(formatDistance(12.4), "12 km");
});

test("postal lookup returns OneMap coordinates for an exact postal code match", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(url);
    return oneMap([
      { POSTAL: "530571", LATITUDE: "1.3", LONGITUDE: "103.8" },
      { POSTAL: "530572", LATITUDE: "1.378270724882904", LONGITUDE: "103.8874850986399" }
    ]);
  });
  const response = await postal("530572");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { postal: "530572", lat: 1.378270724882904, lng: 103.8874850986399 });
  assert.match(response.headers.get("Cache-Control"), /^private/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(`${ONEMAP_SEARCH_URL}?searchVal=530572&`));
});

test("postal lookup rejects bad input without calling OneMap, and reports missing codes and outages", async t => {
  let respond = () => oneMap([]);
  const fetches = t.mock.method(globalThis, "fetch", async () => respond());
  for (const code of ["", "12345", "1234567", "12345a", "530572%26x%3D1"]) assert.equal((await postal(code)).status, 400, code);
  assert.equal((await postal("530572", "POST")).status, 405);
  assert.equal(fetches.mock.callCount(), 0);
  assert.equal((await postal("999999")).status, 404);
  respond = () => oneMap([{ POSTAL: "999999", LATITUDE: "40.7", LONGITUDE: "-74" }]);
  assert.equal((await postal("999999")).status, 404, "results outside Singapore are ignored");
  respond = () => new Response("busy", { status: 429 });
  const errors = t.mock.method(console, "error", () => {});
  assert.equal((await postal("530572")).status, 502);
  assert.equal(errors.mock.callCount(), 1);
  assert.ok(!errors.mock.calls[0].arguments.join(" ").includes("530572"), "postal codes stay out of logs");
});

test("the page may request location for itself only, and keeps a same-origin CSP", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.match(headers, /Permissions-Policy: camera=\(\), microphone=\(\), geolocation=\(self\)/);
  assert.match(headers, /connect-src 'self';/);
});
