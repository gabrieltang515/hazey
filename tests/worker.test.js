import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker, { refreshPsi } from "../src/worker.js";
import { API_URL, normalizePsi } from "../src/psi.js";

function fixture(timestamp = new Date().toISOString()) {
  return { code: 0, data: { items: [{ timestamp, updatedTimestamp: timestamp,
    readings: { psi_twenty_four_hourly: { north: 50, south: 51, east: 100, west: 101, central: 200 } }
  }] } };
}

function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
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
  t.mock.method(globalThis, "fetch", async url => { assert.equal(url, API_URL); return Response.json(body); });
  const response = await worker.fetch(new Request("https://hazey.example/api/psi"), env, ctx);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.regions.length, 5); assert.equal(result.stale, false);
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
  assert.equal(await refreshPsi(env), null); assert.equal(calls, 1);
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
    if (url === API_URL) return Response.json(fixture());
    replies.push(JSON.parse(init.body)); return Response.json({ ok: true, result: {} });
  });
  assert.equal((await worker.fetch(webhook(10, "/psi west"), env, ctx)).status, 200);
  assert.equal((await worker.fetch(webhook(10, "/psi west"), env, ctx)).status, 200);
  assert.equal(replies.length, 1); assert.match(replies[0].text, /West: 101 — Unhealthy/);
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
  await worker.fetch(webhook(13, "hello"), env, ctx);
  await worker.fetch(webhook(14, "/psi@other_bot"), env, ctx);
  assert.equal(replies.length, 1);
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
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
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
  t.mock.method(globalThis, "fetch", async () => Response.json(fixture()));
  const request = () => new Request("https://hazey.example/api/psi");
  assert.equal((await (await worker.fetch(request(), env, ctx)).json()).botUsername, "hazey_psi_bot");
  delete env.TELEGRAM_BOT_TOKEN;
  assert.equal((await (await worker.fetch(request(), env, ctx)).json()).botUsername, null);
});
