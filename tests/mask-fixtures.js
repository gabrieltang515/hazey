// HazeMaskGoWhere-shaped test data around 572 Hougang St 51 (530572), from the 16 October 2026 files.
const FLAGS = {
  stock: ["stocksAvailable", "limitedStocksAvailable", "outOfStock"],
  machine: ["available", "notAvailable"],
  collectionOption: ["vendingMachine", "ccCounter"]
};

export function maskEntry({ name, address = "1 Test Road", postalCode = "123456", lat, lng, option = "ccCounter",
  stock = "stocksAvailable", machine = null, hours = "Monday to Sunday, 10am to 6pm", description = null }) {
  const chosen = { stock, machine, collectionOption: option };
  return {
    address, postalCode, name, contactNumber: "60000000", description, LON: lng, LAT: lat, operatingHoursFreeText: hours,
    filters: [
      { category: "region", options: [{ name: "north-east", flag: true }] },
      ...Object.entries(FLAGS).map(([category, names]) => ({ category, options: names.map(flag => ({ name: flag, flag: flag === chosen[category] })) }))
    ]
  };
}

// Five valid CC counters (one out of stock) and two invalid entries.
export const ccFile = () => ({ lastUpdated: "16 Oct 2026", data: [
  maskEntry({ name: "Ci Yuan CC", address: "51 Hougang Ave 9 #01-01", postalCode: "538776", lat: 1.375322537735674, lng: 103.8829319300397 }),
  maskEntry({ name: "Punggol CC", address: "3 Hougang Ave 6", postalCode: "538808", lat: 1.374369988219469, lng: 103.8919119303212, stock: "outOfStock" }),
  maskEntry({ name: "Buangkok CC", address: "70 Compassvale Bow #01-25", postalCode: "544692", lat: 1.382981632033452, lng: 103.8927210077455 }),
  maskEntry({ name: "Hougang CC", address: "35 Hougang Ave 3", postalCode: "538840", lat: 1.364751243812483, lng: 103.8927279945726, stock: "limitedStocksAvailable" }),
  maskEntry({ name: "Tanjong Pagar CC", address: "101 Cantonment Road", postalCode: "089774", lat: 1.27617, lng: 103.84158 }),
  maskEntry({ name: "Nowhere CC", lat: 0, lng: 0 }),
  maskEntry({ name: "  ", lat: 1.3, lng: 103.8 })
] });

// One machine out of service, one with limited stock.
export const vendingFile = () => ({ lastUpdated: "16 Oct 2026", data: [
  maskEntry({ name: "Hougang Social Service Office (SSO)", address: "662 Hougang Avenue 4", postalCode: "530662", description: "Near lift lobby B",
    lat: 1.374376894, lng: 103.8828749, option: "vendingMachine", stock: null, machine: "notAvailable", hours: "Daily, 24 hours" }),
  maskEntry({ name: "Hougang Bus Interchange", address: "840 Hougang Central", postalCode: "538757", description: "Near Boarding Berth 1",
    lat: 1.370894574, lng: 103.8931575, option: "vendingMachine", stock: "limitedStocksAvailable", machine: "available", hours: "Daily,\n 24 hours" })
] });
