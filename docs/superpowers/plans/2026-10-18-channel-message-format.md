# Channel Message Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reformat `@hazey_sg` channel posts as approved: a headline that says how bad the air is, coloured band dots, bold PSI with change-since-last-hour arrows, compact advice, shelter and mask blocks, and text links instead of raw URLs.

**Architecture:**
- **Formatter:** a new pure function `channelPost(snapshot, kind, options, now)` in `src/broadcast.js` builds the whole `sendMessage` payload except `chat_id`: the HTML text, `parse_mode`, link previews off, and the buttons. It replaces `channelMessage` and the inline button code.
- **Arrows:** `broadcastChannel` reads the saved PSI history row from one hour before the reading and passes it in as `previous`.
- **Unchanged:** when posts are sent, the D1 state, and bot replies.

**Tech Stack:** Cloudflare Workers (plain ESM), D1, Telegram Bot API `sendMessage` with `parse_mode: "HTML"`, `node --test` with `node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-10-18-channel-message-format-design.md`

## Global Constraints

- **Cloudflare Free only.** Use the existing Worker `hazey` and D1 binding `PSI_DB`. No migration and no new vars, secrets or resources.
- **Code style:** plain ESM, no new dependencies. Match the surrounding code: terse comments, compact expressions, sentence-case commit messages without prefixes, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Times:** Asia/Singapore, through the formatters in `public/psi.js`.
- **HTML:** posts use only `<b>`, `<i>` and `<a href="…">`. Every inserted value is escaped (`&`, `<`, `>`, `"`).
- **Notifications:** do not add `disable_notification`. Every post notifies as it does today.
- **Unchanged:** bot replies, the dashboard, `shelterNotice`, the breach/hourly/regular rules and the `channel_broadcasts` lease.
- **Logs:** never log tokens.
- **Deploying:** posts go to a public channel, so deploy only after the owner says go.
- **Running commands:** `npm test` from the repository root. Node 22 and `npx` are on PATH. If they aren't, use `sh scripts/hazey.sh test` and `sh scripts/hazey.sh deploy`.
- **Branch:** `channel-format`, which already holds the spec commit.

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `public/psi.js` | modify | Add `singaporeDayTime` ("18 Oct, 11:00 am") |
| `src/broadcast.js` | modify | `channelPost` formatter (replaces `channelMessage`); `healthAdvice` returns an array; `previousHour` lookup; `broadcastChannel` sends `channelPost` |
| `tests/broadcast.test.js` | create | Unit tests for `channelPost`: exact approved posts, variants, arrows, escaping, Telegram-safe HTML |
| `tests/worker.test.js` | modify | Existing channel tests move to the new wording; new end-to-end arrow test through D1 |
| `README.md` | modify | "Automated channel reports" describes the new post |
| `HANDOVER.md` | modify | Deployed state and verification |

---

### Task 1: New channel post format

**Files:**
- Modify: `public/psi.js` (after `singaporeTime`, around line 64)
- Modify: `src/broadcast.js`: lines 1–68 (imports through the end of `channelMessage`) and the send block in `broadcastChannel` (lines 106–120)
- Create: `tests/broadcast.test.js`
- Modify: `tests/worker.test.js` (five channel tests, listed in Step 3)

**Interfaces:**
- Produces:
  - `singaporeDayTime(timestamp) → string`, e.g. `"18 Oct, 11:00 am"`
  - `channelPost(snapshot, kind, { appUrl = null, botUsername = null, masks = null, previous = null } = {}, now = Date.now())`, which returns `{ text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup? }`
    - `kind` is `"breach"`, `"hourly"` or `"regular"`.
    - `previous` is `{ north, south, east, west, central }` PSI from an hour before, or `null`.
    - `masks` is `{ cc, vending }`, or `null`.
  - `healthAdvice(psi) → string[]`. It now returns an array; nothing outside `src/broadcast.js` uses it.
- Consumes: `category`, `regionList`, `singaporeClock`, `SOURCE_URL` from `public/psi.js`; `maskPlaces`, `MASK_SHORT_URL` from `public/masks.js`; `isStale` from `src/psi.js`.

- [ ] **Step 1: Write the unit tests**

Create `tests/broadcast.test.js`:

```js
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
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `node --test tests/broadcast.test.js`
Expected: FAIL. The file can't load: `The requested module '../src/broadcast.js' does not provide an export named 'channelPost'`.

- [ ] **Step 3: Move the existing channel tests in `tests/worker.test.js` to the new wording**

The behaviour each test checks is unchanged; only the expected text and button rows change. Make these five replacements.

In `"channel regular reports follow 6am-anchored four-hour SGT slots, including 2am, once per slot"`, replace:

```js
  assert.match(messages[0].text, /Overall Singapore.*120–150/);
  assert.match(messages[0].text, /North: PSI 120.*PM2.5 55/);
  assert.match(messages[0].text, /Central: PSI 150.*PM2.5 151/);
  assert.match(messages[0].text, /1-hour PM2.5.*µg\/m³/);
  assert.match(messages[0].text, /https:\/\/hazey.example/);
```

with:

```js
  assert.equal(messages[0].parse_mode, "HTML");
  assert.match(messages[0].text, /^🟠 <b>Air quality update: PSI 120–150<\/b>\n/);
  assert.match(messages[0].text, /\n🟠 North <b>120<\/b> · PM2.5 55\n/);
  assert.match(messages[0].text, /\n🟠 Central <b>150<\/b> · PM2.5 151\n/);
  assert.match(messages[0].text, /1-hour PM2.5 in µg\/m³/);
  assert.match(messages[0].text, /<a href="https:\/\/hazey.example">Hazey dashboard<\/a>/);
```

In `"breach alerts immediately, then hourly, holds at 200, clears silently and resumes the fixed schedule"`, replace:

```js
  assert.match(messages[0].text, /PSI alert/);
```

with:

```js
  assert.match(messages[0].text, /^⚠️ <b>Haze alert: PSI 201 in the West region<\/b>\n/);
```

In `"normal channel advice includes the 100/101 and 300/301 boundaries"`, replace:

```js
  assert.match(messages[0].text, /Normal activities/);
```

with:

```js
  assert.match(messages[0].text, /normal activities can continue for all groups/);
```

In `"channel posts above 200 point to haze shelters, add the 10 pm hours when Hazardous, and omit them at 200 or below"`, replace:

```js
  assert.match(messages[0].text, /Haze shelters:\nThe 24-hour PSI is 206 in the West region, above 200, the level at which NEA opens haze shelters\.\nFind the nearest: https:\/\/hazey\.example\/#shelters or send \/shelter to @hazey_psi_bot\nCall the centre before you go/);
  assert.deepEqual(messages[0].reply_markup.inline_keyboard.map(row => row[0].url), ["https://hazey.example", "https://hazey.example/#shelters"]);
  await tick("2026-10-14T16:00:00+08:00", 305);
  assert.match(messages[1].text, /The 24-hour PSI is 305 in the West region, in the Hazardous range\. NEA says haze shelters at community clubs stay open until 10 pm\./);
```

with:

```js
  assert.ok(messages[0].text.includes("\n🏠 <b>Haze shelters</b>\nNEA opens haze shelters when the 24-hour PSI is above 200. Call the centre before you go to confirm the room and its opening hours. Nearest: send /shelter to @hazey_psi_bot\n"));
  assert.deepEqual(messages[0].reply_markup.inline_keyboard.map(row => row.map(button => button.url)), [["https://hazey.example"], ["https://hazey.example/#shelters"]]);
  await tick("2026-10-14T16:00:00+08:00", 305);
  assert.match(messages[1].text, /The 24-hour PSI is Hazardous in the West region\. NEA says haze shelters at community clubs stay open until 10 pm\./);
```

In `"channel posts point to free N95 masks while distribution is on, at any PSI level, and not when it is off"`, replace:

```js
  assert.ok(messages[0].text.includes(`\n\nFree N95 masks:\nEligible groups can collect free N95 masks at ${maskPlaces(maskCounts(MASK_SITES))}.\nFind one: https://hazey.example/#masks or send /masks to @hazey_psi_bot\nLive stock: go.gov.sg/hazemask\n\nMOH guidance`));
  assert.deepEqual(messages[0].reply_markup.inline_keyboard.map(row => row[0].url), ["https://hazey.example", "https://hazey.example/#masks"]);
  await tick("2026-10-14T06:20:00+08:00", 220);
  assert.match(messages[1].text, /Haze shelters:[\s\S]*Free N95 masks:/);
  assert.deepEqual(messages[1].reply_markup.inline_keyboard.map(row => row[0].url), ["https://hazey.example", "https://hazey.example/#shelters", "https://hazey.example/#masks"]);
```

with:

```js
  assert.ok(messages[0].text.includes(`\n\n😷 <b>Free N95 masks</b>\nEligible groups can collect them at ${maskPlaces(maskCounts(MASK_SITES))}. Nearest: send /masks to @hazey_psi_bot · Live stock: go.gov.sg/hazemask\n\n<a href="https://hazey.example">Hazey dashboard</a>`));
  assert.deepEqual(messages[0].reply_markup.inline_keyboard.map(row => row.map(button => button.url)), [["https://hazey.example"], ["https://hazey.example/#masks"]]);
  await tick("2026-10-14T06:20:00+08:00", 220);
  assert.match(messages[1].text, /Haze shelters<\/b>[\s\S]*Free N95 masks<\/b>/);
  assert.deepEqual(messages[1].reply_markup.inline_keyboard.map(row => row.map(button => button.url)), [["https://hazey.example"], ["https://hazey.example/#shelters", "https://hazey.example/#masks"]]);
```

Leave the rest of that test as it is. Its last line, `assert.equal(messages[2].reply_markup.inline_keyboard.length, 2);`, still holds: the dashboard row plus the shelter row.

- [ ] **Step 4: Run the whole suite to verify the expected failures**

Run: `npm test`
Expected: 66 tests, 60 pass, 6 fail. The failures are `tests/broadcast.test.js` (missing export) and the five tests edited in Step 3.

- [ ] **Step 5: Add `singaporeDayTime` to `public/psi.js`**

Directly after the `singaporeTime` function, add:

```js
// "18 Oct, 11:00 am": always dated, for channel posts that are read or forwarded later.
export function singaporeDayTime(timestamp) {
  const date = new Date(timestamp);
  return `${dayFormat.format(date)}, ${clockFormat.format(date)}`;
}
```

`dayFormat` and `clockFormat` are already defined above `singaporeTime`.

- [ ] **Step 6: Replace the formatter in `src/broadcast.js`**

Replace everything from line 1 down to the line just before `// The five-minute scheduled refresh is the only broadcaster. Commands never subscribe people.`. That covers the imports, `HOUR`, `ADVISORY_URL`, `healthAdvice` and `channelMessage`. Replace it with:

```js
import { SOURCE_URL, category, regionList, singaporeClock, singaporeDayTime } from "../public/psi.js";
import { MASK_SHORT_URL, maskCounts, maskPlaces } from "../public/masks.js";
import { isStale } from "./psi.js";
import { MASK_SITES } from "../public/mask-sites.js";
import { maskDistribution } from "./masks.js";
import { telegramApi } from "./telegram.js";

const HOUR = 60 * 60_000;
const ADVISORY_URL = "https://www.nea.gov.sg/our-services/pollution-control/air-pollution/managing-haze";

// Paraphrases of the MOH health advisory published by NEA, checked 14 October 2026.
// The greatest regional PSI determines the precautions; PM2.5 is a separate concentration.
export function healthAdvice(psi) {
  if (psi <= 100) return ["Normal activities can continue for all groups."];
  if (psi <= 200) return [
    "Healthy people: reduce lengthy or strenuous outdoor exertion.",
    "Older people, pregnant women and children: keep lengthy or strenuous outdoor exertion to a minimum.",
    "People with chronic lung or heart conditions: avoid lengthy or strenuous outdoor exertion."
  ];
  if (psi <= 300) return [
    "Healthy people: avoid lengthy or strenuous outdoor exertion.",
    "Older people, pregnant women and children: minimise outdoor activity.",
    "People with chronic lung or heart conditions: avoid outdoor activity."
  ];
  return [
    "Healthy people: minimise outdoor activity.",
    "Older people, pregnant women, children and people with chronic lung or heart conditions: avoid outdoor activity."
  ];
}

// Band dots in the dashboard's band colours.
const DOTS = { good: "🟢", moderate: "🟡", unhealthy: "🟠", "very-unhealthy": "🔴", hazardous: "🟣", unknown: "⚪" };
const dot = psi => DOTS[category(psi).key];

// Posts use Telegram's HTML mode, which rejects a whole post that doesn't parse, so every inserted value is escaped.
const escapeHtml = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const link = (url, text) => `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;

// " ↑4", " ↓3" or " ±0" against the PSI an hour earlier; nothing when that hour wasn't saved.
function trend(psi, before) {
  if (!Number.isInteger(before) || before < 0) return "";
  const change = psi - before;
  return change > 0 ? ` ↑${change}` : change < 0 ? ` ↓${-change}` : " ±0";
}

// The sendMessage fields of a channel post, apart from chat_id. `previous` is the saved { north, … } PSI an hour before
// this reading, or null. Above 200 (NEA's trigger for opening haze shelters) the post also points to the shelter finder.
// While free N95 masks are being given out (`masks`: { cc, vending } counts of the saved list), it points to the mask
// finder at any PSI level.
export function channelPost(snapshot, kind, { appUrl = null, botUsername = null, masks = null, previous = null } = {}, now = Date.now()) {
  const values = snapshot.regions.map(region => region.psi);
  const low = Math.min(...values), high = Math.max(...values);
  const lowBand = category(low).label, highBand = category(high).label;
  const readingAt = Date.parse(snapshot.readingAt);
  const where = regionList(snapshot.regions.filter(region => region.psi === high).map(region => region.key));
  const pm25 = snapshot.pm25 && Date.parse(snapshot.pm25.readingAt) <= now ? snapshot.pm25 : null;
  const range = low === high ? `${high}` : `${low}–${high}`;
  const headline = kind === "breach" ? `⚠️ <b>Haze alert: PSI ${high} in ${escapeHtml(where)}</b>`
    : `${dot(high)} <b>${kind === "hourly" ? "Hourly haze update" : "Air quality update"}: PSI ${range}</b>`;
  const bands = lowBand === highBand ? `${dot(high)} ${highBand}` : `${dot(low)} ${lowBand} to ${dot(high)} ${highBand}`;
  const arrows = snapshot.regions.map(region => trend(region.psi, previous?.[region.key]));
  const lines = [headline, escapeHtml(`${bands} · ${singaporeDayTime(readingAt)} SGT`), "",
    ...snapshot.regions.map((region, index) => {
      const pm = pm25?.regions.find(value => value.key === region.key);
      const pmText = pm25 ? ` · PM2.5 ${pm ? pm.pm25 : "n/a"}` : "";
      return `${dot(region.psi)} ${escapeHtml(region.name)} <b>${region.psi}</b>${arrows[index]}${pmText}`;
    })];
  const psiKey = arrows.some(Boolean) ? `24-hour PSI (↑↓ since ${singaporeClock(readingAt - HOUR, readingAt)})` : "24-hour PSI";
  const pmKey = !pm25 ? "PM2.5 unavailable"
    : Date.parse(pm25.readingAt) === readingAt ? "1-hour PM2.5 in µg/m³" : `1-hour PM2.5 at ${singaporeClock(pm25.readingAt, readingAt)} in µg/m³`;
  lines.push(`<i>${escapeHtml(`${psiKey} · ${pmKey}`)}</i>`);
  if (pm25 && isStale(pm25, now)) lines.push(escapeHtml(`⚠️ PM2.5 is delayed; showing the ${singaporeClock(pm25.readingAt, readingAt)} readings.`));
  if (high <= 100) lines.push("", "🩺 <b>Health advice:</b> normal activities can continue for all groups.");
  else lines.push("", `🩺 <b>Health advice</b> · for PSI ${high}`, ...healthAdvice(high).map(line => escapeHtml(`• ${line}`)),
    "If you feel unwell, seek medical attention, especially if you are in a vulnerable group.");
  if (high > 200) {
    const notice = high > 300 ? `The 24-hour PSI is Hazardous in ${where}. NEA says haze shelters at community clubs stay open until 10 pm.`
      : "NEA opens haze shelters when the 24-hour PSI is above 200.";
    const nearest = botUsername ? ` Nearest: send /shelter to @${botUsername}` : "";
    lines.push("", "🏠 <b>Haze shelters</b>", escapeHtml(`${notice} Call the centre before you go to confirm the room and its opening hours.${nearest}`));
  }
  if (masks) {
    const nearest = botUsername ? ` Nearest: send /masks to @${botUsername} ·` : "";
    lines.push("", "😷 <b>Free N95 masks</b>", escapeHtml(`Eligible groups can collect them at ${maskPlaces(masks)}.${nearest} Live stock: ${MASK_SHORT_URL}`));
  }
  lines.push("", [appUrl && link(appUrl, "Hazey dashboard"), link(ADVISORY_URL, "MOH advice via NEA"), `Data: ${link(SOURCE_URL, "NEA via data.gov.sg")}`]
    .filter(Boolean).join(" · "));
  const post = { text: lines.join("\n"), parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  if (appUrl) {
    const finders = [high > 200 && { text: "🏠 Nearest shelter", url: new URL("#shelters", appUrl).href },
      masks && { text: "😷 Free N95 masks", url: new URL("#masks", appUrl).href }].filter(Boolean);
    post.reply_markup = { inline_keyboard: [[{ text: "📊 Hazey dashboard", url: appUrl }], ...(finders.length ? [finders] : [])] };
  }
  return post;
}

```

`shelterNotice` is no longer imported here. The dashboard and bot still use it from `public/psi.js`.

- [ ] **Step 7: Send `channelPost` from `broadcastChannel`**

In `broadcastChannel`, replace:

```js
      const reply = { chat_id: channel, text: channelMessage(snapshot, breach ? "breach" : active ? "hourly" : "regular", { appUrl, botUsername, masks }, now),
        link_preview_options: { is_disabled: true } };
      if (appUrl) {
        reply.reply_markup = { inline_keyboard: [[{ text: "View Hazey dashboard", url: appUrl }]] };
        if (high > 200) reply.reply_markup.inline_keyboard.push([{ text: "Find a haze shelter", url: new URL("#shelters", appUrl).href }]);
        if (masks) reply.reply_markup.inline_keyboard.push([{ text: "Find free N95 masks", url: new URL("#masks", appUrl).href }]);
      }
      await telegramApi(env, "sendMessage", reply);
```

with:

```js
      const kind = breach ? "breach" : active ? "hourly" : "regular";
      await telegramApi(env, "sendMessage", { chat_id: channel, ...channelPost(snapshot, kind, { appUrl, botUsername, masks }, now) });
```

and replace:

```js
      console.log(`Channel broadcast sent (${breach ? "breach" : active ? "hourly" : "regular"})`);
```

with:

```js
      console.log(`Channel broadcast sent (${kind})`);
```

The log line stays `Channel broadcast sent (breach|hourly|regular)`, exactly as before.

- [ ] **Step 8: Run the whole suite to verify it passes**

Run: `npm test`
Expected: `# tests 72`, `# pass 72`, `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add public/psi.js src/broadcast.js tests/broadcast.test.js tests/worker.test.js
git commit -m "Format channel posts with a news-first headline, band dots, bold PSI and text links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Change-since-last-hour arrows from saved history

**Files:**
- Modify: `src/broadcast.js`: add `previousHour` above `broadcastChannel`, and pass `previous` into `channelPost`
- Modify: `tests/worker.test.js`: one new test, placed directly before `"failed channel deliveries retry on the next check without losing the immediate breach or scheduled slot"`

**Interfaces:**
- Consumes: `channelPost(..., { previous })` from Task 1. The history table is `reading_history (dataset, reading_at INTEGER ms, source_updated_at, readings TEXT)`, where `readings` is JSON `{ "north": 120, … }` written by `saveHistory` in `src/worker.js` on every successful refresh.
- Produces: `previousHour(env, readingAt) → Promise<object | null>`, private to `src/broadcast.js`. On a failed lookup it logs `Channel trend lookup failed: <message>`.

- [ ] **Step 1: Write the end-to-end test**

In `tests/worker.test.js`, directly before the line `test("failed channel deliveries retry on the next check without losing the immediate breach or scheduled slot", async t => {`, add:

```js
test("channel rows show the change since the saved reading an hour earlier, and leave out arrows it can't compare", async t => {
  const { tick, db, messages } = channelHarness(t);
  await tick("2026-10-14T15:00:00+08:00", 220);
  assert.doesNotMatch(messages[0].text, /[↑↓±]/, "no saved reading for 2 pm");
  await tick("2026-10-14T16:00:00+08:00", 225);
  assert.equal(messages.length, 2);
  assert.match(messages[1].text, /\n🟠 North <b>120<\/b> ±0 · PM2.5 55\n/);
  assert.match(messages[1].text, /\n🔴 West <b>225<\/b> ↑5 · PM2.5 257\n/);
  assert.match(messages[1].text, /\n<i>24-hour PSI \(↑↓ since 3:00 pm\) · 1-hour PM2.5 in µg\/m³<\/i>\n/);
  db.prepare("UPDATE reading_history SET readings = 'not json' WHERE dataset = 'psi' AND reading_at = ?").run(Date.parse("2026-10-14T16:00:00+08:00"));
  const errors = t.mock.method(console, "error", () => {});
  await tick("2026-10-14T17:00:00+08:00", 210);
  assert.equal(messages.length, 3, "an unreadable hour still posts");
  assert.doesNotMatch(messages[2].text, /[↑↓±]/);
  assert.equal(errors.mock.calls.filter(call => call.arguments[0] === "Channel trend lookup failed:").length, 1);
});
```

Why this works with the harness:
- Each `tick` refreshes PSI, and the refresh saves that reading to `reading_history` at the tick time. With the default values (north 120, south 130, east 140, west = the tick's PSI, central 150), the 3 pm tick saves the row that the 4 pm post compares against.
- The 3 pm post is the breach alert. The 4 pm and 5 pm posts are hourly.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/worker.test.js`
Expected: 1 failure, the new test, at the `±0` assertion. `broadcastChannel` doesn't pass `previous` yet.

- [ ] **Step 3: Add the lookup and pass it in**

In `src/broadcast.js`, directly above `// The five-minute scheduled refresh is the only broadcaster. Commands never subscribe people.`, add:

```js
// The saved PSI an hour before this reading, for the trend arrows. The arrows are optional, so a failed lookup or an
// unreadable row only leaves them out.
async function previousHour(env, readingAt) {
  try {
    const row = await env.PSI_DB.prepare("SELECT readings FROM reading_history WHERE dataset = 'psi' AND reading_at = ?")
      .bind(readingAt - HOUR).first();
    return row ? JSON.parse(row.readings) : null;
  } catch (error) {
    console.error("Channel trend lookup failed:", error.message);
    return null;
  }
}

```

Then in `broadcastChannel`, replace:

```js
      const kind = breach ? "breach" : active ? "hourly" : "regular";
      await telegramApi(env, "sendMessage", { chat_id: channel, ...channelPost(snapshot, kind, { appUrl, botUsername, masks }, now) });
```

with:

```js
      const previous = await previousHour(env, readingAt);
      const kind = breach ? "breach" : active ? "hourly" : "regular";
      await telegramApi(env, "sendMessage", { chat_id: channel, ...channelPost(snapshot, kind, { appUrl, botUsername, masks, previous }, now) });
```

`readingAt` is already defined earlier in `broadcastChannel` as `Date.parse(snapshot.readingAt)`, from the snapshot re-read under the lease. The lookup runs only when a post is about to be sent, so most five-minute checks don't touch history.

- [ ] **Step 4: Run the whole suite to verify it passes**

Run: `npm test`
Expected: `# tests 73`, `# pass 73`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/broadcast.js tests/worker.test.js
git commit -m "Show each region's PSI change since the saved reading an hour earlier in channel posts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Docs, pre-deploy checks, release and handover

**Files:**
- Modify: `README.md`, the "Automated channel reports" bullet that starts `- Each report includes all five regional PSI`
- Modify: `HANDOVER.md`

**Interfaces:**
- Consumes: `channelPost` from Tasks 1–2.

- [ ] **Step 1: Update the README bullet**

In `README.md`, replace:

```markdown
- Each report includes all five regional PSI and **1-hour PM2.5 (µg/m³)** readings, separate source timestamps, the dashboard link, and precautions for the greatest regional PSI. PM2.5 concentrations do not trigger the PSI alert.
```

with:

```markdown
- Each report includes all five regional PSI and **1-hour PM2.5 (µg/m³)** readings, and precautions for the greatest regional PSI. PM2.5 concentrations do not trigger the PSI alert.
  - **Format:** reports use Telegram's HTML formatting (`<b>`, `<i>` and `<a>` only, with every inserted value escaped). The first line says how bad the air is, for example "⚠️ Haze alert: PSI 206 in the West region". Each region has a band-coloured dot.
  - **Trend arrows:** each PSI shows its change since the reading saved an hour earlier (`↑4`, `↓3`, `±0`). The arrow is left out when that hour wasn't saved.
  - **Times:** the PM2.5 time is shown only when it differs from the PSI time.
  - **Links:** the dashboard, the MOH advice and data.gov.sg appear as text links. The dashboard, shelter and mask finders are also buttons.
```

- [ ] **Step 2: Print sample posts from the real code and read them**

Save this script **outside the repository**, for example as `$TMPDIR/hazey-samples.mjs`:

```js
// Prints sample channel posts from the real code. Usage: node hazey-samples.mjs <repo root>
const root = process.argv[2];
const { channelPost } = await import(`${root}/src/broadcast.js`);
const KEYS = ["north", "south", "east", "west", "central"];
const AT = "2026-10-18T03:00:00.000Z", NOW = Date.parse("2026-10-18T03:10:00.000Z");
const snap = (psi, pm, pmAt = AT) => ({ readingAt: AT, sourceUpdatedAt: AT, fetchedAt: "2026-10-18T03:05:00.000Z",
  regions: KEYS.map((key, i) => ({ key, name: key[0].toUpperCase() + key.slice(1), psi: psi[i] })),
  pm25: { readingAt: pmAt, sourceUpdatedAt: pmAt, fetchedAt: "2026-10-18T03:05:00.000Z", regions: KEYS.map((key, i) => ({ key, pm25: pm[i] })) } });
const opts = { appUrl: "https://hazey.gabrieltang515.workers.dev", botUsername: "hazey_sg_bot", masks: { cc: 113, vending: 37 } };
const show = (label, post) => console.log(`=== ${label} (${post.text.length} chars) ===\n${post.text}\nbuttons: ${JSON.stringify(post.reply_markup?.inline_keyboard.map(row => row.map(b => b.text)))}\n`);
show("breach", channelPost(snap([124, 158, 171, 206, 189], [48, 62, 71, 96, 80]), "breach", { ...opts, previous: { north: 120, south: 158, east: 175, west: 202, central: 185 } }, NOW));
show("hourly Hazardous", channelPost(snap([180, 240, 260, 312, 290], [70, 110, 130, 160, 140]), "hourly", { ...opts, previous: { north: 182, south: 236, east: 260, west: 305, central: 288 } }, NOW));
show("regular", channelPost(snap([62, 58, 71, 66, 60], [18, 22, 25, 20, 19]), "regular", { ...opts, previous: { north: 64, south: 58, east: 70, west: 66, central: 61 } }, NOW));
show("delayed PM2.5", channelPost(snap([62, 58, 71, 66, 60], [18, 22, 25, 20, 19], "2026-10-18T00:00:00.000Z"), "regular", { ...opts, masks: null }, NOW));
```

Run: `node "$TMPDIR/hazey-samples.mjs" "$PWD"`

Expected: four posts matching the spec's "Message layout", each well under Telegram's 4,096-character limit (about 1,345, 1,345, 850 and 703 characters). Button rows should be:
- `[["📊 Hazey dashboard"],["🏠 Nearest shelter","😷 Free N95 masks"]]` for the breach and hourly posts
- `[["📊 Hazey dashboard"],["😷 Free N95 masks"]]` for the regular post
- `[["📊 Hazey dashboard"]]` for the delayed-PM2.5 post

Read every line. If anything differs from the spec, stop and fix it before going on.

- [ ] **Step 3: Run the tests and a Wrangler dry run**

Run: `npm test`
Expected: `# tests 73`, `# pass 73`, `# fail 0`.

Run: `npx wrangler deploy --dry-run`
Expected: the bundle builds, with bindings `PSI_DB` (hazey-psi) and `ASSETS` and the four existing vars, and no errors. No deployment happens.

- [ ] **Step 4: Commit the README**

```bash
git add README.md
git commit -m "Describe the new channel post format in the README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 5: Stop and get the owner's go-ahead to deploy**

Show the owner the four sample posts from Step 2 and the test result. Deploy only after they say go, because the next post goes to the public `@hazey_sg` channel. If they ask for changes, make them in Tasks 1–2 style (test first), then repeat Steps 2–4.

- [ ] **Step 6: Merge and deploy**

```bash
git switch main
git merge --ff-only channel-format
git push
npx wrangler deploy
```

Note the new version ID that Wrangler prints. The previous version, for rollback, is `8d7d31d4-ee84-4a17-855f-906f4c09b036`.

- [ ] **Step 7: Verify in production**

1. Smoke check:
   - `curl -s -o /dev/null -w "%{http_code}\n" https://hazey.gabrieltang515.workers.dev/` should return `200`.
   - The same for `https://hazey.gabrieltang515.workers.dev/api/psi` should return `200`.
2. Run `npx wrangler tail hazey --format pretty` and wait for the next `Channel broadcast sent (…)` line.
   - During a haze episode (highest PSI ≥ 200 after a breach), that is the next clock hour once NEA publishes.
   - Otherwise it is the next 02/06/10/14/18/22 SGT slot.
3. If the tail shows `Telegram sendMessage failed (400)`, Telegram rejected the post. Roll back straight away with `npx wrangler rollback 8d7d31d4-ee84-4a17-855f-906f4c09b036`, tell the owner, and investigate with superpowers:systematic-debugging.
4. Read the post back with `curl -s https://t.me/s/hazey_sg | sed -e 's/<br\/>/\n/g' -e 's/<[^>]*>//g' | grep -v '^\s*$' | tail -40`. Confirm it has the new headline, dots, arrows (or none if the previous hour is missing) and footer, with no literal `<b>` or `&amp;` showing.
5. Ask the owner to look at the post on their phone. Don't describe the new format as verified until they confirm.

- [ ] **Step 8: Update `HANDOVER.md`, commit and push**

1. **Top paragraph:** change `Updated:` to the actual date and time (SGT). Add one sentence saying channel posts use the new format since `<deploy time>` (version `<id>`), and whether the owner has confirmed it on their phone.
2. **New section** directly below the top paragraph, `## Channel post format — deployed <date>, <time> SGT`, with:
   - what changed: headline, band dots, arrows from `reading_history`, HTML mode, text links, button rows
   - spec and plan paths
   - verification: tests 73/73, dry run, samples reviewed, the first production post's link and log line
   - the rollback command
3. **Old wording:** in the mask section, replace the line describing channel posts adding "Free N95 masks:" and a "Find free N95 masks" button with the new block (`😷 Free N95 masks` heading, `😷 Free N95 masks` button on row 2). In the shelter section, update the line mentioning the "Find a haze shelter" button to `🏠 Nearest shelter`.
4. **Resources table:** in the "Current deployment version" row, put the new version first and keep the previous ones.
5. **Remaining steps:** if the owner hasn't confirmed the post on their phone yet, add that as a step.

```bash
git add HANDOVER.md
git commit -m "Record channel post format release in handover

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```
