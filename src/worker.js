import { API_URL, REFRESH_INTERVAL, normalizePsi, isStale, telegramReading } from "./psi.js";
import { REGIONS } from "../public/psi.js";

const HELP = "Welcome to Hazey ☁️\n\nGet the latest NEA 24-hour PSI for Singapore.\n\n/psi — all five regions\n/psi north — one region\n\nRegions: north, south, east, west, central.\n/help — these commands\n\nReadings refresh every 5 minutes; NEA publishes the underlying readings on its own schedule.";

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders
  } });
}

async function storedSnapshot(env) {
  const row = await env.PSI_DB.prepare("SELECT payload FROM psi_snapshot WHERE id = 1").first();
  return row ? JSON.parse(row.payload) : null;
}

export async function refreshPsi(env) {
  const now = Date.now();
  const owner = crypto.randomUUID();
  const lock = await env.PSI_DB.prepare(
    "UPDATE refresh_lock SET owner = ?, expires_at = ? WHERE id = 1 AND expires_at <= ? RETURNING id"
  ).bind(owner, now + 30_000, now).first();
  if (!lock) return null;
  try {
    const headers = { Accept: "application/json" };
    if (env.NEA_API_KEY) headers["x-api-key"] = env.NEA_API_KEY;
    const response = await fetch(API_URL, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`NEA request failed (${response.status})`);
    const snapshot = normalizePsi(await response.json());
    // An older upstream result must never replace a newer saved observation.
    await env.PSI_DB.prepare(
      "INSERT INTO psi_snapshot (id, payload, fetched_at, reading_at, source_updated_at) VALUES (1, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, reading_at = excluded.reading_at, source_updated_at = excluded.source_updated_at " +
      "WHERE excluded.reading_at > psi_snapshot.reading_at OR " +
      "(excluded.reading_at = psi_snapshot.reading_at AND excluded.source_updated_at >= psi_snapshot.source_updated_at)"
    ).bind(JSON.stringify(snapshot), Date.parse(snapshot.fetchedAt), Date.parse(snapshot.readingAt), Date.parse(snapshot.sourceUpdatedAt)).run();
    return await storedSnapshot(env);
  } finally {
    await env.PSI_DB.prepare("UPDATE refresh_lock SET expires_at = 0 WHERE id = 1 AND owner = ?").bind(owner).run();
  }
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
  const match = text.trim().match(/^\/([a-z]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  if (match[2] && botUsername && match[2].toLowerCase() !== botUsername.replace(/^@/, "").toLowerCase()) return null;
  return { command: match[1].toLowerCase(), argument: (match[3] ?? "").trim().toLowerCase() };
}

async function telegramApi(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed (${response.status})`);
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
  if (!["start", "help", "psi"].includes(command) && message.chat.type !== "private") return json({ ok: true });

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
    if (command === "psi") {
      if (argument && !REGIONS.includes(argument)) {
        text = "Choose north, south, east, west, or central.\n\nExample: /psi west\nAll regions: /psi";
      } else {
        try { text = telegramReading(await latest(env, ctx, true), argument || null); }
        catch { text = "NEA readings are temporarily unavailable and there is no saved reading yet. Please try /psi again shortly."; }
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
          return json({ ...snapshot, stale: isStale(snapshot), botUsername: botReady ? botUsername : null });
        } catch {
          return json({ error: "PSI readings are temporarily unavailable. Please try again shortly." }, 503, { "Retry-After": "30" });
        }
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
      refreshPsi(env),
      env.PSI_DB.prepare("DELETE FROM telegram_updates WHERE received_at < ?").bind(Date.now() - 7 * 24 * 60 * 60_000).run()
    ]).catch(error => console.error("Scheduled refresh failed:", error.message)));
  }
};
