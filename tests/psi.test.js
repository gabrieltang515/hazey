import test from "node:test";
import assert from "node:assert/strict";
import { category, pm25Band, REGIONS, singaporeTime } from "../public/psi.js";
import { normalizePm25, normalizePsi, isStale, telegramReading } from "../src/psi.js";
import { parseCommand } from "../src/worker.js";

export function fixture(timestamp = "2026-10-14T14:00:00+08:00") {
  return { code: 0, data: { items: [{ timestamp, updatedTimestamp: "2026-10-14T14:45:36+08:00", readings: {
    psi_twenty_four_hourly: { north: 110, south: 134, east: 149, west: 153, central: 148 },
    pm25_twenty_four_hourly: { north: 64, south: 87, east: 102, west: 105, central: 101 }
  } }] } };
}

test("PSI bands include the correct values at every boundary", () => {
  for (const [value, expected] of [[0,"good"],[50,"good"],[51,"moderate"],[100,"moderate"],[101,"unhealthy"],[200,"unhealthy"],[201,"very-unhealthy"],[300,"very-unhealthy"],[301,"hazardous"],[600,"hazardous"],[-1,"unknown"],[null,"unknown"]]) {
    assert.equal(category(value).key, expected, `PSI ${value}`);
  }
});
test("live v2 shape works without the optional three-hour field", () => {
  const result = normalizePsi(fixture(), Date.parse("2026-10-14T07:00:00Z"));
  assert.deepEqual(result.regions.map(r => r.key), REGIONS);
  assert.equal(result.regions.find(r => r.key === "west").psi, 153);
  assert.equal(result.regions[0].pm10, null);
  assert.equal(result.regions[0].pm25, 64);
  assert.equal(result.fetchedAt, "2026-10-14T07:00:00.000Z");
});
test("selects the latest reading even when items are out of order", () => {
  const body = fixture();
  body.data.items.push(fixture("2026-10-14T15:00:00+08:00").data.items[0]);
  assert.equal(normalizePsi(body).readingAt, "2026-10-14T15:00:00+08:00");
});
test("rejects failures, missing regions, strings, and unzoned timestamps", () => {
  assert.throws(() => normalizePsi({ code: 24, data: null }));
  for (const bad of [undefined, null, -1, "42", 1.5]) {
    const body = fixture(); body.data.items[0].readings.psi_twenty_four_hourly.west = bad;
    assert.throws(() => normalizePsi(body));
  }
  assert.throws(() => normalizePsi(fixture("2026-10-14T14:00:00")));
});
test("staleness considers both the stored snapshot and observation age", () => {
  const now = Date.parse("2026-10-14T07:00:00Z");
  const result = normalizePsi(fixture(), now);
  assert.equal(isStale(result, now), false);
  assert.equal(isStale(result, now + 16 * 60_000), true);
  assert.equal(isStale({ ...result, readingAt: "2026-10-14T01:00:00Z" }, now), true);
});
test("bot replies show all regions, SGT, categories, and stale warnings", () => {
  const now = Date.parse("2026-10-14T07:00:00Z");
  const result = normalizePsi(fixture(), now);
  const all = telegramReading(result, null, { now });
  for (const region of REGIONS) assert.match(all.toLowerCase(), new RegExp(`${region}:`));
  assert.match(all, /24-hour PSI/); assert.match(all, /SGT/); assert.doesNotMatch(all, /saved/);
  assert.match(all, /1-hour PM2.5: not available yet/);
  const west = telegramReading(result, "west", { now: now + 16 * 60_000 });
  assert.match(west, /West: 153 — Unhealthy/); assert.doesNotMatch(west, /North:/);
  assert.match(west, /saved PSI readings/);
  assert.equal(singaporeTime("2026-10-14T06:00:00Z"), singaporeTime("2026-10-14T14:00:00+08:00"));
});
test("commands handle group mentions, region casing, and other bots", () => {
  assert.deepEqual(parseCommand("/psi@hazey_psi_bot West", "hazey_psi_bot"), { command: "psi", argument: "west" });
  assert.equal(parseCommand("/psi@other_bot", "hazey_psi_bot"), null);
  assert.equal(parseCommand("hello"), null);
  assert.deepEqual(parseCommand("/start"), { command: "start", argument: "" });
  assert.deepEqual(parseCommand("/pm25@hazey_psi_bot East", "hazey_psi_bot"), { command: "pm25", argument: "east" });
});

export function pm25Fixture(timestamp = "2026-10-14T15:00:00+08:00") {
  return { code: 0, data: { items: [{ timestamp, updatedTimestamp: "2026-10-14T15:00:36+08:00", readings: {
    pm25_one_hourly: { north: 111, south: 148, west: 257, east: 190, central: 226 }
  } }] } };
}

test("PM2.5 bands follow NEA's 1-hour thresholds at every boundary", () => {
  for (const [value, expected] of [[0,"I"],[55,"I"],[56,"II"],[150,"II"],[151,"III"],[250,"III"],[251,"IV"],[900,"IV"],[-1,""],[null,""],["42",""]]) {
    assert.equal(pm25Band(value).band, expected, `PM2.5 ${value}`);
  }
  assert.equal(pm25Band(257).label, "Very high");
});
test("PM2.5 uses the live v2 one-hour shape and rejects invalid regional values", () => {
  const now = Date.parse("2026-10-14T07:10:00Z");
  const result = normalizePm25(pm25Fixture(), now);
  assert.deepEqual(result.regions.map(r => r.key), REGIONS);
  assert.equal(result.regions.find(r => r.key === "west").pm25, 257);
  assert.equal(result.sourceUpdatedAt, "2026-10-14T15:00:36+08:00");
  assert.equal(isStale(result, now), false);
  for (const bad of [undefined, null, -1, "42"]) {
    const body = pm25Fixture(); body.data.items[0].readings.pm25_one_hourly.east = bad;
    assert.throws(() => normalizePm25(body));
  }
  assert.throws(() => normalizePm25({ code: 0, data: { items: [] } }));
  const reply = telegramReading({ ...normalizePsi(fixture(), now), pm25: result }, "east", { now, pm25Only: true });
  assert.match(reply, /1-hour PM2.5 \(µg\/m³\)\nEast: 190 — High \(Band III\)\nReading: .*SGT/);
  assert.doesNotMatch(reply, /PSI\n|West:/);
});
