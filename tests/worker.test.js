import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { refreshPsi } from "../src/worker.js";
import { API_URL, PM25_API_URL, normalizePsi } from "../src/psi.js";

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
        async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: result.changes } }; }
      };
    } },
    TELEGRAM_BOT_TOKEN: "123:TEST_TOKEN", TELEGRAM_WEBHOOK_SECRET: "test-secret", TELEGRAM_BOT_USERNAME: "hazey_psi_bot",
    ASSETS: { fetch: async () => new Response("asset") }
  };
  const pending = [];
  return { db, env, ctx: { waitUntil(promise) { pending.push(promise); } }, pending };
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
  const snapshot = normalizePsi(fixture(), Date.now() - 20 * 60_000);
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
  assert.match(replies[0].text, /1-hour PM2.5 \(µg\/m³\)\nWest: 257 — Very high \(Band IV\)/);
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

test("/pm25 replies with banded 1-hour PM2.5 only; /psi labels PSI and PM2.5 separately", async t => {
  const { env, ctx } = setup(t);
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === API_URL || url === PM25_API_URL) return nea(url);
    replies.push(JSON.parse(init.body).text); return Response.json({ ok: true, result: {} });
  });
  assert.equal((await worker.fetch(webhook(30, "/pm25 West"), env, ctx)).status, 200);
  assert.equal((await worker.fetch(webhook(31, "/psi"), env, ctx)).status, 200);
  assert.match(replies[0], /West: 257 — Very high \(Band IV\)/);
  assert.doesNotMatch(replies[0], /24-hour PSI|North:/);
  assert.match(replies[1], /24-hour PSI\n[\s\S]*Central: 200 — Unhealthy[\s\S]*1-hour PM2.5 \(µg\/m³\)\nNorth: 55 — Normal \(Band I\)\nSouth: 56 — Elevated \(Band II\)/);
});
