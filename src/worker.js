import { API_URL, PM25_API_URL, REFRESH_INTERVAL, historyPoints, normalizePm25, normalizePsi, isStale, telegramReading } from "./psi.js";
import { REGIONS } from "../public/psi.js";
import { telegramApi } from "./telegram.js";
import { broadcastChannel } from "./broadcast.js";

const HELP = "Welcome to Hazey ☁️\n\nGet the latest NEA air quality readings for Singapore.\n\n/psi — 24-hour PSI, all regions\n/psi north — PSI for one region\n/pm25 — 1-hour PM2.5, all regions\n/pm25 north — PM2.5 for one region\n\nRegions: north, south, east, west, central.\n/help — these commands\n\nReadings refresh every 5 minutes; NEA publishes the underlying readings on its own schedule.";

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders
  } });
}

async function storedSnapshot(env) {
  const row = await env.PSI_DB.prepare(
    "SELECT payload, (SELECT payload FROM pm25_snapshot WHERE id = 1) AS pm25 FROM psi_snapshot WHERE id = 1"
  ).first();
  return row ? { ...JSON.parse(row.payload), pm25: row.pm25 ? JSON.parse(row.pm25) : null } : null;
}

const NEA_URLS = { psi: API_URL, pm25: PM25_API_URL };
// One extra hour so the charts can compare with the same time yesterday.
const HISTORY_WINDOW = 25 * 60 * 60_000;

// Called only with the fixed table names below. An older upstream result must never replace a newer saved observation.
function saveSnapshot(env, table, snapshot) {
  return env.PSI_DB.prepare(
    `INSERT INTO ${table} (id, payload, fetched_at, reading_at, source_updated_at) VALUES (1, ?, ?, ?, ?) ` +
    "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, reading_at = excluded.reading_at, source_updated_at = excluded.source_updated_at " +
    `WHERE excluded.reading_at > ${table}.reading_at OR ` +
    `(excluded.reading_at = ${table}.reading_at AND excluded.source_updated_at >= ${table}.source_updated_at)`
  ).bind(JSON.stringify(snapshot), Date.parse(snapshot.fetchedAt), Date.parse(snapshot.readingAt), Date.parse(snapshot.sourceUpdatedAt));
}

function saveHistory(env, dataset, point) {
  return env.PSI_DB.prepare(
    "INSERT INTO reading_history (dataset, reading_at, source_updated_at, readings) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(dataset, reading_at) DO UPDATE SET source_updated_at = excluded.source_updated_at, readings = excluded.readings " +
    "WHERE excluded.source_updated_at >= reading_history.source_updated_at"
  ).bind(dataset, Date.parse(point.readingAt), Date.parse(point.sourceUpdatedAt), JSON.stringify(point.values));
}

const historyPoint = (snapshot, field) => ({
  readingAt: snapshot.readingAt, sourceUpdatedAt: snapshot.sourceUpdatedAt,
  values: Object.fromEntries(snapshot.regions.map(region => [region.key, region[field]]))
});

async function fetchNea(env, url) {
  const headers = { Accept: "application/json" };
  if (env.NEA_API_KEY) headers["x-api-key"] = env.NEA_API_KEY;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`NEA request failed (${response.status})`);
  return response.json();
}

export async function refreshPsi(env, { broadcast = false } = {}) {
  const now = Date.now();
  const owner = crypto.randomUUID();
  const lock = await env.PSI_DB.prepare(
    "UPDATE refresh_lock SET owner = ?, expires_at = ? WHERE id = 1 AND expires_at <= ? RETURNING id"
  ).bind(owner, now + 30_000, now).first();
  if (!lock) return null;
  try {
    const [psi, pm25] = await Promise.allSettled([
      fetchNea(env, API_URL).then(body => normalizePsi(body)),
      fetchNea(env, PM25_API_URL).then(body => normalizePm25(body))
    ]);
    // PM2.5 is supplementary: its failure must neither block nor discard a PSI update.
    if (psi.status === "fulfilled") {
      await env.PSI_DB.batch([saveSnapshot(env, "psi_snapshot", psi.value), saveHistory(env, "psi", historyPoint(psi.value, "psi"))]);
    }
    if (pm25.status === "fulfilled") {
      await env.PSI_DB.batch([saveSnapshot(env, "pm25_snapshot", pm25.value), saveHistory(env, "pm25", historyPoint(pm25.value, "pm25"))]);
    } else console.error("PM2.5 refresh failed:", pm25.reason.message);
    if (psi.status === "rejected") throw psi.reason;
    const snapshot = await storedSnapshot(env);
    // A stale successful response must not broadcast a retained fresh cache from another refresh.
    if (broadcast && !isStale(psi.value)) await broadcastChannel(env, snapshot);
    return snapshot;
  } finally {
    await env.PSI_DB.prepare("UPDATE refresh_lock SET expires_at = 0 WHERE id = 1 AND owner = ?").bind(owner).run();
  }
}

const singaporeDate = ms => new Date(ms + 8 * 60 * 60_000).toISOString().slice(0, 10);

// Fills chart gaps (first deploy, missed refreshes) from NEA's date-filtered responses for today and yesterday.
export async function backfillHistory(env, now = Date.now()) {
  const dates = [...new Set([singaporeDate(now), singaporeDate(now - HISTORY_WINDOW)])];
  const results = await Promise.allSettled(Object.entries(NEA_URLS).flatMap(([dataset, url]) => dates.map(async date => {
    const points = historyPoints(await fetchNea(env, `${url}?date=${date}`), dataset)
      .filter(point => Date.parse(point.readingAt) > now - HISTORY_WINDOW);
    if (points.length) await env.PSI_DB.batch(points.map(point => saveHistory(env, dataset, point)));
  })));
  for (const result of results) if (result.status === "rejected") console.error("History backfill failed:", result.reason.message);
}

async function maintainHistory(env, scheduledTime) {
  const minute = new Date(scheduledTime).getUTCMinutes();
  const { n } = await env.PSI_DB.prepare("SELECT count(*) AS n FROM reading_history WHERE reading_at > ?").bind(scheduledTime - HISTORY_WINDOW).first();
  // Hourly, or every 15 minutes while the chart window is noticeably incomplete.
  if (minute === 10 || (n < 40 && minute % 15 === 0)) await backfillHistory(env, scheduledTime);
  await env.PSI_DB.prepare("DELETE FROM reading_history WHERE reading_at < ?").bind(scheduledTime - 2 * HISTORY_WINDOW).run();
}

async function history(env, now = Date.now()) {
  const { results } = await env.PSI_DB.prepare(
    "SELECT dataset, reading_at, readings FROM reading_history WHERE reading_at > ? ORDER BY reading_at"
  ).bind(now - HISTORY_WINDOW).all();
  const series = { psi: [], pm25: [] };
  for (const row of results) series[row.dataset]?.push({ at: new Date(row.reading_at).toISOString(), ...JSON.parse(row.readings) });
  return series;
}

async function latest(env, ctx, waitForRefresh = false) {
  let snapshot = await storedSnapshot(env);
  const due = !snapshot || Date.now() - Date.parse(snapshot.fetchedAt) >= REFRESH_INTERVAL;
  if (due) {
    const update = refreshPsi(env);
    if (!snapshot || waitForRefresh) {
      try { snapshot = await update ?? snapshot; }
      catch (error) { console.error("PSI refresh failed:", error.message); }
    } else {
      ctx.waitUntil(update.catch(error => console.error("PSI refresh failed:", error.message)));
    }
  }
  if (!snapshot) throw new Error("No PSI snapshot available yet");
  return snapshot;
}

export function parseCommand(text, botUsername = "") {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  if (match[2] && botUsername && match[2].toLowerCase() !== botUsername.replace(/^@/, "").toLowerCase()) return null;
  return { command: match[1].toLowerCase(), argument: (match[3] ?? "").trim().toLowerCase() };
}

async function handleTelegram(request, env, ctx) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return json({ error: "Bot is not configured" }, 503);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  const raw = await request.text();
  if (raw.length > 64_000) return json({ error: "Update too large" }, 413);
  let update;
  try { update = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!Number.isSafeInteger(update?.update_id)) return json({ error: "Invalid update" }, 400);
  const message = update.message;
  if (!Number.isSafeInteger(message?.chat?.id)) return json({ ok: true });
  const parsed = parseCommand(message.text, env.TELEGRAM_BOT_USERNAME);
  if (!parsed) return json({ ok: true });
  const { command, argument } = parsed;
  if (!["start", "help", "psi", "pm25"].includes(command) && message.chat.type !== "private") return json({ ok: true });

  const now = Date.now();
  const claim = await env.PSI_DB.prepare(
    "INSERT INTO telegram_updates (update_id, received_at, state) VALUES (?, ?, 'processing') " +
    "ON CONFLICT(update_id) DO UPDATE SET received_at = excluded.received_at " +
    "WHERE telegram_updates.state = 'processing' AND telegram_updates.received_at < ? RETURNING update_id"
  ).bind(update.update_id, now, now - 60_000).first();
  if (!claim) {
    const existing = await env.PSI_DB.prepare("SELECT state FROM telegram_updates WHERE update_id = ?").bind(update.update_id).first();
    return existing?.state === "sent" ? json({ ok: true }) : json({ error: "Update is still being processed" }, 503, { "Retry-After": "60" });
  }

  try {
    let text = HELP;
    if (command === "psi" || command === "pm25") {
      if (argument && !REGIONS.includes(argument)) {
        text = `Choose north, south, east, west, or central.\n\nExample: /${command} west\nAll regions: /${command}`;
      } else {
        try { text = telegramReading(await latest(env, ctx, true), argument || null, { dataset: command }); }
        catch { text = `NEA readings are temporarily unavailable and there is no saved reading yet. Please try /${command} again shortly.`; }
      }
    }
    const reply = { chat_id: message.chat.id, text, link_preview_options: { is_disabled: true } };
    if (env.PUBLIC_APP_URL) {
      try {
        const url = new URL(env.PUBLIC_APP_URL);
        if (url.protocol === "https:") reply.reply_markup = { inline_keyboard: [[{ text: "Open Hazey dashboard ↗", url: url.href }]] };
      } catch { /* A missing or invalid dashboard URL must not break replies. */ }
    }
    await telegramApi(env, "sendMessage", reply);
    await env.PSI_DB.prepare("UPDATE telegram_updates SET state = 'sent' WHERE update_id = ?").bind(update.update_id).run();
    return json({ ok: true });
  } catch (error) {
    console.error("Telegram reply failed; allowing Telegram to retry this update");
    await env.PSI_DB.prepare("DELETE FROM telegram_updates WHERE update_id = ? AND state = 'processing'").bind(update.update_id).run();
    return json({ error: "Reply failed; retry this update" }, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/api/psi") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
        try {
          const snapshot = await latest(env, ctx);
          const botUsername = (env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "");
          const botReady = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && /^[a-z0-9_]{5,32}$/i.test(botUsername);
          const pm25 = snapshot.pm25 && { ...snapshot.pm25, stale: isStale(snapshot.pm25) };
          return json({ ...snapshot, stale: isStale(snapshot), pm25, botUsername: botReady ? botUsername : null });
        } catch {
          return json({ error: "PSI readings are temporarily unavailable. Please try again shortly." }, 503, { "Retry-After": "30" });
        }
      }
      if (path === "/api/history") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
        return json(await history(env));
      }
      if (path === "/telegram/webhook") {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
        return await handleTelegram(request, env, ctx);
      }
      if (path.startsWith("/api/") || path.startsWith("/telegram/")) return json({ error: "Not found" }, 404);
      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error("Worker request failed:", error.message);
      return json({ error: "Service temporarily unavailable" }, 503, { "Retry-After": "30" });
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(Promise.all([
      refreshPsi(env, { broadcast: true }).catch(error => console.error("Scheduled refresh or channel broadcast failed:", error.message)),
      env.PSI_DB.prepare("DELETE FROM telegram_updates WHERE received_at < ?").bind(Date.now() - 7 * 24 * 60 * 60_000).run()
    ]).catch(error => console.error("Scheduled refresh failed:", error.message))
      .then(() => maintainHistory(env, controller.scheduledTime))
      .catch(error => console.error("History maintenance failed:", error.message)));
  }
};
