import { REGIONS, category, regionName, singaporeTime } from "./psi.js";

const byId = id => document.getElementById(id);
const cards = new Map();
let loading = false;
let snapshot = null;

for (const key of REGIONS) {
  const card = document.createElement("article");
  card.className = "region-card";
  card.dataset.category = "unknown";
  card.setAttribute("aria-labelledby", `region-${key}`);
  card.innerHTML = `<div class="region-top"><h3 id="region-${key}">${regionName(key)}</h3><span class="region-letter" aria-hidden="true">${key[0].toUpperCase()}</span></div><p class="region-value">—</p><p class="region-unit">24-hour PSI</p><span class="category-badge">Loading</span><details><summary>Pollutant details</summary><dl><div><dt>PM2.5 · 24h</dt><dd class="pm25">—</dd></div><div><dt>PM10 · 24h</dt><dd class="pm10">—</dd></div></dl></details>`;
  byId("region-grid").append(card);
  cards.set(key, card);
}

function notice(message) {
  byId("notice").textContent = message;
  byId("notice").hidden = !message;
}

function render(data) {
  for (const region of data.regions) {
    const card = cards.get(region.key);
    const band = category(region.psi);
    card.dataset.category = band.key;
    card.querySelector(".region-value").textContent = region.psi;
    card.querySelector(".category-badge").textContent = band.label;
    for (const pollutant of ["pm25", "pm10"]) {
      card.querySelector(`.${pollutant}`).textContent = Number.isFinite(region[pollutant]) ? `${region[pollutant]} µg/m³` : "Unavailable";
    }
  }
  const highest = Math.max(...data.regions.map(region => region.psi));
  const highestRegions = data.regions.filter(region => region.psi === highest).map(region => region.name);
  byId("highest-value").textContent = highest;
  byId("summary").dataset.category = category(highest).key;
  byId("highest-category").textContent = category(highest).label;
  byId("highest-region").textContent = highestRegions.length === 5 ? "All regions" : highestRegions.join(" · ");
  byId("reading-time").textContent = `Reading: ${singaporeTime(data.readingAt)} SGT`;
  byId("source-updated").textContent = `NEA update: ${singaporeTime(data.sourceUpdatedAt)} SGT`;
  byId("feed-state").dataset.state = data.stale ? "stale" : "ready";
  byId("feed-label").textContent = data.stale ? "Saved reading · update delayed" : "Latest available NEA reading";
  notice(data.stale ? "Fresh readings are delayed. These are the last saved NEA readings; check the reading time before using them." : "");
  byId("telegram-panel").hidden = !data.botUsername;
  if (data.botUsername && /^[a-z0-9_]{5,32}$/i.test(data.botUsername)) {
    byId("telegram-link").href = `https://t.me/${data.botUsername}`;
    byId("telegram-link").hidden = false;
    byId("telegram-copy").hidden = true;
  }
}

async function load() {
  if (loading) return;
  loading = true;
  byId("refresh-button").disabled = true;
  byId("refresh-button").classList.add("is-loading");
  byId("refresh-label").textContent = "Refreshing";
  byId("readings").setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/psi", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Readings unavailable");
    const data = await response.json();
    if (!Array.isArray(data.regions) || data.regions.length !== 5 || REGIONS.some(key => !data.regions.some(r => r.key === key && Number.isInteger(r.psi) && r.psi >= 0)) || !Number.isFinite(Date.parse(data.readingAt)) || !Number.isFinite(Date.parse(data.sourceUpdatedAt))) {
      throw new Error("Invalid readings");
    }
    snapshot = data;
    render(data);
  } catch {
    notice(snapshot ? "Unable to check for an update. Showing the last loaded readings below; check their reading time." : "NEA readings are temporarily unavailable. Select Refresh readings to try again.");
    byId("feed-state").dataset.state = "stale";
    byId("feed-label").textContent = snapshot ? "Saved reading · connection unavailable" : "Readings unavailable";
    if (!snapshot) for (const card of cards.values()) card.querySelector(".category-badge").textContent = "Unavailable";
  } finally {
    loading = false;
    byId("refresh-button").disabled = false;
    byId("refresh-button").classList.remove("is-loading");
    byId("refresh-label").textContent = "Refresh readings";
    byId("readings").setAttribute("aria-busy", "false");
  }
}

byId("refresh-button").addEventListener("click", load);
byId("telegram-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("/psi");
    byId("telegram-copy").textContent = "Copied /psi ✓";
    byId("copy-status").textContent = "Copied /psi to your clipboard.";
    setTimeout(() => { byId("telegram-copy").textContent = "Copy /psi ↗"; }, 2500);
  } catch {
    byId("copy-status").textContent = "Copy unavailable. Type /psi in Telegram.";
    byId("telegram-copy").textContent = "Type /psi in Telegram";
  }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden) load(); }, 60_000);
load();
