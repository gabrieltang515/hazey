// /masks for the Telegram bot: the nearest free N95 mask points with stock, from the saved HazeMaskGoWhere list.
// Locations and postal codes are used for this reply only: never stored, and never written to logs.
import { MASK_FINDER_URL, MASK_KINDS, MASK_SHORT_URL, MASK_STOCK, collectable, stockUpdatedAt } from "../public/masks.js";
import { directionsUrl, formatDistance, nearest } from "../public/geo.js";
import { singaporeClock } from "../public/psi.js";
import { nearbyCommand } from "./nearby.js";

const COUNT = 3;
// NEA haze situation update, 14 October 2026.
const ELIGIBILITY = "Who can collect: Pioneer and Merdeka Generation, CHAS Blue and Orange cardholders, Medical Fee Exemption Card holders and ComCare recipients at a CC or vending machine. Pregnant women, children aged 7 to 16 and people with conditions such as asthma at CCs only. Bring the eligible person’s NRIC.";
const OFFICIAL_BUTTON = [{ text: "Open HazeMaskGoWhere ↗", url: MASK_FINDER_URL }];

function stockLines(masks, now) {
  const updated = stockUpdatedAt(masks.sources);
  const stale = Object.values(masks.sources).filter(source => source?.stale);
  const lines = [`Stock from HazeMaskGoWhere${updated ? `, updated ${singaporeClock(updated, now)}` : ""}. Live stock: ${MASK_SHORT_URL}`];
  if (stale.length) lines.unshift(`⚠️ Stock may be out of date: Hazey last checked at ${singaporeClock(Math.min(...stale.map(source => Date.parse(source.fetchedAt))), now)}.`);
  return lines;
}

// `masks` is the saved list from loadMasks.
export function masksReply({ origin, label, masks, appUrl, now = Date.now() }) {
  const closest = nearest(origin, masks.sites.filter(collectable), COUNT);
  if (!closest.length) {
    return { text: ["None of the listed free N95 mask points has stock right now.", "", ...stockLines(masks, now)].join("\n"),
      reply_markup: { inline_keyboard: [OFFICIAL_BUTTON] } };
  }
  const text = [
    closest[0].km > 30
      ? `The nearest free N95 mask point is ${formatDistance(closest[0].km)} from ${label}. These points are in Singapore only.`
      : `Nearest free N95 mask points to ${label}`,
    "",
    ...closest.flatMap((site, i) => [
      `${i + 1}. ${site.name} — ${formatDistance(site.km)}`,
      `${MASK_KINDS[site.kind]} • ${MASK_STOCK[site.stock]}`,
      site.postal ? `${site.address}, Singapore ${site.postal}` : site.address,
      ...[site.spot, site.hours].filter(Boolean),
      ""
    ]),
    ELIGIBILITY,
    ...stockLines(masks, now)
  ].join("\n");
  const rows = closest.map(site => [{ text: `Directions: ${site.name}`, url: directionsUrl(site) }]);
  if (appUrl) rows.push([{ text: "Open the mask finder ↗", url: new URL("#masks", appUrl).href }]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

// Resolves to { text, reply_markup? } for /masks, or for a location shared after plain /masks.
export async function masksCommand({ location, argument, isPrivate, masks, appUrl, now = Date.now() }) {
  if (!masks?.sites.length) {
    const listed = masks && (masks.sources.cc || masks.sources.vending);
    return {
      text: listed
        ? `No free N95 mask collection points are listed right now. Check HazeMaskGoWhere for updates: ${MASK_FINDER_URL}`
        : `Couldn’t load the free N95 mask list right now. Find collection points on HazeMaskGoWhere: ${MASK_FINDER_URL}`,
      reply_markup: { inline_keyboard: [OFFICIAL_BUTTON] }
    };
  }
  return nearbyCommand({ command: "masks", things: "free N95 mask points", short: "mask points", count: COUNT, location, argument, isPrivate,
    reply: (origin, label) => masksReply({ origin, label, masks, appUrl, now }) });
}
