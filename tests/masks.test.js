import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMaskSites } from "../scripts/mask-data.js";
import { MASK_SITES, MASK_SITES_AS_AT } from "../public/mask-sites.js";
import { MASK_KINDS, MASK_STOCK, collectable, maskCounts, maskPlaces, stockUpdatedAt } from "../public/masks.js";
import { ccFile, maskEntry, vendingFile } from "./mask-fixtures.js";

test("HazeMaskGoWhere entries normalize to sites with kind, hours and spot, without stock; invalid entries are dropped", () => {
  const cc = normalizeMaskSites(ccFile(), "cc");
  assert.equal(cc.dropped, 2);
  assert.deepEqual(cc.sites.map(site => site.name), ["Ci Yuan CC", "Punggol CC", "Buangkok CC", "Hougang CC", "Tanjong Pagar CC"]);
  assert.deepEqual(cc.sites[0], { name: "Ci Yuan CC", kind: "cc", address: "51 Hougang Ave 9 #01-01", postal: "538776",
    lat: 1.375322537735674, lng: 103.8829319300397, hours: "Monday to Sunday, 10am to 6pm", spot: null });
  assert.equal(cc.sites[4].postal, "089774", "leading zeros survive");
  const vending = normalizeMaskSites(vendingFile(), "vending");
  assert.equal(vending.dropped, 0);
  assert.deepEqual(vending.sites.map(site => [site.kind, site.spot, site.hours]), [
    ["vending", "Near lift lobby B", "Daily, 24 hours"],
    ["vending", "Near Boarding Berth 1", "Daily, 24 hours"]
  ]);
  assert.equal("contactNumber" in vending.sites[0], false, "contact numbers are not kept");
  assert.equal("stock" in vending.sites[0], false, "stock is not kept");
  assert.equal(normalizeMaskSites({ data: [maskEntry({ name: "x".repeat(500), lat: 1.3, lng: 103.8 })] }, "cc").sites[0].name.length, 200, "long upstream text is capped");
});

test("the file decides an unflagged kind; postal codes and hours fall back to null", () => {
  const [machine] = normalizeMaskSites({ data: [maskEntry({ name: "Machine", lat: 1.3, lng: 103.8, option: null })] }, "vending").sites;
  assert.equal(machine.kind, "vending");
  const [site] = normalizeMaskSites({ data: [maskEntry({ name: "Counter", lat: "1.3", lng: "103.8", postalCode: "12345", hours: "  " })] }, "cc").sites;
  assert.deepEqual([site.kind, site.postal, site.hours, site.lat], ["cc", null, null, 1.3]);
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
  assert.deepEqual(maskCounts([{ kind: "cc" }, { kind: "vending" }, { kind: "cc" }]), { cc: 2, vending: 1 });
});

test("the saved mask list has valid points of both kinds, without stock, and a generation time", () => {
  assert.ok(MASK_SITES.length >= 100, `only ${MASK_SITES.length} points`);
  assert.ok(Number.isFinite(Date.parse(MASK_SITES_AS_AT)));
  const counts = maskCounts(MASK_SITES);
  assert.ok(counts.cc > 0 && counts.vending > 0);
  assert.equal(counts.cc + counts.vending, MASK_SITES.length, "every point is a CC counter or a vending machine");
  for (const site of MASK_SITES) {
    assert.deepEqual(Object.keys(site).sort(), ["address", "hours", "kind", "lat", "lng", "name", "postal", "spot"], site.name);
    assert.ok(site.name && site.address, site.name);
    assert.ok(site.postal === null || /^\d{6}$/.test(site.postal), site.name);
    assert.ok(site.lat > 1.15 && site.lat < 1.48 && site.lng > 103.59 && site.lng < 104.1, site.name);
  }
});
