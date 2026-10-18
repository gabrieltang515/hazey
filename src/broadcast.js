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
      const bot = (env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "");
      const botUsername = /^[a-z0-9_]{5,32}$/i.test(bot) ? bot : null;
      const masks = maskDistribution(env) ? maskCounts(MASK_SITES) : null;
      const kind = breach ? "breach" : active ? "hourly" : "regular";
      await telegramApi(env, "sendMessage", { chat_id: channel, ...channelPost(snapshot, kind, { appUrl, botUsername, masks }, now) });
      // Only successful delivery consumes a slot or completes the pending first alert.
      await env.PSI_DB.prepare("UPDATE channel_broadcasts SET pending_breach = 0, last_slot = ? WHERE channel_id = ? AND owner = ?")
        .bind(slot, channel, owner).run();
      console.log(`Channel broadcast sent (${kind})`);
    }
  } finally {
    await env.PSI_DB.prepare("UPDATE channel_broadcasts SET expires_at = 0 WHERE channel_id = ? AND owner = ?").bind(channel, owner).run();
  }
}
