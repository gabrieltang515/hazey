import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMaskSites } from "../src/mask-data.js";
import { MASK_KINDS, MASK_STOCK, collectable, maskPlaces, stockUpdatedAt } from "../public/masks.js";
import { ccFile, maskEntry, vendingFile } from "./mask-fixtures.js";

test("HazeMaskGoWhere entries normalize to sites with kind, stock, hours and spot; invalid entries are dropped", () => {
  const cc = normalizeMaskSites(ccFile(), "cc");
  assert.equal(cc.dropped, 2);
  assert.deepEqual(cc.sites.map(site => site.name), ["Ci Yuan CC", "Punggol CC", "Buangkok CC", "Hougang CC", "Tanjong Pagar CC"]);
  assert.deepEqual(cc.sites[0], { name: "Ci Yuan CC", kind: "cc", address: "51 Hougang Ave 9 #01-01", postal: "538776",
    lat: 1.375322537735674, lng: 103.8829319300397, hours: "Monday to Sunday, 10am to 6pm", spot: null, stock: "in" });
  assert.deepEqual(cc.sites.map(site => site.stock), ["in", "out", "in", "limited", "in"]);
  assert.equal(cc.sites[4].postal, "089774", "leading zeros survive");
  const vending = normalizeMaskSites(vendingFile(), "vending");
  assert.equal(vending.dropped, 0);
  assert.deepEqual(vending.sites.map(site => [site.kind, site.stock, site.spot, site.hours]), [
    ["vending", "offline", "Near lift lobby B", "Daily, 24 hours"],
    ["vending", "limited", "Near Boarding Berth 1", "Daily, 24 hours"]
  ]);
  assert.equal("contactNumber" in vending.sites[0], false, "contact numbers are not kept");
  assert.equal(normalizeMaskSites({ data: [maskEntry({ name: "x".repeat(500), lat: 1.3, lng: 103.8 })] }, "cc").sites[0].name.length, 200, "long upstream text is capped");
});

test("out of service beats stock flags, the most cautious stock flag wins, and the file decides an unflagged kind", () => {
  const offline = maskEntry({ name: "Machine", lat: 1.3, lng: 103.8, option: null, stock: "stocksAvailable", machine: "notAvailable" });
  const [machine] = normalizeMaskSites({ data: [offline] }, "vending").sites;
  assert.equal(machine.stock, "offline");
  assert.equal(machine.kind, "vending");
  const conflicting = maskEntry({ name: "Counter", lat: 1.3, lng: 103.8 });
  for (const option of conflicting.filters.find(filter => filter.category === "stock").options) option.flag = option.name !== "limitedStocksAvailable";
  assert.equal(normalizeMaskSites({ data: [conflicting] }, "cc").sites[0].stock, "out");
  const bare = maskEntry({ name: "Unknown", lat: "1.3", lng: "103.8", stock: null, postalCode: "12345", hours: "  " });
  const [site] = normalizeMaskSites({ data: [bare] }, "cc").sites;
  assert.deepEqual([site.stock, site.postal, site.hours, site.lat], ["unknown", null, null, 1.3]);
});

test("a file without a data array is a failed fetch; an empty list is valid", () => {
  assert.throws(() => normalizeMaskSites({ code: 0, data: { items: [] } }, "cc"), /Unexpected HazeMaskGoWhere format/);
  assert.throws(() => normalizeMaskSites(null, "cc"), /Unexpected HazeMaskGoWhere format/);
  assert.deepEqual(normalizeMaskSites({ lastUpdated: "16 Oct 2026", data: [] }, "cc"), { sites: [], dropped: 0 });
  assert.throws(() => normalizeMaskSites({ data: [null, "x", { name: "No coordinates", address: "1 Road" }] }, "cc"), /No valid HazeMaskGoWhere entries \(0 of 3\)/);
});

test("shared mask helpers: collectable points, stock time and place counts", () => {
  assert.deepEqual(["in", "limited", "unknown", "out", "offline"].map(stock => collectable({ stock })), [true, true, true, false, false]);
  assert.ok(Object.keys(MASK_STOCK).length === 5 && MASK_KINDS.cc === "CC counter" && MASK_KINDS.vending === "Vending machine");
  assert.equal(stockUpdatedAt({ cc: { updatedAt: "cc" }, vending: { updatedAt: "vending" } }), "vending");
  assert.equal(stockUpdatedAt({ cc: { updatedAt: "cc" }, vending: null }), "cc");
  assert.equal(stockUpdatedAt({ cc: null, vending: null }), null);
  assert.equal(maskPlaces({ cc: 4, vending: 1 }), "4 CC counters and 1 vending machine");
  assert.equal(maskPlaces({ cc: 0, vending: 2 }), "2 vending machines");
  assert.equal(maskPlaces({ cc: 1, vending: 0 }), "1 CC counter");
});
