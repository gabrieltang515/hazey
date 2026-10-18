import test from "node:test";
import assert from "node:assert/strict";
import { channelPost } from "../src/broadcast.js";

const KEYS = ["north", "south", "east", "west", "central"];
const AT = "2026-10-18T03:00:00.000Z"; // 11:00 am SGT
const NOW = Date.parse("2026-10-18T03:10:00.000Z");
const APP = "https://hazey.example";
const OPTIONS = { appUrl: APP, botUsername: "hazey_psi_bot" };
const FOOTER = '<a href="https://hazey.example">Hazey dashboard</a> · '
  + '<a href="https://www.nea.gov.sg/our-services/pollution-control/air-pollution/managing-haze">MOH advice via NEA</a> · '
  + 'Data: <a href="https://data.gov.sg/datasets/d_fe37906a0182569d891506e815e819b7/view">NEA via data.gov.sg</a>';

// A saved snapshot as broadcastChannel reads it. An undefined PM2.5 value leaves that region out; null PM2.5 means none saved.
function snapshot(psi, pm25 = [48, 62, 71, 96, 80], pm25At = AT) {
  const name = key => key[0].toUpperCase() + key.slice(1);
  return {
    readingAt: AT, sourceUpdatedAt: AT, fetchedAt: "2026-10-18T03:05:00.000Z",
    regions: KEYS.map((key, index) => ({ key, name: name(key), psi: psi[index] })),
    pm25: pm25 && { readingAt: pm25At, sourceUpdatedAt: pm25At, fetchedAt: "2026-10-18T03:05:00.000Z",
      regions: KEYS.flatMap((key, index) => pm25[index] === undefined ? [] : [{ key, name: name(key), pm25: pm25[index] }]) }
  };
}

// Telegram rejects a whole post whose HTML doesn't parse. Posts use only <b>, <i> and <a href>, close every tag,
// and write & < > as entities everywhere else.
const TAG = /<(\/?)([a-z]+)(?: href="[^"]*")?>/g;
function assertTelegramHtml(text) {
  const open = [];
  for (const [, closing, tag] of text.matchAll(TAG)) {
    assert.ok(["b", "i", "a"].includes(tag), `unexpected <${tag}>`);
    if (closing) assert.equal(open.pop(), tag, `</${tag}> closes the wrong tag`);
    else open.push(tag);
  }
  assert.deepEqual(open, [], "every tag is closed");
  assert.doesNotMatch(text.replace(TAG, ""), /[<>]/, "no stray < or >");
  assert.doesNotMatch(text, /&(?!(?:amp|lt|gt|quot);)/, "& only starts an entity");
}

test("a breach post reads as approved: headline, bands, regions with arrows, advice, shelters, masks and links", () => {
  const post = channelPost(snapshot([124, 158, 171, 206, 189]), "breach",
    { ...OPTIONS, masks: { cc: 113, vending: 37 }, previous: { north: 120, south: 158, east: 175, west: 202 } }, NOW);
  assert.equal(post.text, [
    "⚠️ <b>Haze alert: PSI 206 in the West region</b>",
    "🟠 Unhealthy to 🔴 Very unhealthy · 18 Oct, 11:00 am SGT",
    "",
    "🟠 North <b>124</b> ↑4 · PM2.5 48",
    "🟠 South <b>158</b> ±0 · PM2.5 62",
    "🟠 East <b>171</b> ↓4 · PM2.5 71",
    "🔴 West <b>206</b> ↑4 · PM2.5 96",
    "🟠 Central <b>189</b> · PM2.5 80",
    "<i>24-hour PSI (↑↓ since 10:00 am) · 1-hour PM2.5 in µg/m³</i>",
    "",
    "🩺 <b>Health advice</b> · for PSI 206",
    "• Healthy people: avoid lengthy or strenuous outdoor exertion.",
    "• Older people, pregnant women and children: minimise outdoor activity.",
    "• People with chronic lung or heart conditions: avoid outdoor activity.",
    "If you feel unwell, seek medical attention, especially if you are in a vulnerable group.",
    "",
    "🏠 <b>Haze shelters</b>",
    "NEA opens haze shelters when the 24-hour PSI is above 200. Call the centre before you go to confirm the room and its opening hours. Nearest: send /shelter to @hazey_psi_bot",
    "",
    "😷 <b>Free N95 masks</b>",
    "Eligible groups can collect them at 113 CC counters and 37 vending machines. Nearest: send /masks to @hazey_psi_bot · Live stock: go.gov.sg/hazemask",
    "",
    FOOTER
  ].join("\n"));
  assert.equal(post.parse_mode, "HTML");
  assert.deepEqual(post.link_preview_options, { is_disabled: true });
  assert.deepEqual(post.reply_markup.inline_keyboard, [
    [{ text: "📊 Hazey dashboard", url: APP }],
    [{ text: "🏠 Nearest shelter", url: `${APP}/#shelters` }, { text: "😷 Free N95 masks", url: `${APP}/#masks` }]
  ]);
  assertTelegramHtml(post.text);
});

test("a regular post on a normal day is short: one band, one-line advice, no shelters, dashboard button only", () => {
  const post = channelPost(snapshot([62, 58, 71, 66, 60], [18, 22, 25, 20, 19]), "regular", OPTIONS, NOW);
  assert.equal(post.text, [
    "🟡 <b>Air quality update: PSI 58–71</b>",
    "🟡 Moderate · 18 Oct, 11:00 am SGT",
    "",
    "🟡 North <b>62</b> · PM2.5 18",
    "🟡 South <b>58</b> · PM2.5 22",
    "🟡 East <b>71</b> · PM2.5 25",
    "🟡 West <b>66</b> · PM2.5 20",
    "🟡 Central <b>60</b> · PM2.5 19",
    "<i>24-hour PSI · 1-hour PM2.5 in µg/m³</i>",
    "",
    "🩺 <b>Health advice:</b> normal activities can continue for all groups.",
    "",
    FOOTER
  ].join("\n"));
  assert.deepEqual(post.reply_markup.inline_keyboard, [[{ text: "📊 Hazey dashboard", url: APP }]]);
  assertTelegramHtml(post.text);
});

test("an hourly Hazardous post gives the band range, the advice for the highest PSI and the 10 pm shelter hours", () => {
  const post = channelPost(snapshot([180, 240, 260, 312, 290]), "hourly", OPTIONS, NOW);
  assert.ok(post.text.startsWith("🟣 <b>Hourly haze update: PSI 180–312</b>\n🟠 Unhealthy to 🟣 Hazardous · 18 Oct, 11:00 am SGT\n"));
  assert.ok(post.text.includes("\n🟣 West <b>312</b> · PM2.5 96\n"));
  assert.ok(post.text.includes("\n🩺 <b>Health advice</b> · for PSI 312\n• Healthy people: minimise outdoor activity.\n"));
  assert.ok(post.text.includes("\n🏠 <b>Haze shelters</b>\nThe 24-hour PSI is Hazardous in the West region. NEA says haze shelters at community clubs stay open until 10 pm. Call the centre"));
  assert.deepEqual(post.reply_markup.inline_keyboard, [[{ text: "📊 Hazey dashboard", url: APP }], [{ text: "🏠 Nearest shelter", url: `${APP}/#shelters` }]]);
  assertTelegramHtml(post.text);
});

test("headlines name tied regions and show a single value once; the band line names one band or the range of bands", () => {
  const tie = channelPost(snapshot([124, 158, 171, 206, 206]), "breach", OPTIONS, NOW).text;
  assert.ok(tie.startsWith("⚠️ <b>Haze alert: PSI 206 in the West and Central regions</b>\n"));
  const flat = channelPost(snapshot([60, 60, 60, 60, 60]), "regular", OPTIONS, NOW).text;
  assert.ok(flat.startsWith("🟡 <b>Air quality update: PSI 60</b>\n🟡 Moderate · "));
  const mixed = channelPost(snapshot([30, 45, 50, 51, 40]), "regular", OPTIONS, NOW).text;
  assert.ok(mixed.startsWith("🟡 <b>Air quality update: PSI 30–51</b>\n🟢 Good to 🟡 Moderate · "));
});

test("PM2.5 from another hour, delayed, missing for a region, absent or in the future is labelled, not hidden", () => {
  const psi = [62, 58, 71, 66, 60];
  const delayed = channelPost(snapshot(psi, [18, 22, 25, 20, 19], "2026-10-18T00:00:00.000Z"), "regular", OPTIONS, NOW).text;
  assert.ok(delayed.includes("\n<i>24-hour PSI · 1-hour PM2.5 at 8:00 am in µg/m³</i>\n⚠️ PM2.5 is delayed; showing the 8:00 am readings.\n"));
  const gap = channelPost(snapshot(psi, [18, 22, 25, undefined, 19]), "regular", OPTIONS, NOW).text;
  assert.ok(gap.includes("\n🟡 West <b>66</b> · PM2.5 n/a\n"));
  const none = channelPost(snapshot(psi, null), "regular", OPTIONS, NOW).text;
  assert.ok(none.includes("\n🟡 North <b>62</b>\n"));
  assert.ok(none.includes("\n<i>24-hour PSI · PM2.5 unavailable</i>\n"));
  const future = channelPost(snapshot(psi, [18, 22, 25, 20, 19], "2026-10-18T04:00:00.000Z"), "regular", OPTIONS, NOW).text;
  assert.equal(future, none);
  for (const text of [delayed, gap, none]) assertTelegramHtml(text);
});

test("trend arrows compare with the saved hour before and are left out where that hour is missing or unusable", () => {
  const psi = [124, 158, 171, 206, 189];
  const without = channelPost(snapshot(psi), "hourly", { ...OPTIONS, previous: null }, NOW).text;
  assert.doesNotMatch(without, /[↑↓±]/);
  assert.ok(without.includes("\n<i>24-hour PSI · 1-hour PM2.5 in µg/m³</i>\n"));
  const partial = channelPost(snapshot(psi), "hourly", { ...OPTIONS, previous: { north: "120", south: -1, east: 171.5, west: 200 } }, NOW).text;
  assert.ok(partial.includes("\n🟠 North <b>124</b> · PM2.5 48\n🟠 South <b>158</b> · PM2.5 62\n🟠 East <b>171</b> · PM2.5 71\n🔴 West <b>206</b> ↑6 · PM2.5 96\n"));
  assert.ok(partial.includes("<i>24-hour PSI (↑↓ since 10:00 am) · "));
  // A midnight reading compares with 11 pm the day before.
  const midnight = { ...snapshot(psi), readingAt: "2026-10-17T16:00:00.000Z" };
  assert.ok(channelPost(midnight, "hourly", { ...OPTIONS, previous: { west: 206 } }, NOW).text.includes("(↑↓ since 17 Oct, 11:00 pm)"));
});

test("inserted text is HTML-escaped so Telegram can always parse the post", () => {
  const unsafe = snapshot([124, 158, 171, 206, 189]);
  unsafe.regions[0].name = "North <&>";
  const post = channelPost(unsafe, "breach", { appUrl: 'https://hazey.example/?a="1"&b=<2>', botUsername: "a&b<c>" }, NOW);
  assert.ok(post.text.includes("\n🟠 North &lt;&amp;&gt; <b>124</b> · PM2.5 48\n"));
  assert.ok(post.text.includes("Nearest: send /shelter to @a&amp;b&lt;c&gt;\n"));
  assert.ok(post.text.includes('<a href="https://hazey.example/?a=&quot;1&quot;&amp;b=&lt;2&gt;">Hazey dashboard</a>'));
  assertTelegramHtml(post.text);
});
