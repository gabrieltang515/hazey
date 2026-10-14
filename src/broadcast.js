import { category, singaporeTime } from "../public/psi.js";
import { isStale } from "./psi.js";
import { telegramApi } from "./telegram.js";

const HOUR = 60 * 60_000;
const ADVISORY_URL = "https://www.nea.gov.sg/our-services/pollution-control/air-pollution/managing-haze";

// Paraphrases of the MOH health advisory published by NEA, checked 14 October 2026.
// The greatest regional PSI determines the precautions; PM2.5 is a separate concentration.
export function healthAdvice(psi) {
  if (psi <= 100) return "Normal activities can continue for all groups.";
  if (psi <= 200) return [
    "Healthy people: reduce lengthy or strenuous outdoor exertion.",
    "Older people, pregnant women and children: keep lengthy or strenuous outdoor exertion to a minimum.",
    "People with chronic lung or heart conditions: avoid lengthy or strenuous outdoor exertion."
  ].join("\n");
  if (psi <= 300) return [
    "Healthy people: avoid lengthy or strenuous outdoor exertion.",
    "Older people, pregnant women and children: minimise outdoor activity.",
    "People with chronic lung or heart conditions: avoid outdoor activity."
  ].join("\n");
  return [
    "Healthy people: minimise outdoor activity.",
    "Older people, pregnant women, children and people with chronic lung or heart conditions: avoid outdoor activity."
  ].join("\n");
}

export function channelMessage(snapshot, kind, appUrl, now = Date.now()) {
  const values = snapshot.regions.map(region => region.psi);
  const low = Math.min(...values), high = Math.max(...values);
  const lowBand = category(low).label, highBand = category(high).label;
  const bands = lowBand === highBand ? highBand : `${lowBand} to ${highBand}`;
  const pm25 = snapshot.pm25 && Date.parse(snapshot.pm25.readingAt) <= now ? snapshot.pm25 : null;
  const title = kind === "breach" ? "⚠️ Hazey • PSI alert" : kind === "hourly" ? "Hazey • Hourly air quality update" : "Hazey • Air quality update";
  const lines = [title, "", `Overall Singapore (24-hour PSI): ${low}–${high} (${bands})`,
    `PSI reading: ${singaporeTime(snapshot.readingAt)} SGT`, "", "Regional 24-hour PSI / 1-hour PM2.5 (µg/m³):",
    ...snapshot.regions.map(region => {
      const pm = pm25?.regions.find(value => value.key === region.key);
      return `${region.name}: PSI ${region.psi} • ${pm ? `PM2.5 ${pm.pm25}` : "PM2.5 unavailable"}`;
    })];
  if (pm25) {
    lines.push("", `PM2.5 reading: ${singaporeTime(pm25.readingAt)} SGT`);
    if (isStale(pm25, now)) lines.push("⚠️ PM2.5 data is delayed; showing saved values.");
  }
  lines.push("", "Health advice (based on the highest regional PSI):", healthAdvice(high));
  if (high > 100) lines.push("If you feel unwell, seek medical attention, especially if you are in a vulnerable group.");
  lines.push("", `MOH guidance via NEA: ${ADVISORY_URL}`, "Source: NEA via data.gov.sg");
  if (appUrl) lines.push("", `More readings and trends: ${appUrl}`);
  return lines.join("\n");
}

// The five-minute scheduled refresh is the only broadcaster. Commands never subscribe people.
export async function broadcastChannel(env, snapshot, now = Date.now()) {
  const channel = env.TELEGRAM_CHANNEL_ID;
  if (!channel || !env.TELEGRAM_BOT_TOKEN) return;
  if (!/^(@[a-z0-9_]{5,32}|-\d+)$/i.test(channel)) throw new Error("Invalid Telegram channel identifier");
  if (!snapshot || isStale(snapshot, now) || Date.parse(snapshot.readingAt) > now) return;

  await env.PSI_DB.prepare("INSERT OR IGNORE INTO channel_broadcasts (channel_id) VALUES (?)").bind(channel).run();
  const owner = crypto.randomUUID();
  const state = await env.PSI_DB.prepare(
    "UPDATE channel_broadcasts SET owner = ?, expires_at = ? WHERE channel_id = ? AND expires_at <= ? RETURNING alert_active, pending_breach, last_slot, reading_at, source_updated_at"
  ).bind(owner, now + 60_000, channel, now).first();
  if (!state) return;
  try {
    // Re-read under the lease: the incoming caller may have waited behind a newer refresh.
    const row = await env.PSI_DB.prepare(
      "SELECT payload, (SELECT payload FROM pm25_snapshot WHERE id = 1) AS pm25 FROM psi_snapshot WHERE id = 1"
    ).first();
    if (row) snapshot = { ...JSON.parse(row.payload), pm25: row.pm25 ? JSON.parse(row.pm25) : null };
    if (isStale(snapshot, now) || Date.parse(snapshot.readingAt) > now) return;
    const readingAt = Date.parse(snapshot.readingAt), updatedAt = Date.parse(snapshot.sourceUpdatedAt);
    if (readingAt < state.reading_at || (readingAt === state.reading_at && updatedAt < state.source_updated_at)) return;
    const high = Math.max(...snapshot.regions.map(region => region.psi));
    // 200 does not start an episode, but an existing episode ends strictly below 200.
    const active = state.alert_active ? high >= 200 : high > 200;
    const breach = active && (state.pending_breach || !state.alert_active);
    // Observed mode must survive delivery failure. A recovery also cancels a pending first alert.
    await env.PSI_DB.prepare(
      "UPDATE channel_broadcasts SET alert_active = ?, pending_breach = ?, reading_at = ?, source_updated_at = ? WHERE channel_id = ? AND owner = ?"
    ).bind(Number(active), Number(Boolean(breach)), readingAt, updatedAt, channel, owner).run();
    const slot = Math.floor(now / HOUR) * HOUR;
    const hourSGT = new Date(slot + 8 * HOUR).getUTCHours();
    const regularSlot = hourSGT % 4 === 2; // 02, 06, 10, 14, 18, 22 SGT
    const due = (active || regularSlot) && state.last_slot < slot && Date.parse(snapshot.readingAt) >= slot;
    if (breach || due) {
      const appUrl = env.PUBLIC_APP_URL && new URL(env.PUBLIC_APP_URL).protocol === "https:" ? env.PUBLIC_APP_URL : null;
      const reply = { chat_id: channel, text: channelMessage(snapshot, breach ? "breach" : active ? "hourly" : "regular", appUrl, now),
        link_preview_options: { is_disabled: true } };
      if (appUrl) reply.reply_markup = { inline_keyboard: [[{ text: "View Hazey dashboard", url: appUrl }]] };
      await telegramApi(env, "sendMessage", reply);
      // Only successful delivery consumes a slot or completes the pending first alert.
      await env.PSI_DB.prepare("UPDATE channel_broadcasts SET pending_breach = 0, last_slot = ? WHERE channel_id = ? AND owner = ?")
        .bind(slot, channel, owner).run();
      console.log(`Channel broadcast sent (${breach ? "breach" : active ? "hourly" : "regular"})`);
    }
  } finally {
    await env.PSI_DB.prepare("UPDATE channel_broadcasts SET expires_at = 0 WHERE channel_id = ? AND owner = ?").bind(channel, owner).run();
  }
}
