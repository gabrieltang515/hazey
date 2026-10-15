import { REGIONS, PSI_BANDS, PM25_BANDS, category, pm25Band, regionList, regionName, shelterNotice, singaporeClock } from "./psi.js";
import { MAP_VIEWBOX, LAND_PATH, REGION_SHAPES, REGION_LABELS } from "./map-data.js";
import { SHELTERS, SHELTERS_AS_AT } from "./shelters.js";
import { SHELTER_KINDS, directionsUrl, nearest, formatDistance } from "./geo.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const byId = id => document.getElementById(id);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ } }
};

const METRICS = {
  psi: {
    label: "24-hour PSI", unit: "24-hour PSI", bands: PSI_BANDS, band: category, suffix: "",
    note: "PSI is an index, not a concentration. Colours follow NEA’s 24-hour PSI bands."
  },
  pm25: {
    label: "1-hour PM2.5", unit: "µg/m³", bands: PM25_BANDS, band: pm25Band, suffix: " µg/m³",
    note: "PM2.5 is a concentration in µg/m³. Colours follow NEA’s 1-hour PM2.5 bands."
  }
};

const state = {
  data: null, history: null, historyKey: "", loading: false, mapReady: false,
  metric: storage.get("hazey-metric") === "pm25" ? "pm25" : "psi", newUntil: 0
};

function svg(tag, attributes = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  parent?.append(node);
  return node;
}
const setText = (root, selector, text) => { root.querySelector(selector).textContent = text; };
const announce = message => { byId("announcer").textContent = message; };

/* ---------- Region cards ---------- */

const cards = new Map();
for (const key of REGIONS) {
  const card = document.createElement("article");
  card.className = "region-card is-loading";
  card.id = `card-${key}`;
  card.dataset.region = key;
  card.dataset.band = "unknown";
  card.setAttribute("aria-labelledby", `region-${key}`);
  card.innerHTML = `
    <div class="card-head"><h3 id="region-${key}">${regionName(key)}</h3><span class="badge primary-badge" data-band="unknown">Loading</span></div>
    <p class="reading"><span class="reading-value">000</span><span class="reading-unit"></span></p>
    <p class="reading-change"></p>
    <div class="spark" tabindex="0" role="group"></div>
    <div class="spark-axis" aria-hidden="true"><span>24 h ago</span><span class="spark-end-label"></span></div>
    <dl class="card-facts"><div><dt class="other-label"></dt><dd><span class="other-value"></span><span class="badge other-badge" data-band="unknown"></span></dd></div></dl>
    <details><summary>24-hour averages</summary><dl><div><dt>PM2.5</dt><dd class="avg-pm25">—</dd></div><div><dt>PM10</dt><dd class="avg-pm10">—</dd></div></dl></details>`;
  card.addEventListener("pointerenter", () => mapRegion(key)?.classList.add("is-active"));
  card.addEventListener("pointerleave", () => mapRegion(key)?.classList.remove("is-active"));
  byId("region-grid").append(card);
  cards.set(key, card);
}

function setBadge(badge, band) {
  badge.dataset.band = band.key;
  badge.textContent = band.label;
  badge.title = band.band ? `Band ${band.band}` : "";
}

/* ---------- Map ---------- */

const map = byId("map");
const viewBoxWidth = Number(MAP_VIEWBOX.split(/\s+/)[2]);
const mapRegion = key => map.querySelector(`.map-region[data-region="${key}"]`);
const mapLabels = new Map();

function buildMap() {
  map.setAttribute("viewBox", MAP_VIEWBOX);
  const clip = svg("clipPath", { id: "land-clip" }, svg("defs", {}, map));
  svg("path", { d: LAND_PATH }, clip);
  svg("path", { class: "map-land", d: LAND_PATH }, map);
  const regions = svg("g", { "clip-path": "url(#land-clip)" }, map);
  REGIONS.forEach((key, index) => {
    const region = svg("path", { class: "map-region", d: REGION_SHAPES[key], "data-region": key, "data-band": "unknown", tabindex: "0", role: "button" }, regions);
    region.style.setProperty("--i", index);
    region.addEventListener("click", () => focusCard(key));
    region.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); focusCard(key); }
    });
  });
  svg("path", { class: "map-coast", d: LAND_PATH }, map);
  for (const key of REGIONS) {
    const text = svg("text", { class: "map-label", "text-anchor": "middle", "aria-hidden": "true" }, map);
    const name = svg("tspan", { class: "map-label-name" }, text);
    name.textContent = regionName(key);
    const value = svg("tspan", { class: "map-label-value" }, text);
    value.textContent = "–";
    mapLabels.set(key, { text, name, value });
  }
  placeMapLabels();
}

// Keep label type at a constant on-screen size whatever the map's rendered width.
function placeMapLabels() {
  const width = map.getBoundingClientRect().width;
  if (!width) return;
  const unit = viewBoxWidth / width;
  const compact = width < 480;
  const namePx = compact ? 11.5 : 13, valuePx = compact ? 19 : 26;
  for (const [key, { text, name, value }] of mapLabels) {
    const { x, y } = REGION_LABELS[key];
    text.setAttribute("x", x);
    text.setAttribute("y", y - (valuePx * 0.2) * unit);
    name.setAttribute("x", x);
    name.setAttribute("font-size", namePx * unit);
    value.setAttribute("x", x);
    value.setAttribute("dy", valuePx * 1.05 * unit);
    value.setAttribute("font-size", valuePx * unit);
  }
}

function focusCard(key) {
  const card = cards.get(key);
  card.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "center" });
  card.classList.add("is-highlighted");
  setTimeout(() => card.classList.remove("is-highlighted"), 1800);
  card.querySelector(".spark").focus({ preventScroll: true });
}

/* ---------- Data helpers ---------- */

const validPm25 = pm25 => Array.isArray(pm25?.regions) && Number.isFinite(Date.parse(pm25.readingAt)) &&
  REGIONS.every(key => pm25.regions.some(r => r.key === key && Number.isFinite(r.pm25) && r.pm25 >= 0));

function currentValues(data) {
  const pm25 = validPm25(data.pm25) ? data.pm25 : null;
  return {
    psi: Object.fromEntries(data.regions.map(region => [region.key, region.psi])),
    pm25: pm25 && Object.fromEntries(pm25.regions.map(region => [region.key, region.pm25]))
  };
}

const formatValue = (metric, value) => `${value}${METRICS[metric].suffix}`;

function relativeTime(timestamp) {
  const minutes = Math.round((Date.now() - Date.parse(timestamp)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/* ---------- Rendering ---------- */

function render() {
  const { data, metric } = state;
  if (!data) return;
  const values = currentValues(data);
  const primary = values[metric];
  const other = metric === "psi" ? "pm25" : "psi";
  const config = METRICS[metric];

  for (const key of REGIONS) {
    const card = cards.get(key);
    const band = primary ? config.band(primary[key]) : config.band(NaN);
    card.classList.remove("is-loading");
    card.dataset.band = band.key;
    setBadge(card.querySelector(".primary-badge"), band);
    setText(card, ".reading-value", primary ? String(primary[key]) : "—");
    setText(card, ".reading-unit", config.unit);
    setText(card, ".other-label", METRICS[other].label);
    const otherValue = values[other]?.[key];
    setText(card, ".other-value", values[other] ? formatValue(other, otherValue) : "Unavailable");
    setBadge(card.querySelector(".other-badge"), METRICS[other].band(values[other] ? otherValue : NaN));
    const region = data.regions.find(r => r.key === key);
    for (const pollutant of ["pm25", "pm10"]) {
      setText(card, `.avg-${pollutant}`, Number.isFinite(region[pollutant]) ? `${region[pollutant]} µg/m³` : "Unavailable");
    }
  }

  for (const key of REGIONS) {
    const band = primary ? config.band(primary[key]) : config.band(NaN);
    const region = mapRegion(key);
    region.dataset.band = band.key;
    region.setAttribute("aria-label", primary
      ? `${regionName(key)}: ${config.label} ${formatValue(metric, primary[key])}, ${band.label}. Show ${regionName(key)} details.`
      : `${regionName(key)}: ${config.label} unavailable.`);
    mapLabels.get(key).value.textContent = primary ? String(primary[key]) : "–";
  }
  // The one orchestrated moment: regions tint in turn on first load; later changes recolour together.
  if (!state.mapReady) {
    state.mapReady = true;
    map.classList.add("is-revealing");
    requestAnimationFrame(() => requestAnimationFrame(() => map.classList.add("is-ready")));
    setTimeout(() => map.classList.remove("is-revealing"), 1400);
  }

  byId("map-note").textContent = config.note;
  const present = new Set(primary ? REGIONS.map(key => config.band(primary[key]).key) : []);
  byId("legend").replaceChildren(...config.bands.map(band => {
    const item = document.createElement("li");
    item.dataset.band = band.key;
    item.classList.toggle("is-present", present.has(band.key));
    const range = document.createElement("span");
    range.className = "legend-range";
    range.textContent = band.range;
    item.append(band.band ? `${band.label} (${band.band})` : band.label, " ", range);
    return item;
  }));

  renderVerdict(primary, metric);
  const pm25 = validPm25(data.pm25) ? data.pm25 : null;
  byId("reading-time").textContent = `24-hour PSI as of ${singaporeClock(data.readingAt)} SGT${data.stale ? ", delayed" : ""}`;
  byId("pm25-time").textContent = pm25 ? `1-hour PM2.5 as of ${singaporeClock(pm25.readingAt)} SGT${pm25.stale ? ", delayed" : ""}` : "1-hour PM2.5 unavailable";
  byId("notice").textContent = data.stale ? "Fresh readings are delayed. These are the last saved NEA readings; check the reading time before relying on them."
    : !pm25 ? "1-hour PM2.5 readings are temporarily unavailable. The 24-hour PSI readings shown are current."
    : pm25.stale ? "Fresh 1-hour PM2.5 readings are delayed. The PM2.5 values shown are the last saved readings; check their reading time." : "";
  byId("notice").hidden = !byId("notice").textContent;

  byId("telegram-panel").hidden = !data.botUsername;
  if (data.botUsername && /^[a-z0-9_]{5,32}$/i.test(data.botUsername)) {
    byId("telegram-link").href = `https://t.me/${data.botUsername}`;
    byId("telegram-link").hidden = false;
    byId("telegram-copy").hidden = true;
  }
  renderShelterStatus();
  renderLive();
  renderTrends();
}

function renderVerdict(values, metric) {
  const config = METRICS[metric];
  if (!values) {
    byId("verdict").dataset.band = "unknown";
    byId("verdict-headline").textContent = "1-hour PM2.5 is unavailable right now";
    byId("verdict-detail").textContent = "Switch to 24-hour PSI for current readings.";
    return;
  }
  const order = config.bands.map(band => band.key);
  const bands = REGIONS.map(key => config.band(values[key])).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  const [low, high] = [bands[0], bands.at(-1)];
  const highest = Math.max(...REGIONS.map(key => values[key]));
  const where = regionList(REGIONS.filter(key => values[key] === highest));
  byId("verdict").dataset.band = high.key;
  byId("verdict-headline").textContent = low.key === high.key ? `${high.label} across Singapore`
    : `${low.label} to ${high.label.toLowerCase()} across Singapore`;
  byId("verdict-detail").textContent = `The highest ${config.label} is ${formatValue(metric, highest)}, in ${where}.`;
}

function renderLive() {
  const live = byId("live");
  const { data } = state;
  if (!data) return;
  const pm25 = validPm25(data.pm25) ? data.pm25 : null;
  const latestReading = pm25 && Date.parse(pm25.readingAt) > Date.parse(data.readingAt) ? pm25.readingAt : data.readingAt;
  const isNew = Date.now() < state.newUntil;
  live.dataset.state = state.offline ? "error" : data.stale ? "stale" : "ready";
  live.classList.toggle("is-new", isNew && !data.stale);
  byId("live-label").textContent = state.offline ? "Offline" : data.stale ? "Delayed"
    : `${isNew ? "New " : ""}${singaporeClock(latestReading)} reading`;
  byId("live-detail").textContent = state.offline ? "showing the last loaded readings"
    : data.stale ? `showing the ${singaporeClock(data.readingAt)} reading` : `checked ${relativeTime(data.fetchedAt)}`;
}

/* ---------- 24-hour trends ---------- */

const sparkState = new Map();

function seriesFor(metric) {
  return (state.history?.[metric] ?? [])
    .map(point => ({ ...point, t: Date.parse(point.at) }))
    .filter(point => Number.isFinite(point.t) && REGIONS.every(key => Number.isFinite(point[key])));
}

function renderTrends() {
  const { metric } = state;
  const config = METRICS[metric];
  const all = seriesFor(metric);
  const end = all.at(-1)?.t;
  const series = end ? all.filter(point => point.t >= end - DAY) : [];
  const values = series.flatMap(point => REGIONS.map(key => point[key]));
  const min = Math.min(...values), max = Math.max(...values);
  const pad = Math.max((max - min) * 0.12, metric === "psi" ? 4 : 6);
  const domain = [Math.max(0, min - pad), max + pad];

  for (const key of REGIONS) {
    const card = cards.get(key);
    const spark = card.querySelector(".spark");
    const points = series.map(point => ({ t: point.t, v: point[key] }));
    sparkState.set(key, { points, index: points.length - 1, metric });
    setText(card, ".spark-end-label", points.length ? singaporeClock(points.at(-1).t) : "");
    if (points.length < 2) {
      spark.replaceChildren(Object.assign(document.createElement("div"), { className: "spark-empty", textContent: state.history ? "Trend appears after a few hourly readings" : "Loading trend" }));
      spark.setAttribute("aria-label", `${regionName(key)} ${config.label} trend is not available yet.`);
      setText(card, ".reading-change", "");
      continue;
    }
    drawSpark(spark, points, domain, config);
    const last = points.at(-1);
    const reference = points.find(point => Math.abs(point.t - (last.t - DAY)) <= 90 * 60_000);
    const delta = reference ? Math.round((last.v - reference.v) * 10) / 10 : null;
    setText(card, ".reading-change", delta === null ? "" : delta === 0 ? "No change in 24 hours"
      : `${delta > 0 ? "Up" : "Down"} ${Math.abs(delta)} in 24 hours`);
    spark.setAttribute("aria-label", `${regionName(key)} ${config.label} over the last 24 hours, from ${points[0].v} to ${last.v}. Use the left and right arrow keys to read each hour.`);
  }
  renderTable(series, metric);
}

function drawSpark(container, points, [lo, hi], config) {
  const width = container.clientWidth || 200, height = container.clientHeight || 64;
  const inset = { top: 8, right: 8, bottom: 4, left: 4 };
  const start = points.at(-1).t - DAY, end = points.at(-1).t;
  const x = t => inset.left + ((t - start) / (end - start)) * (width - inset.left - inset.right);
  const y = v => inset.top + ((hi - v) / (hi - lo || 1)) * (height - inset.top - inset.bottom);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" });
  const line = points.map((point, i) => `${i ? "L" : "M"}${x(point.t).toFixed(1)} ${y(point.v).toFixed(1)}`).join("");
  svg("path", { class: "spark-area", d: `${line}L${x(end).toFixed(1)} ${height}L${x(points[0].t).toFixed(1)} ${height}Z` }, root);
  svg("path", { class: "spark-line", d: line }, root);
  const last = points.at(-1);
  svg("circle", { class: "spark-end", cx: x(last.t), cy: y(last.v), r: 4 }, root);
  const cursor = svg("g", { class: "spark-cursor-group", visibility: "hidden" }, root);
  svg("line", { class: "spark-cursor", y1: 0, y2: height }, cursor);
  svg("circle", { class: "spark-cursor-dot", r: 4 }, cursor);
  const tip = Object.assign(document.createElement("div"), { className: "spark-tip", hidden: true });
  container.replaceChildren(root, tip);
  container.sparkGeometry = { x, y, cursor, tip, config, width };
}

function showSparkPoint(key, index) {
  const card = cards.get(key);
  const spark = card.querySelector(".spark");
  const entry = sparkState.get(key);
  const geometry = spark.sparkGeometry;
  if (!geometry || !entry?.points.length) return;
  entry.index = Math.max(0, Math.min(entry.points.length - 1, index));
  const point = entry.points[entry.index];
  const px = geometry.x(point.t), py = geometry.y(point.v);
  geometry.cursor.setAttribute("visibility", "visible");
  geometry.cursor.firstChild.setAttribute("x1", px);
  geometry.cursor.firstChild.setAttribute("x2", px);
  geometry.cursor.lastChild.setAttribute("cx", px);
  geometry.cursor.lastChild.setAttribute("cy", py);
  const value = document.createElement("strong");
  value.textContent = formatValue(entry.metric, point.v);
  geometry.tip.replaceChildren(value, singaporeClock(point.t));
  geometry.tip.hidden = false;
  geometry.tip.style.left = `${Math.max(48, Math.min(geometry.width - 48, px))}px`;
  return point;
}

function hideSparkPoint(key) {
  const geometry = cards.get(key).querySelector(".spark").sparkGeometry;
  if (!geometry) return;
  geometry.cursor.setAttribute("visibility", "hidden");
  geometry.tip.hidden = true;
}

for (const [key, card] of cards) {
  const spark = card.querySelector(".spark");
  spark.addEventListener("pointermove", event => {
    const entry = sparkState.get(key);
    const geometry = spark.sparkGeometry;
    if (!entry?.points.length || !geometry) return;
    const px = event.clientX - spark.getBoundingClientRect().left;
    let nearest = 0;
    entry.points.forEach((point, i) => { if (Math.abs(geometry.x(point.t) - px) < Math.abs(geometry.x(entry.points[nearest].t) - px)) nearest = i; });
    showSparkPoint(key, nearest);
  });
  spark.addEventListener("pointerleave", () => { if (document.activeElement !== spark) hideSparkPoint(key); });
  spark.addEventListener("focus", () => showSparkPoint(key, sparkState.get(key)?.index ?? 0));
  spark.addEventListener("blur", () => hideSparkPoint(key));
  spark.addEventListener("keydown", event => {
    const entry = sparkState.get(key);
    if (!entry?.points.length) return;
    const moves = { ArrowLeft: entry.index - 1, ArrowRight: entry.index + 1, Home: 0, End: entry.points.length - 1 };
    if (event.key === "Escape") { hideSparkPoint(key); return; }
    if (!(event.key in moves)) return;
    event.preventDefault();
    const point = showSparkPoint(key, moves[event.key]);
    if (point) announce(`${singaporeClock(point.t)}: ${formatValue(entry.metric, point.v)}`);
  });
}

function renderTable(series, metric) {
  const config = METRICS[metric];
  byId("history-caption").textContent = `${config.label}${metric === "pm25" ? " (µg/m³)" : ""} by hour, Singapore time`;
  byId("history-body").replaceChildren(...[...series].reverse().map(point => {
    const row = document.createElement("tr");
    const hour = document.createElement("th");
    hour.scope = "row";
    hour.textContent = singaporeClock(point.t);
    row.append(hour, ...REGIONS.map(key => Object.assign(document.createElement("td"), { textContent: point[key] })));
    return row;
  }));
}

/* ---------- PM2.5 overview: regions by hour ---------- */

const hourFormat = new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", hour: "numeric", hour12: true });
const heat = byId("heat");
const heatTip = byId("heat-tip");
const overview = { columns: [], byTime: new Map(), row: 0, column: 0 };

function renderOverview() {
  const table = byId("heat-table");
  const series = seriesFor("pm25");
  const end = series.at(-1)?.t;
  if (series.length < 2) {
    overview.columns = [];
    table.tHead.replaceChildren();
    table.tBodies[0].replaceChildren();
    heat.hidden = true;
    byId("heat-legend").hidden = true;
    byId("overview-summary").textContent = state.history ? "The last 24 hours of PM2.5 appear after a few hourly readings." : "Loading the last 24 hours";
    return;
  }
  // One column per hour, oldest on the left; hours without a complete reading stay empty.
  overview.columns = Array.from({ length: 25 }, (_, i) => end - (24 - i) * HOUR);
  overview.byTime = new Map(series.map(point => [point.t, point]));
  overview.column = overview.columns.length - 1;
  overview.row = Math.min(overview.row, REGIONS.length - 1);

  const head = document.createElement("tr");
  const corner = document.createElement("th");
  corner.scope = "col";
  corner.className = "heat-corner";
  corner.append(Object.assign(document.createElement("span"), { className: "sr-only", textContent: "Region" }));
  head.append(corner, ...overview.columns.map((t, i) => {
    const th = document.createElement("th");
    th.scope = "col";
    const fromEnd = overview.columns.length - 1 - i;
    th.className = fromEnd % 6 === 0 ? "is-major" : fromEnd % 3 === 0 ? "is-minor" : "is-unlabelled";
    th.append(Object.assign(document.createElement("span"), { className: "heat-hour", textContent: hourFormat.format(t) }));
    return th;
  }));
  table.tHead.replaceChildren(head);

  const present = new Set();
  table.tBodies[0].replaceChildren(...REGIONS.map((key, row) => {
    const tr = document.createElement("tr");
    const th = Object.assign(document.createElement("th"), { scope: "row", textContent: regionName(key) });
    tr.append(th, ...overview.columns.map((t, column) => {
      const value = overview.byTime.get(t)?.[key];
      const band = pm25Band(value);
      if (Number.isFinite(value)) present.add(band.key);
      const td = document.createElement("td");
      td.dataset.band = band.key;
      td.dataset.row = row;
      td.dataset.column = column;
      td.append(Object.assign(document.createElement("span"), { className: "heat-value", textContent: Number.isFinite(value) ? value : "No reading" }));
      return td;
    }));
    return tr;
  }));
  heat.hidden = false;

  byId("heat-legend").hidden = false;
  byId("heat-legend").replaceChildren(...PM25_BANDS.map(band => {
    const item = document.createElement("li");
    item.dataset.band = band.key;
    item.classList.toggle("is-present", present.has(band.key));
    const range = Object.assign(document.createElement("span"), { className: "legend-range", textContent: band.range });
    item.append(`${band.label} (${band.band})`, " ", range);
    return item;
  }));

  const readings = overview.columns.flatMap(t => REGIONS.map(key => ({ t, key, value: overview.byTime.get(t)?.[key] })))
    .filter(reading => Number.isFinite(reading.value));
  const peak = Math.max(...readings.map(reading => reading.value));
  const peakAt = readings.filter(reading => reading.value === peak).at(-1).t;
  const peakWhere = regionList(REGIONS.filter(key => overview.byTime.get(peakAt)?.[key] === peak));
  const highHours = overview.columns.filter(t => REGIONS.some(key => ["III", "IV"].includes(pm25Band(overview.byTime.get(t)?.[key]).band))).length;
  const hours = overview.columns.filter(t => overview.byTime.has(t)).length;
  const [day, clock] = singaporeClock(peakAt).split(", ");
  byId("overview-summary").textContent = `Highest: ${peak} µg/m³ (${pm25Band(peak).label.toLowerCase()}) in ${peakWhere} at ${clock ? `${clock} on ${day}` : day}. ` +
    (highHours ? `High or very high in at least one region in ${highHours} of the last ${hours} hourly readings.`
      : `Normal or elevated everywhere in the last ${hours} hourly readings.`);
  hideHeatCell();
}

function showHeatCell(row, column) {
  if (!overview.columns.length) return null;
  overview.row = Math.max(0, Math.min(REGIONS.length - 1, row));
  overview.column = Math.max(0, Math.min(overview.columns.length - 1, column));
  const cell = byId("heat-table").tBodies[0].rows[overview.row].cells[overview.column + 1];
  heat.querySelector("td.is-active")?.classList.remove("is-active");
  cell.classList.add("is-active");
  const t = overview.columns[overview.column], key = REGIONS[overview.row];
  const value = overview.byTime.get(t)?.[key];
  const strong = document.createElement("strong");
  strong.textContent = Number.isFinite(value) ? formatValue("pm25", value) : "No reading";
  const label = `${regionName(key)}, ${singaporeClock(t)}`;
  heatTip.replaceChildren(strong, Number.isFinite(value) ? `${pm25Band(value).label} · ${label}` : label);
  heatTip.hidden = false;
  const box = heat.getBoundingClientRect(), rect = cell.getBoundingClientRect();
  const half = heatTip.offsetWidth / 2;
  heatTip.style.left = `${Math.max(half, Math.min(box.width - half, rect.left - box.left + rect.width / 2))}px`;
  heatTip.style.top = `${rect.top - box.top - 6}px`;
  return { key, t, value };
}

function hideHeatCell() {
  heat.querySelector("td.is-active")?.classList.remove("is-active");
  heatTip.hidden = true;
}

function pointHeatCell(event) {
  const cell = event.target.closest("td[data-column]");
  if (cell) showHeatCell(Number(cell.dataset.row), Number(cell.dataset.column));
}
heat.addEventListener("pointermove", pointHeatCell);
heat.addEventListener("pointerdown", pointHeatCell);
// Touch pointers "leave" as soon as the finger lifts, so a tapped reading stays up until the next tap.
heat.addEventListener("pointerleave", event => { if (event.pointerType !== "touch" && document.activeElement !== heat) hideHeatCell(); });
heat.addEventListener("focus", () => showHeatCell(overview.row, overview.column));
heat.addEventListener("blur", hideHeatCell);
heat.addEventListener("keydown", event => {
  if (event.key === "Escape") { hideHeatCell(); return; }
  const moves = {
    ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0],
    Home: [0, -overview.columns.length], End: [0, overview.columns.length]
  };
  if (!(event.key in moves) || !overview.columns.length) return;
  event.preventDefault();
  const [rows, columns] = moves[event.key];
  const reading = showHeatCell(overview.row + rows, overview.column + columns);
  if (reading) announce(`${regionName(reading.key)}, ${singaporeClock(reading.t)}: ${Number.isFinite(reading.value) ? `${formatValue("pm25", reading.value)}, ${pm25Band(reading.value).label}` : "no reading"}`);
});

/* ---------- Haze shelters ---------- */

byId("shelters-meta").textContent = `Air-conditioned rooms at ${SHELTERS.length} community clubs and residents’ centres, from the People’s Association list as at ${SHELTERS_AS_AT}`;

function renderShelterStatus() {
  const regions = state.data?.regions ?? [];
  const status = byId("shelter-status");
  if (!regions.length) return;
  const highest = Math.max(...regions.map(region => region.psi));
  const where = regionList(regions.filter(region => region.psi === highest).map(region => region.key));
  status.dataset.band = category(highest).key;
  status.textContent = shelterNotice(highest, where);
  byId("shelter-jump").hidden = highest <= 200;
}

function setShelterMessage(text, results = []) {
  byId("shelter-message").textContent = text;
  byId("shelter-list").replaceChildren(...results);
  byId("shelter-results").classList.toggle("is-empty", !results.length);
}

function shelterItem(shelter) {
  const item = Object.assign(document.createElement("li"), { className: "shelter" });
  const body = Object.assign(document.createElement("div"), { className: "shelter-body" });
  body.append(
    Object.assign(document.createElement("h3"), { className: "shelter-name", textContent: shelter.name }),
    Object.assign(document.createElement("p"), { className: "shelter-address", textContent: `${shelter.address}, Singapore ${shelter.postal}` }),
    Object.assign(document.createElement("p"), { className: "shelter-kind", textContent: SHELTER_KINDS[shelter.kind] })
  );
  const side = Object.assign(document.createElement("div"), { className: "shelter-side" });
  const link = Object.assign(document.createElement("a"), {
    className: "shelter-link", textContent: "Directions", target: "_blank", rel: "noopener noreferrer",
    href: directionsUrl(shelter)
  });
  link.append(Object.assign(document.createElement("span"), { className: "sr-only", textContent: ` to ${shelter.name} in Google Maps` }));
  side.append(Object.assign(document.createElement("p"), { className: "shelter-distance", textContent: formatDistance(shelter.km) }), link);
  item.append(body, side);
  return item;
}

function showShelters(origin, label) {
  const closest = nearest(origin, SHELTERS, 5);
  setShelterMessage(closest[0].km > 30
    ? `The nearest shelter is ${formatDistance(closest[0].km)} from ${label}. These shelters are in Singapore only.`
    : `Nearest to ${label}`, closest.map(shelterItem));
}

function setFinderBusy(busy) {
  for (const id of ["locate-button", "postal-button"]) byId(id).disabled = busy;
}

byId("locate-button").addEventListener("click", () => {
  if (!navigator.geolocation) {
    setShelterMessage("This browser can’t share your location. Enter a postal code instead.");
    return;
  }
  setFinderBusy(true);
  setShelterMessage("Finding your location");
  navigator.geolocation.getCurrentPosition(position => {
    setFinderBusy(false);
    showShelters({ lat: position.coords.latitude, lng: position.coords.longitude }, "your location");
  }, error => {
    setFinderBusy(false);
    setShelterMessage(error.code === error.PERMISSION_DENIED
      ? "Location access is off for this site. Enter a postal code instead."
      : "Couldn’t get your location. Try again, or enter a postal code.");
  }, { enableHighAccuracy: false, timeout: 15_000, maximumAge: 5 * 60_000 });
});

byId("postal-form").addEventListener("submit", async event => {
  event.preventDefault();
  const input = byId("postal-input");
  const code = input.value.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) {
    input.setAttribute("aria-invalid", "true");
    setShelterMessage("Enter a six-digit postal code.");
    input.focus();
    return;
  }
  input.removeAttribute("aria-invalid");
  setFinderBusy(true);
  setShelterMessage(`Looking up ${code}`);
  try {
    const response = await fetch(`/api/postal?code=${code}`, { signal: AbortSignal.timeout(12_000) });
    if (response.status === 404) {
      setShelterMessage(`Couldn’t find postal code ${code}. Check the number and try again.`);
      return;
    }
    if (!response.ok) throw new Error("Lookup unavailable");
    const place = await response.json();
    if (!Number.isFinite(place?.lat) || !Number.isFinite(place?.lng)) throw new Error("Invalid lookup");
    showShelters(place, `postal code ${code}`);
  } catch {
    setShelterMessage("Postal code lookup is unavailable right now. Use your location, or try again shortly.");
  } finally {
    setFinderBusy(false);
  }
});

/* ---------- Loading ---------- */

function validSnapshot(data) {
  return Array.isArray(data?.regions) && data.regions.length === 5 &&
    REGIONS.every(key => data.regions.some(r => r.key === key && Number.isInteger(r.psi) && r.psi >= 0)) &&
    Number.isFinite(Date.parse(data.readingAt)) && Number.isFinite(Date.parse(data.sourceUpdatedAt)) && Number.isFinite(Date.parse(data.fetchedAt));
}

async function loadHistory(key) {
  try {
    const response = await fetch("/api/history", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("History unavailable");
    const history = await response.json();
    if (!Array.isArray(history.psi) || !Array.isArray(history.pm25)) throw new Error("Invalid history");
    state.history = history;
    state.historyKey = key;
  } catch {
    state.history ??= { psi: [], pm25: [] };
  }
  renderTrends();
  renderOverview();
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  const button = byId("refresh-button");
  button.disabled = true;
  button.classList.add("is-loading");
  byId("refresh-label").textContent = "Checking";
  byId("regions").setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/psi", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Readings unavailable");
    const data = await response.json();
    if (!validSnapshot(data)) throw new Error("Invalid readings");
    const readingKey = `${data.readingAt}|${validPm25(data.pm25) ? data.pm25.readingAt : ""}`;
    const previous = state.data && `${state.data.readingAt}|${validPm25(state.data.pm25) ? state.data.pm25.readingAt : ""}`;
    state.data = data;
    state.offline = false;
    if (previous && previous !== readingKey) markNewReading();
    render();
    if (state.historyKey !== readingKey) loadHistory(readingKey);
  } catch {
    state.offline = Boolean(state.data);
    if (state.data) {
      byId("notice").textContent = "Couldn’t reach Hazey to check for updates. Showing the last loaded readings; check their reading time.";
      byId("notice").hidden = false;
      renderLive();
    } else {
      byId("live").dataset.state = "error";
      byId("live-label").textContent = "Readings unavailable";
      byId("verdict-headline").textContent = "Readings are unavailable right now";
      byId("verdict-detail").textContent = "NEA readings could not be loaded. Select Check for updates to try again.";
      for (const card of cards.values()) {
        card.classList.remove("is-loading");
        setText(card, ".reading-value", "—");
        setBadge(card.querySelector(".primary-badge"), category(NaN));
      }
    }
  } finally {
    state.loading = false;
    button.disabled = false;
    button.classList.remove("is-loading");
    byId("refresh-label").textContent = "Check for updates";
    byId("regions").setAttribute("aria-busy", "false");
  }
}

function markNewReading() {
  state.newUntil = Date.now() + 12_000;
  for (const card of cards.values()) {
    card.classList.remove("is-new");
    void card.offsetWidth;
    card.classList.add("is-new");
  }
  announce("New NEA readings loaded.");
  setTimeout(renderLive, 12_100);
}

/* ---------- Controls ---------- */

const metricSwitch = byId("metric-switch");
function setMetric(metric, focus = false) {
  state.metric = metric;
  storage.set("hazey-metric", metric);
  metricSwitch.dataset.metric = metric;
  for (const button of metricSwitch.querySelectorAll("button")) {
    const selected = button.dataset.metric === metric;
    button.setAttribute("aria-checked", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  render();
}
metricSwitch.addEventListener("click", event => {
  const button = event.target.closest("button[data-metric]");
  if (button) setMetric(button.dataset.metric);
});
metricSwitch.addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  setMetric(state.metric === "psi" ? "pm25" : "psi", true);
});

const root = document.documentElement;
const isDark = () => (root.dataset.theme ?? (darkScheme.matches ? "dark" : "light")) === "dark";
function syncThemeButton() {
  const label = isDark() ? "Use light theme" : "Use dark theme";
  byId("theme-toggle").setAttribute("aria-label", label);
  byId("theme-toggle").title = label;
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue("--paper").trim();
}
byId("theme-toggle").addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  root.dataset.theme = next;
  storage.set("hazey-theme", next);
  syncThemeButton();
});
darkScheme.addEventListener("change", syncThemeButton);

byId("refresh-button").addEventListener("click", load);
byId("telegram-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("/psi");
    byId("telegram-copy").textContent = "Copied /psi";
    announce("Copied /psi to your clipboard.");
    setTimeout(() => { byId("telegram-copy").textContent = "Copy /psi"; }, 2500);
  } catch {
    announce("Copy unavailable. Type /psi in Telegram.");
    byId("telegram-copy").textContent = "Type /psi in Telegram";
  }
});

let resizeFrame = 0;
const resizeObserver = new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { placeMapLabels(); if (state.data) renderTrends(); });
});
for (const element of [map, byId("regions")]) resizeObserver.observe(element);

buildMap();
setMetric(state.metric);
syncThemeButton();
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden) load(); }, 60_000);
setInterval(renderLive, 20_000);
load();
