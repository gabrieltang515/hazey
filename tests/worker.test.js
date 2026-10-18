import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { backfillHistory, refreshPsi } from "../src/worker.js";
import { API_URL, PM25_API_URL, normalizePsi } from "../src/psi.js";
import { broadcastChannel } from "../src/broadcast.js";
import { telegramApi } from "../src/telegram.js";
import { ONEMAP_SEARCH_URL } from "../src/postal.js";
import { MASK_SITES } from "../public/mask-sites.js";
import { maskCounts, maskPlaces } from "../public/masks.js";
import { formatDistance, nearest } from "../public/geo.js";

function fixture(timestamp = new Date().toISOString()) {
  return { code: 0, data: { items: [{ timestamp, updatedTimestamp: timestamp,
    readings: { psi_twenty_four_hourly: { north: 50, south: 51, east: 100, west: 101, central: 200 } }
  }] } };
}

function pm25Fixture(timestamp = new Date().toISOString()) {
  return { code: 0, data: { items: [{ timestamp, updatedTimestamp: timestamp,
    readings: { pm25_one_hourly: { north: 55, south: 56, east: 150, west: 257, central: 151 } }
  }] } };
}

const nea = url => Response.json(url === PM25_API_URL ? pm25Fixture() : fixture());

function setup(t) {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  t.after(() => db.close());
  const env = {
    PSI_DB: { prepare(sql) {
      let args = [];
      return { bind(...values) { args = values; return this; }, async first() { return db.prepare(sql).get(...args) ?? null; },
        async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: result.changes } }; },
        async all() { return { results: db.prepare(sql).all(...args) }; }
      };
    }, async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; } },
    TELEGRAM_BOT_TOKEN: "123:TEST_TOKEN", TELEGRAM_WEBHOOK_SECRET: "test-secret", TELEGRAM_BOT_USERNAME: "hazey_psi_bot",
    ASSETS: { fetch: async () => new Response("asset") }
  };
  const pending = [];
  return { db, env, ctx: { waitUntil(promise) { pending.push(promise); } }, pending };
}

function telegramMessage(updateId, message) {
  return new Request("https://hazey.example/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
    body: JSON.stringify({ update_id: updateId, message: { chat: { id: 1234, type: "private" }, ...message } }) });
}

function webhook(updateId, command = "/psi", secret = "test-secret") {
  return new Request("https://hazey.example/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: updateId, message: { text: command, chat: { id: 1234, type: "private" } } }) });
}

test("cold API fetch stores real PSI data and an older result cannot replace it", async t => {
  const { db, env, ctx } = setup(t);
  let body = fixture();
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok([API_URL, PM25_API_URL].includes(url));
    return Response.json(url === API_URL ? body : pm25Fixture());
  });
  const response = await worker.fetch(new Request("https://hazey.example/api/psi"), env, ctx);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.regions.length, 5); assert.equal(result.stale, false);
  assert.equal(result.pm25.regions.find(r => r.key === "west").pm25, 257); assert.equal(result.pm25.stale, false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM psi_snapshot").get().n, 1);
  body = fixture("2020-01-01T00:00:00Z");
  await refreshPsi(env);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM psi_snapshot").get().payload).readingAt, result.readingAt);
});
test("failed upstream fetch preserves saved readings and releases the refresh lease", async t => {
  const { db, env, ctx, pending } = setup(t);
  const fetchedAt = Date.now() - 20 * 60_000;
  const snapshot = normalizePsi(fixture(new Date(fetchedAt).toISOString()), fetchedAt);
  db.prepare("INSERT INTO psi_snapshot VALUES (1, ?, ?, ?, ?)").run(JSON.stringify(snapshot), Date.parse(snapshot.fetchedAt), Date.parse(snapshot.readingAt), Date.parse(snapshot.sourceUpdatedAt));
  t.mock.method(globalThis, "fetch", async () => new Response("upstream error", { status: 503 }));
  const response = await worker.fetch(new Request("https://hazey.example/api/psi"), env, ctx);
  assert.equal(response.status, 200); assert.equal((await response.json()).stale, true);
  await Promise.all(pending);
  assert.equal(db.prepare("SELECT expires_at FROM refresh_lock").get().expires_at, 0);
});
test("cold-start failure is 503 and refresh lock prevents concurrent NEA calls", async t => {
  const { db, env, ctx } = setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ code: 24, data: null }); });
  assert.equal((await worker.fetch(new Request("https://hazey.example/api/psi"), env, ctx)).status, 503);
  db.prepare("UPDATE refresh_lock SET expires_at = ?").run(Date.now() + 60_000);
  assert.equal(await refreshPsi(env), null); assert.equal(calls, 2, "one refresh fetches PSI and PM2.5 once each");
});
test("webhook rejects incorrect secrets before making any API call", async t => {
  const { env, ctx } = setup(t);
  t.mock.method(globalThis, "fetch", async () => assert.fail("Unauthenticated webhook made a fetch"));
  assert.equal((await worker.fetch(webhook(1, "/psi", "wrong"), env, ctx)).status, 401);
});
test("valid regional commands reply once and duplicate updates are ignored", async t => {
  const { db, env, ctx } = setup(t);
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === API_URL || url === PM25_API_URL) return nea(url);
    replies.push(JSON.parse(init.body)); return Response.json({ ok: true, result: {} });
  });
  assert.equal((await worker.fetch(webhook(10, "/psi west"), env, ctx)).status, 200);
  assert.equal((await worker.fetch(webhook(10, "/psi west"), env, ctx)).status, 200);
  assert.equal(replies.length, 1); assert.match(replies[0].text, /West: 101 — Unhealthy/);
  assert.doesNotMatch(replies[0].text, /µg\/m³|Band/, "/psi shows PSI only");
  assert.doesNotMatch(replies[0].text, /North:/);
  assert.equal(db.prepare("SELECT state FROM telegram_updates").get().state, "sent");
});
test("failed Telegram delivery permits retries instead of marking the update sent", async t => {
  const { db, env, ctx } = setup(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false }, { status: 429 }));
  assert.equal((await worker.fetch(webhook(11, "/help"), env, ctx)).status, 502);
  assert.equal(db.prepare("SELECT count(*) AS n FROM telegram_updates").get().n, 0);
});
test("unknown regions show help; unrelated messages do not trigger replies", async t => {
  const { env, ctx } = setup(t);
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { replies.push(JSON.parse(init.body)); return Response.json({ ok: true }); });
  await worker.fetch(webhook(12, "/psi jurong"), env, ctx);
  assert.match(replies[0].text, /Choose north, south, east, west, or central/);
  await worker.fetch(webhook(15, "/pm25 jurong"), env, ctx);
  assert.match(replies[1].text, /Example: \/pm25 west/);
  await worker.fetch(webhook(13, "hello"), env, ctx);
  await worker.fetch(webhook(14, "/psi@other_bot"), env, ctx);
  assert.equal(replies.length, 2);
});
test("routes enforce methods and do not expose unknown API paths as assets", async t => {
  const { env, ctx } = setup(t);
  assert.equal((await worker.fetch(new Request("https://hazey.example/api/psi", { method: "POST" }), env, ctx)).status, 405);
  assert.equal((await worker.fetch(new Request("https://hazey.example/telegram/webhook"), env, ctx)).status, 405);
  assert.equal((await worker.fetch(new Request("https://hazey.example/api/missing"), env, ctx)).status, 404);
  assert.equal(await (await worker.fetch(new Request("https://hazey.example/"), env, ctx)).text(), "asset");
});

test("an older revision of the same observation cannot replace newer values", async t => {
  const { db, env } = setup(t);
  const timestamp = new Date().toISOString();
  const body = fixture(timestamp);
  t.mock.method(globalThis, "fetch", async url => Response.json(url === API_URL ? body : pm25Fixture()));
  await refreshPsi(env);
  body.data.items[0].updatedTimestamp = new Date(Date.parse(timestamp) - 60_000).toISOString();
  body.data.items[0].readings.psi_twenty_four_hourly.west = 999;
  const result = await refreshPsi(env);
  assert.equal(result.regions.find(r => r.key === "west").psi, 101);
  assert.equal(db.prepare("SELECT source_updated_at FROM psi_snapshot").get().source_updated_at, Date.parse(timestamp));
});

test("an in-flight duplicate asks Telegram to retry; abandoned processing can be recovered", async t => {
  const { db, env, ctx } = setup(t);
  db.prepare("INSERT INTO telegram_updates VALUES (?, ?, 'processing')").run(20, Date.now());
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ ok: true }); });
  assert.equal((await worker.fetch(webhook(20, "/help"), env, ctx)).status, 503);
  assert.equal(calls, 0);
  db.prepare("UPDATE telegram_updates SET received_at = ?").run(Date.now() - 65_000);
  assert.equal((await worker.fetch(webhook(20, "/help"), env, ctx)).status, 200);
  assert.equal(calls, 1);
  assert.equal(db.prepare("SELECT state FROM telegram_updates WHERE update_id = 20").get().state, "sent");
});

test("the dashboard advertises the bot only when its username and secrets are configured", async t => {
  const { env, ctx } = setup(t);
  t.mock.method(globalThis, "fetch", async url => nea(url));
  const request = () => new Request("https://hazey.example/api/psi");
  assert.equal((await (await worker.fetch(request(), env, ctx)).json()).botUsername, "hazey_psi_bot");
  delete env.TELEGRAM_BOT_TOKEN;
  assert.equal((await (await worker.fetch(request(), env, ctx)).json()).botUsername, null);
});

test("PM2.5 failures never block PSI, and saved PM2.5 survives later PM2.5 failures", async t => {
  const { env, ctx } = setup(t);
  let pm25Up = false;
  t.mock.method(globalThis, "fetch", async url => url === API_URL ? Response.json(fixture())
    : pm25Up ? Response.json(pm25Fixture()) : new Response("rate limited", { status: 429 }));
  const first = await (await worker.fetch(new Request("https://hazey.example/api/psi"), env, ctx)).json();
  assert.equal(first.regions.length, 5); assert.equal(first.pm25, null);
  pm25Up = true;
  assert.equal((await refreshPsi(env)).pm25.regions.find(r => r.key === "west").pm25, 257);
  pm25Up = false;
  const saved = await refreshPsi(env);
  assert.equal(saved.pm25.regions.find(r => r.key === "west").pm25, 257);
  assert.equal(saved.regions.length, 5);
});

test("/pm25 replies with banded 1-hour PM2.5 only; /psi replies with PSI only; help lists both", async t => {
  const { env, ctx } = setup(t);
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === API_URL || url === PM25_API_URL) return nea(url);
    replies.push(JSON.parse(init.body).text); return Response.json({ ok: true, result: {} });
  });
  assert.equal((await worker.fetch(webhook(30, "/pm25 West"), env, ctx)).status, 200);
  assert.equal((await worker.fetch(webhook(31, "/psi"), env, ctx)).status, 200);
  assert.equal((await worker.fetch(webhook(32, "/pm25"), env, ctx)).status, 200);
  assert.equal((await worker.fetch(webhook(33, "/help"), env, ctx)).status, 200);
  assert.match(replies[0], /West: 257 — Very high \(Band IV\)/);
  assert.doesNotMatch(replies[0], /24-hour PSI|North:/);
  assert.match(replies[1], /24-hour PSI\n\nNorth: 50 — Good[\s\S]*Central: 200 — Unhealthy/);
  assert.doesNotMatch(replies[1], /µg\/m³|Band/);
  assert.match(replies[2], /1-hour PM2.5 \(µg\/m³\)\n\nNorth: 55 — Normal \(Band I\)\nSouth: 56 — Elevated \(Band II\)/);
  assert.match(replies[3], /\/pm25 — 1-hour PM2.5, all regions\n\/pm25 north — PM2.5 for one region/);
  assert.match(replies[3], /\/shelter — nearest haze shelters to your location\n\/shelter 530572 — haze shelters near a postal code/);
  assert.match(replies[3], /\/masks — free N95 mask points near your location\n\/masks 530572 — mask points near a postal code/);
});

function dayFixture(field, hours, values) {
  return { code: 0, data: { items: hours.map(timestamp => ({ timestamp, updatedTimestamp: timestamp, readings: { [field]: { ...values } } })) } };
}

test("refreshes append each new reading to the 24-hour history served at /api/history", async t => {
  const { env, ctx } = setup(t);
  t.mock.method(globalThis, "fetch", async url => nea(url));
  await refreshPsi(env);
  const response = await worker.fetch(new Request("https://hazey.example/api/history"), env, ctx);
  assert.equal(response.status, 200);
  const series = await response.json();
  assert.equal(series.psi.length, 1); assert.equal(series.pm25.length, 1);
  assert.deepEqual({ ...series.psi[0], at: undefined }, { at: undefined, north: 50, south: 51, east: 100, west: 101, central: 200 });
  assert.equal(series.pm25[0].west, 257);
  assert.equal((await worker.fetch(new Request("https://hazey.example/api/history", { method: "POST" }), env, ctx)).status, 405);
});

test("backfill stores complete hours from today and yesterday, skips bad hours, and keeps newer revisions", async t => {
  const { db, env, ctx } = setup(t);
  const now = Date.parse("2026-10-14T10:20:00Z"); // 18:20 SGT
  const requested = [];
  t.mock.method(globalThis, "fetch", async url => {
    requested.push(url);
    const date = new URL(url).searchParams.get("date");
    if (url.startsWith(PM25_API_URL)) return Response.json(dayFixture("pm25_one_hourly",
      date === "2026-10-14" ? ["2026-10-14T18:00:00+08:00", "2026-10-14T17:00:00+08:00"] : ["2026-10-13T18:00:00+08:00"],
      { north: 10, south: 20, east: 30, west: 40, central: 50 }));
    const body = dayFixture("psi_twenty_four_hourly",
      date === "2026-10-14" ? ["2026-10-14T18:00:00+08:00", "2026-10-14T17:00:00+08:00"] : ["2026-10-13T16:00:00+08:00", "2026-10-13T18:00:00+08:00"],
      { north: 60, south: 70, east: 80, west: 90, central: 100 });
    if (date === "2026-10-14") delete body.data.items[1].readings.psi_twenty_four_hourly.west;
    return Response.json(body);
  });
  await backfillHistory(env, now);
  assert.deepEqual(requested.map(url => new URL(url).searchParams.get("date")).sort(), ["2026-10-13", "2026-10-13", "2026-10-14", "2026-10-14"]);
  const rows = dataset => db.prepare("SELECT reading_at FROM reading_history WHERE dataset = ? ORDER BY reading_at").all(dataset).map(r => new Date(r.reading_at).toISOString());
  // 16:00 yesterday is outside the 25-hour window; 17:00 today is missing a region.
  assert.deepEqual(rows("psi"), ["2026-10-13T10:00:00.000Z", "2026-10-14T10:00:00.000Z"]);
  assert.deepEqual(rows("pm25"), ["2026-10-13T10:00:00.000Z", "2026-10-14T09:00:00.000Z", "2026-10-14T10:00:00.000Z"]);
  db.prepare("UPDATE reading_history SET source_updated_at = source_updated_at + 60000, readings = '{\"north\":1}' WHERE dataset = 'psi' AND reading_at = ?").run(Date.parse("2026-10-14T10:00:00Z"));
  await backfillHistory(env, now);
  assert.equal(JSON.parse(db.prepare("SELECT readings FROM reading_history WHERE dataset = 'psi' AND reading_at = ?").get(Date.parse("2026-10-14T10:00:00Z")).readings).north, 1);
});

test("scheduled runs backfill hourly and prune history older than two windows", async t => {
  const { db, env } = setup(t);
  const scheduledTime = Date.parse("2026-10-14T10:10:00Z");
  db.prepare("INSERT INTO reading_history VALUES ('psi', ?, ?, '{}')").run(scheduledTime - 3 * 24 * 60 * 60_000, scheduledTime - 3 * 24 * 60 * 60_000);
  const urls = [];
  t.mock.method(globalThis, "fetch", async url => {
    urls.push(url);
    if (url.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: true });
    return url.includes("?date=") ? Response.json({ code: 0, data: { items: [] } }) : nea(url);
  });
  const pending = [];
  await worker.scheduled({ scheduledTime }, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal(urls.filter(url => url.includes("?date=")).length, 4);
  assert.equal(db.prepare("SELECT count(*) AS n FROM reading_history WHERE reading_at < ?").get(scheduledTime - 2 * 24 * 60 * 60_000).n, 0);
});

// Real SQL and the scheduled Worker are exercised; only upstream services and time are replaced.
function channelHarness(t) {
  const { env, db } = setup(t);
  env.TELEGRAM_CHANNEL_ID = "@hazey_sg";
  env.PUBLIC_APP_URL = "https://hazey.example";
  let now, maximum, options;
  const messages = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.startsWith(API_URL)) {
      if (options.psiDown) return new Response("unavailable", { status: 503 });
      const body = fixture(options.readingAt ?? new Date(now).toISOString());
      body.data.items[0].updatedTimestamp = options.updatedAt ?? new Date(now).toISOString();
      body.data.items[0].readings.psi_twenty_four_hourly = options.values ?? { north: 120, south: 130, east: 140, west: maximum, central: 150 };
      return Response.json(body);
    }
    if (url.startsWith(PM25_API_URL)) {
      if (options.pm25Down) return new Response("unavailable", { status: 503 });
      return Response.json(pm25Fixture(options.pm25At ?? new Date(now).toISOString()));
    }
    if (url.endsWith("/setMyCommands")) return Response.json({ ok: true, result: true });
    assert.ok(url.endsWith("/sendMessage"));
    if (options.telegramDown) return Response.json({ ok: false }, { status: 429 });
    if (options.delivery) await options.delivery;
    messages.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: { message_id: messages.length } });
  });
  return { db, env, messages, async tick(time, psi = 150, settings = {}) {
    now = Date.parse(time); maximum = psi; options = settings;
    const pending = [];
    await worker.scheduled({ scheduledTime: now }, env, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
  } };
}

test("channel regular reports follow 6am-anchored four-hour SGT slots, including 2am, once per slot", async t => {
  const { tick, messages } = channelHarness(t);
  for (const time of ["2026-10-14T05:55:00+08:00", "2026-10-14T06:00:00+08:00", "2026-10-14T06:05:00+08:00",
    "2026-10-14T07:00:00+08:00", "2026-10-14T10:00:00+08:00", "2026-10-14T14:00:00+08:00",
    "2026-10-14T18:00:00+08:00", "2026-10-14T22:00:00+08:00", "2026-10-15T00:00:00+08:00", "2026-10-15T02:00:00+08:00"]) await tick(time);
  assert.equal(messages.length, 6);
  assert.ok(messages.every(message => message.chat_id === "@hazey_sg"));
  assert.equal(messages[0].parse_mode, "HTML");
  assert.match(messages[0].text, /^🟠 <b>Air quality update: PSI 120–150<\/b>\n/);
  assert.match(messages[0].text, /\n🟠 North <b>120<\/b> · PM2.5 55\n/);
  assert.match(messages[0].text, /\n🟠 Central <b>150<\/b> · PM2.5 151\n/);
  assert.match(messages[0].text, /1-hour PM2.5 in µg\/m³/);
  assert.match(messages[0].text, /<a href="https:\/\/hazey.example">Hazey dashboard<\/a>/);
});

test("breach alerts immediately, then hourly, holds at 200, clears silently and resumes the fixed schedule", async t => {
  const { tick, messages } = channelHarness(t);
  await tick("2026-10-14T15:15:00+08:00", 200);
  assert.equal(messages.length, 0, "200 alone does not enter alert mode");
  await tick("2026-10-14T15:20:00+08:00", 201);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /^⚠️ <b>Haze alert: PSI 201 in the West region<\/b>\n/);
  await tick("2026-10-14T15:25:00+08:00", 205);
  assert.equal(messages.length, 1);
  await tick("2026-10-14T16:00:00+08:00", 205);
  await tick("2026-10-14T17:00:00+08:00", 200);
  await tick("2026-10-14T17:20:00+08:00", 199);
  assert.equal(messages.length, 3, "no recovery post");
  await tick("2026-10-14T18:00:00+08:00", 199);
  assert.equal(messages.length, 4);
  await tick("2026-10-14T18:20:00+08:00", 220);
  assert.equal(messages.length, 5, "a new episode gets an immediate alert even in an already reported hour");
  await tick("2026-10-14T22:00:00+08:00", 220);
  await tick("2026-10-14T22:05:00+08:00", 220);
  assert.equal(messages.length, 6, "hourly and regular slot produce one post");
});

test("hourly channel report waits for the current NEA observation and sends when it arrives", async t => {
  const { tick, messages } = channelHarness(t);
  await tick("2026-10-14T15:20:00+08:00", 220);
  await tick("2026-10-14T16:00:00+08:00", 220, { readingAt: "2026-10-14T15:00:00+08:00" });
  assert.equal(messages.length, 1);
  await tick("2026-10-14T16:05:00+08:00", 225, { readingAt: "2026-10-14T16:00:00+08:00" });
  assert.equal(messages.length, 2);
  await tick("2026-10-14T16:10:00+08:00", 225);
  assert.equal(messages.length, 2);
});

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

test("failed channel deliveries retry on the next check without losing the immediate breach or scheduled slot", async t => {
  const { tick, messages } = channelHarness(t);
  await tick("2026-10-14T15:20:00+08:00", 220, { telegramDown: true });
  await tick("2026-10-14T15:25:00+08:00", 220);
  assert.equal(messages.length, 1);
  await tick("2026-10-14T16:00:00+08:00", 220, { telegramDown: true });
  await tick("2026-10-14T16:05:00+08:00", 220);
  await tick("2026-10-14T16:10:00+08:00", 220);
  assert.equal(messages.length, 2);
});

test("channel suppresses stale or future PSI and does not clear alert mode during a source outage", async t => {
  const { tick, messages } = channelHarness(t);
  await tick("2026-10-14T15:20:00+08:00", 220, { readingAt: "2026-10-14T12:00:00+08:00" });
  assert.equal(messages.length, 0);
  await tick("2026-10-14T15:25:00+08:00", 220);
  assert.equal(messages.length, 1);
  await tick("2026-10-14T16:00:00+08:00", 100, { psiDown: true });
  assert.equal(messages.length, 1);
  await tick("2026-10-14T16:05:00+08:00", 220);
  assert.equal(messages.length, 2);
  await tick("2026-10-14T17:00:00+08:00", 220, { readingAt: "2026-10-14T18:00:00+08:00" });
  assert.equal(messages.length, 2);
  await tick("2026-10-14T17:05:00+08:00", 220, { readingAt: "2026-10-14T17:00:00+08:00" });
  assert.equal(messages.length, 3, "a future response must not prevent later valid readings");
});

test("channel uses separate PM2.5 times and still sends PSI when PM2.5 is missing or delayed", async t => {
  const { tick, messages } = channelHarness(t);
  await tick("2026-10-14T06:00:00+08:00", 150, { pm25Down: true });
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /PM2.5 unavailable/);
  await tick("2026-10-14T10:00:00+08:00", 150, { pm25At: "2026-10-14T07:00:00+08:00" });
  assert.equal(messages.length, 2);
  assert.match(messages[1].text, /PM2.5.*delayed/i);
  assert.match(messages[1].text, /7:00 am/);
});

test("future PM2.5 cannot replace the saved snapshot or block subsequent valid PM2.5", async t => {
  const { tick, db } = channelHarness(t);
  await tick("2026-10-14T10:00:00+08:00", 150);
  await tick("2026-10-14T10:05:00+08:00", 150, { pm25At: "2026-10-14T11:00:00+08:00" });
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM pm25_snapshot").get().payload).readingAt, "2026-10-14T02:00:00.000Z");
  await tick("2026-10-14T10:10:00+08:00", 150);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM pm25_snapshot").get().payload).readingAt, "2026-10-14T02:10:00.000Z");
});

test("channel advice escalates at the official PSI boundaries and never substitutes PM2.5 for PSI", async t => {
  const { tick, messages } = channelHarness(t);
  await tick("2026-10-14T06:00:00+08:00", 200);
  assert.match(messages[0].text, /Healthy.*reduce/i);
  await tick("2026-10-14T06:20:00+08:00", 201);
  assert.match(messages[1].text, /Healthy.*avoid/i);
  assert.match(messages[1].text, /chronic.*avoid outdoor/i);
  await tick("2026-10-14T07:00:00+08:00", 301);
  assert.match(messages[2].text, /Healthy.*minimise outdoor/i);
  assert.match(messages[2].text, /MOH/);
});

test("concurrent scheduled invocations cannot both post to the channel", async t => {
  const { tick, messages } = channelHarness(t);
  let release;
  const delivery = new Promise(resolve => { release = resolve; });
  const first = tick("2026-10-14T06:00:00+08:00", 150, { delivery });
  // Let the first invocation enter its network send while the second claims the same slot.
  await new Promise(resolve => setImmediate(resolve));
  const second = tick("2026-10-14T06:00:00+08:00", 150, { delivery });
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(messages.length, 1);
});

test("a failed first alert still starts an episode that holds at 200 until recovery", async t => {
  const { tick, messages } = channelHarness(t);
  await tick("2026-10-14T15:20:00+08:00", 201, { telegramDown: true });
  await tick("2026-10-14T15:25:00+08:00", 200);
  assert.equal(messages.length, 1, "retry the first alert even at 200");
  await tick("2026-10-14T16:00:00+08:00", 200);
  assert.equal(messages.length, 2);
});

test("recovery clears alert mode even when the coincident regular report fails", async t => {
  const { tick, messages } = channelHarness(t);
  await tick("2026-10-14T17:20:00+08:00", 220);
  await tick("2026-10-14T18:00:00+08:00", 199, { telegramDown: true });
  await tick("2026-10-14T19:00:00+08:00", 200);
  assert.equal(messages.length, 1, "200 after recovery must not re-enter hourly mode");
  await tick("2026-10-14T22:00:00+08:00", 200);
  assert.equal(messages.length, 2);
});

test("a stale source response cannot broadcast a retained fresh cache from a browser refresh", async t => {
  const { tick, env, messages } = channelHarness(t);
  delete env.TELEGRAM_CHANNEL_ID;
  await tick("2026-10-14T15:55:00+08:00", 220);
  env.TELEGRAM_CHANNEL_ID = "@hazey_sg";
  await tick("2026-10-14T16:00:00+08:00", 150, { readingAt: "2026-10-14T13:00:00+08:00" });
  assert.equal(messages.length, 0);
  await tick("2026-10-14T16:05:00+08:00", 220);
  assert.equal(messages.length, 1);
});

test("older observations and older revisions cannot restart an episode after a newer recovery", async t => {
  const { tick, env, db, messages } = channelHarness(t);
  const at = "2026-10-14T15:00:00+08:00";
  await tick("2026-10-14T15:20:00+08:00", 220, { readingAt: at });
  const older = JSON.parse(db.prepare("SELECT payload FROM psi_snapshot").get().payload);
  await tick("2026-10-14T15:25:00+08:00", 199, { readingAt: at });
  await broadcastChannel(env, older, Date.parse("2026-10-14T15:30:00+08:00"));
  assert.equal(messages.length, 1, "must re-read the newer authoritative snapshot after claiming the lease");
  // Even if supplied with an older authoritative snapshot, the channel's processed revision guards its mode.
  db.prepare("UPDATE psi_snapshot SET payload = ?").run(JSON.stringify(older));
  await broadcastChannel(env, older, Date.parse("2026-10-14T15:35:00+08:00"));
  assert.equal(messages.length, 1, "processed revision cannot move backwards");
  const earlier = { ...older, readingAt: "2026-10-14T14:00:00+08:00" };
  db.prepare("UPDATE psi_snapshot SET payload = ?").run(JSON.stringify(earlier));
  await broadcastChannel(env, earlier, Date.parse("2026-10-14T15:40:00+08:00"));
  assert.equal(messages.length, 1);
});

test("normal channel advice includes the 100/101 and 300/301 boundaries", async t => {
  const { tick, messages } = channelHarness(t);
  const values = maximum => ({ north: 50, south: 50, east: 50, west: maximum, central: 50 });
  await tick("2026-10-14T06:00:00+08:00", 100, { values: values(100) });
  assert.match(messages[0].text, /normal activities can continue for all groups/);
  assert.doesNotMatch(messages[0].text, /If you feel unwell/);
  await tick("2026-10-14T10:00:00+08:00", 101, { values: values(101) });
  assert.match(messages[1].text, /Healthy.*reduce/i);
  assert.match(messages[1].text, /\nIf you feel unwell, seek medical attention, especially if you are in a vulnerable group\.\n/);
  await tick("2026-10-14T10:20:00+08:00", 300, { values: values(300) });
  assert.match(messages[2].text, /Healthy.*avoid/i);
  await tick("2026-10-14T11:00:00+08:00", 301, { values: values(301) });
  assert.match(messages[3].text, /Healthy.*minimise outdoor/i);
});

test("/shelter with a postal code replies with the three nearest shelters, directions and NEA's shelter rule", async t => {
  const { env, ctx } = setup(t);
  env.PUBLIC_APP_URL = "https://hazey.example";
  const replies = [], searches = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === API_URL || url === PM25_API_URL) return nea(url);
    if (url.startsWith(ONEMAP_SEARCH_URL)) {
      searches.push(url);
      return Response.json({ results: [{ POSTAL: "530572", LATITUDE: "1.378270724882904", LONGITUDE: "103.8874850986399" }] });
    }
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  await refreshPsi(env);
  assert.equal((await worker.fetch(webhook(40, "/shelter 530 572"), env, ctx)).status, 200);
  const [reply] = replies;
  assert.match(reply.text, /^Nearest haze shelters to postal code 530572\n\n1\. Ang Mo Kio-Hougang Pinetree RN — Under 100 m\n572 Hougang St 51 #01-31, Singapore 530572\nResidents’ Network centre\n/);
  assert.equal(reply.text.match(/^\d\. /gm).length, 3);
  assert.match(reply.text, /The highest now is 200, in the Central region\./);
  const rows = reply.reply_markup.inline_keyboard;
  assert.equal(rows.length, 4);
  assert.equal(rows[0][0].url, "https://www.google.com/maps/dir/?api=1&destination=1.37827,103.88749");
  assert.equal(rows[3][0].url, "https://hazey.example/#shelters");
  assert.equal(searches.length, 1);
});

test("a privately shared location finds shelters; groups ignore locations; bare and invalid /shelter commands guide the user", async t => {
  const { env, ctx } = setup(t);
  const replies = [];
  let searches = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.startsWith(ONEMAP_SEARCH_URL)) { searches++; return Response.json({ results: [] }); }
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  const here = { latitude: 1.27617, longitude: 103.84158 }; // Tanjong Pagar CC
  assert.equal((await worker.fetch(telegramMessage(50, { location: here }), env, ctx)).status, 200);
  assert.match(replies[0].text, /^Nearest haze shelters to your location\n\n1\. Tanjong Pagar CC — Under 100 m\n/);
  assert.match(replies[0].text, /\nNEA opens haze shelters when the 24-hour PSI goes above 200\.\n/, "no saved reading: the rule alone");
  assert.equal(replies[0].reply_markup.inline_keyboard.length, 3);
  assert.equal((await worker.fetch(telegramMessage(51, { chat: { id: -100, type: "group" }, location: here }), env, ctx)).status, 200);
  assert.equal(replies.length, 1, "a location in a group gets no reply");
  await worker.fetch(webhook(52, "/shelter"), env, ctx);
  assert.equal(replies[1].reply_markup.keyboard[0][0].request_location, true);
  assert.match(replies[1].text, /isn’t stored/);
  await worker.fetch(telegramMessage(53, { chat: { id: -100, type: "group" }, text: "/shelter" }), env, ctx);
  assert.match(replies[2].text, /e\.g\. \/shelter 530572\. To use your location, message me privately\./);
  assert.equal(replies[2].reply_markup, undefined);
  await worker.fetch(webhook(54, "/shelter 12345"), env, ctx);
  assert.match(replies[3].text, /six digits/);
  assert.equal(searches, 0, "invalid codes never reach OneMap");
  await worker.fetch(webhook(55, "/shelter 999999"), env, ctx);
  assert.match(replies[4].text, /Couldn’t find postal code 999999/);
  assert.equal(searches, 1);
});

test("postal lookup failures still reply, complete the update, and keep codes and locations out of logs", async t => {
  const { db, env, ctx } = setup(t);
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.startsWith(ONEMAP_SEARCH_URL)) return new Response("busy", { status: 429 });
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  const errors = t.mock.method(console, "error", () => {});
  const logs = t.mock.method(console, "log", () => {});
  assert.equal((await worker.fetch(webhook(60, "/shelter 530572"), env, ctx)).status, 200);
  assert.match(replies[0].text, /unavailable right now\. Share your location instead/);
  assert.equal(replies[0].reply_markup.keyboard[0][0].request_location, true);
  assert.equal(db.prepare("SELECT state FROM telegram_updates WHERE update_id = 60").get().state, "sent");
  assert.equal((await worker.fetch(telegramMessage(61, { location: { latitude: 1.3456, longitude: 103.8765 } }), env, ctx)).status, 200);
  const logged = [...errors.mock.calls, ...logs.mock.calls].flatMap(call => call.arguments.map(String)).join(" ");
  assert.doesNotMatch(logged, /530572|1\.3456|103\.8765/);
  assert.equal(errors.mock.callCount(), 1);
});

test("channel posts above 200 point to haze shelters, add the 10 pm hours when Hazardous, and omit them at 200 or below", async t => {
  const { tick, messages } = channelHarness(t);
  await tick("2026-10-14T15:20:00+08:00", 206);
  assert.ok(messages[0].text.includes("\n🏠 <b>Haze shelters</b>\nNEA opens haze shelters when the 24-hour PSI is above 200. Call the centre before you go to confirm the room and its opening hours. Nearest: send /shelter to @hazey_psi_bot\n"));
  assert.deepEqual(messages[0].reply_markup.inline_keyboard.map(row => row.map(button => button.url)), [["https://hazey.example"], ["https://hazey.example/#shelters"]]);
  await tick("2026-10-14T16:00:00+08:00", 305);
  assert.match(messages[1].text, /The 24-hour PSI is Hazardous in the West region\. NEA says haze shelters at community clubs stay open until 10 pm\./);
  await tick("2026-10-14T17:00:00+08:00", 199);
  await tick("2026-10-14T18:00:00+08:00", 199);
  assert.equal(messages.length, 3);
  assert.doesNotMatch(messages[2].text, /Haze shelters/);
  assert.equal(messages[2].reply_markup.inline_keyboard.length, 1);
});

test("scheduled runs refresh the bot command menu at minute 10 of each hour, only with a token, without logging it", async t => {
  const { env } = setup(t);
  const calls = [];
  let telegramDown = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.startsWith("https://api.telegram.org/")) {
      calls.push({ method: url.split("/").pop(), body: JSON.parse(init.body) });
      return telegramDown ? Response.json({ ok: false }, { status: 401 }) : Response.json({ ok: true, result: true });
    }
    return url.includes("?date=") ? Response.json({ code: 0, data: { items: [] } }) : nea(url);
  });
  const run = async iso => {
    const pending = [];
    await worker.scheduled({ scheduledTime: Date.parse(iso) }, env, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending);
  };
  await run("2026-10-14T10:10:00Z");
  assert.deepEqual(calls.map(call => call.method), ["setMyCommands"]);
  assert.deepEqual(calls[0].body.commands.map(command => command.command), ["psi", "pm25", "shelter", "masks", "help", "start"]);
  await run("2026-10-14T10:15:00Z");
  assert.equal(calls.length, 1, "only at minute 10");
  telegramDown = true;
  const errors = t.mock.method(console, "error", () => {});
  await run("2026-10-14T11:10:00Z");
  assert.equal(calls.length, 2);
  assert.ok(errors.mock.calls.some(call => /Bot command menu update failed: Telegram setMyCommands failed \(401\)/.test(call.arguments.join(" "))));
  assert.ok(errors.mock.calls.every(call => !call.arguments.join(" ").includes("TEST_TOKEN")));
  delete env.TELEGRAM_BOT_TOKEN;
  await run("2026-10-14T12:10:00Z");
  assert.equal(calls.length, 2, "no token, no call");
});

test("plain /masks offers the location button and the next shared location finds mask points; otherwise locations find shelters", async t => {
  const { db, env, ctx } = setup(t);
  const replies = [];
  let telegramDown = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (telegramDown) return Response.json({ ok: false }, { status: 500 });
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  const errors = t.mock.method(console, "error", () => {});
  env.MASK_DISTRIBUTION = "on";
  const here = { latitude: 1.37827, longitude: 103.88749 };
  const pendingRows = () => db.prepare("SELECT count(*) AS n FROM bot_location_requests").get().n;
  await worker.fetch(webhook(80, "/masks"), env, ctx);
  assert.equal(replies[0].text, "Share your location to find the 3 nearest free N95 mask points, or send a postal code, e.g. /masks 530572.\n\nYour location is only used to find mask points and isn’t stored.");
  assert.equal(replies[0].reply_markup.keyboard[0][0].request_location, true);
  assert.equal(pendingRows(), 1);
  telegramDown = true;
  assert.equal((await worker.fetch(telegramMessage(81, { location: here }), env, ctx)).status, 502);
  assert.equal(pendingRows(), 1, "a failed reply keeps the request for Telegram's retry");
  telegramDown = false;
  await worker.fetch(telegramMessage(81, { location: here }), env, ctx);
  assert.ok(replies[1].text.startsWith(`Nearest free N95 mask points to your location\n\n1. ${nearest({ lat: 1.37827, lng: 103.88749 }, MASK_SITES, 1)[0].name} — `));
  assert.equal(pendingRows(), 0, "used once");
  await worker.fetch(telegramMessage(82, { location: here }), env, ctx);
  assert.match(replies[2].text, /^Nearest haze shelters to your location/);

  await worker.fetch(webhook(83, "/masks"), env, ctx);
  await worker.fetch(webhook(84, "/shelter"), env, ctx);
  assert.equal(pendingRows(), 0, "plain /shelter cancels a pending /masks request");
  await worker.fetch(telegramMessage(85, { location: here }), env, ctx);
  assert.match(replies[5].text, /^Nearest haze shelters/);

  await worker.fetch(webhook(86, "/masks"), env, ctx);
  db.prepare("UPDATE bot_location_requests SET expires_at = ?").run(Date.now() - 1);
  await worker.fetch(telegramMessage(87, { location: here }), env, ctx);
  assert.match(replies[7].text, /^Nearest haze shelters/, "an expired request falls back to shelters");

  await worker.fetch(telegramMessage(88, { chat: { id: -100, type: "group" }, text: "/masks" }), env, ctx);
  assert.equal(replies[8].text, "Send /masks with a postal code, e.g. /masks 530572. To use your location, message me privately.");
  assert.equal(db.prepare("SELECT count(*) AS n FROM bot_location_requests WHERE chat_id = -100").get().n, 0);
  assert.ok(errors.mock.calls.every(call => !/1\.37827|103\.88749/.test(call.arguments.join(" "))), "locations never reach the logs");
});

test("a failed /shelter postal lookup that offers the location button cancels a pending /masks request", async t => {
  const { db, env, ctx } = setup(t);
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.startsWith(ONEMAP_SEARCH_URL)) return new Response("busy", { status: 429 });
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  t.mock.method(console, "error", () => {});
  const pendingRows = () => db.prepare("SELECT count(*) AS n FROM bot_location_requests").get().n;
  env.MASK_DISTRIBUTION = "on";
  await worker.fetch(webhook(90, "/masks"), env, ctx);
  assert.equal(pendingRows(), 1);
  await worker.fetch(webhook(91, "/shelter 530572"), env, ctx);
  assert.ok(replies[1].reply_markup.keyboard, "the failed lookup offers the location button");
  assert.equal(pendingRows(), 0);
  await worker.fetch(telegramMessage(92, { location: { latitude: 1.37827, longitude: 103.88749 } }), env, ctx);
  assert.match(replies[2].text, /^Nearest haze shelters/);
});

test("scheduled runs prune expired /masks location requests", async t => {
  const { db, env } = setup(t);
  delete env.TELEGRAM_BOT_TOKEN;
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(!url.includes("gowhere.gov.sg"), "the Worker never fetches HazeMaskGoWhere");
    return url.includes("?date=") ? Response.json({ code: 0, data: { items: [] } }) : nea(url);
  });
  db.prepare("INSERT INTO bot_location_requests VALUES (1, 'masks', ?), (2, 'masks', ?)").run(Date.now() - 1, Date.now() + 60_000);
  const pending = [];
  await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.deepEqual(db.prepare("SELECT chat_id FROM bot_location_requests").all().map(row => row.chat_id), [2]);
});

test("/masks with a postal code replies with the three nearest saved mask points, eligibility and where the list comes from", async t => {
  const { env, ctx } = setup(t);
  env.PUBLIC_APP_URL = "https://hazey.example";
  env.MASK_DISTRIBUTION = "on";
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.startsWith(ONEMAP_SEARCH_URL)) return Response.json({ results: [{ POSTAL: "530572", LATITUDE: "1.378270724882904", LONGITUDE: "103.8874850986399" }] });
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  const expected = nearest({ lat: 1.378270724882904, lng: 103.8874850986399 }, MASK_SITES, 3);
  assert.equal((await worker.fetch(webhook(70, "/masks 530572"), env, ctx)).status, 200);
  const [reply] = replies;
  const [first] = expected;
  assert.ok(reply.text.startsWith(`Nearest free N95 mask points to postal code 530572\n\n1. ${first.name} — ${formatDistance(first.km)}\n${first.kind === "cc" ? "CC counter" : "Vending machine"}\n`));
  assert.deepEqual(reply.text.match(/^\d\. .+(?= — )/gm), expected.map((site, i) => `${i + 1}. ${site.name}`));
  assert.doesNotMatch(reply.text, /In stock|Limited stock|Out of stock/, "no stock is claimed");
  assert.match(reply.text, /Pregnant women, children aged 7 to 16/);
  assert.match(reply.text, /\nLocations from HazeMaskGoWhere as at .+ SGT\. Stock changes through the day; check live stock before you go: go\.gov\.sg\/hazemask$/);
  const rows = reply.reply_markup.inline_keyboard;
  assert.equal(rows.length, 4);
  assert.equal(rows[0][0].text, `Directions: ${first.name}`);
  assert.equal(rows[3][0].url, "https://hazey.example/#masks");
  await worker.fetch(webhook(71, "/mask 530572"), env, ctx);
  assert.equal(replies[1].text, reply.text, "/mask is an alias");
});

test("with mask distribution off, /masks says so, links HazeMaskGoWhere and offers no location button", async t => {
  const { db, env, ctx } = setup(t);
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(!url.startsWith(ONEMAP_SEARCH_URL), "no postal lookup while off");
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: {} });
  });
  await worker.fetch(webhook(95, "/masks 530572"), env, ctx);
  assert.equal(replies[0].text, "Free N95 mask distribution isn’t running right now. HazeMaskGoWhere has the latest: https://www.gowhere.gov.sg/hazemask");
  assert.deepEqual(replies[0].reply_markup.inline_keyboard, [[{ text: "Open HazeMaskGoWhere ↗", url: "https://www.gowhere.gov.sg/hazemask" }]]);
  await worker.fetch(webhook(96, "/masks"), env, ctx);
  assert.equal(replies[1].reply_markup.keyboard, undefined);
  assert.equal(db.prepare("SELECT count(*) AS n FROM bot_location_requests").get().n, 0);
});

test("/api/psi tells the dashboard whether free mask distribution is on, and the live mask API is gone", async t => {
  const { env, ctx } = setup(t);
  t.mock.method(globalThis, "fetch", async url => nea(url));
  const psi = async () => (await worker.fetch(new Request("https://hazey.example/api/psi"), env, ctx)).json();
  assert.equal((await psi()).masksActive, false);
  env.MASK_DISTRIBUTION = "on";
  assert.equal((await psi()).masksActive, true);
  assert.equal((await worker.fetch(new Request("https://hazey.example/api/masks"), env, ctx)).status, 404);
});

test("channel posts point to free N95 masks while distribution is on, at any PSI level, and not when it is off", async t => {
  const { tick, env, messages } = channelHarness(t);
  env.MASK_DISTRIBUTION = "on";
  await tick("2026-10-14T06:00:00+08:00", 150);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].text.includes(`\n\n😷 <b>Free N95 masks</b>\nEligible groups can collect them at ${maskPlaces(maskCounts(MASK_SITES))}. Nearest: send /masks to @hazey_psi_bot · Live stock: go.gov.sg/hazemask\n\n<a href="https://hazey.example">Hazey dashboard</a>`));
  assert.deepEqual(messages[0].reply_markup.inline_keyboard.map(row => row.map(button => button.url)), [["https://hazey.example"], ["https://hazey.example/#masks"]]);
  await tick("2026-10-14T06:20:00+08:00", 220);
  assert.match(messages[1].text, /Haze shelters<\/b>[\s\S]*Free N95 masks<\/b>/);
  assert.deepEqual(messages[1].reply_markup.inline_keyboard.map(row => row.map(button => button.url)), [["https://hazey.example"], ["https://hazey.example/#shelters", "https://hazey.example/#masks"]]);
  delete env.MASK_DISTRIBUTION;
  await tick("2026-10-14T07:00:00+08:00", 220);
  assert.equal(messages.length, 3);
  assert.doesNotMatch(messages[2].text, /Free N95 masks/);
  assert.equal(messages[2].reply_markup.inline_keyboard.length, 2);
});

test("Telegram errors carry Telegram's reason but never the token or request URL", async t => {
  const env = { TELEGRAM_BOT_TOKEN: "123:SECRET_TOKEN" };
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, error_code: 400,
    description: "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 7" }, { status: 400 }));
  await assert.rejects(telegramApi(env, "sendMessage", { chat_id: "@hazey_sg", text: "<x>" }), error => {
    assert.equal(error.message, "Telegram sendMessage failed (400): Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 7");
    assert.doesNotMatch(error.message, /SECRET_TOKEN|api\.telegram\.org/);
    return true;
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false }, { status: 429 }));
  await assert.rejects(telegramApi(env, "sendMessage", {}), { message: "Telegram sendMessage failed (429)" });
});
