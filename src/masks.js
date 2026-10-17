// /masks for the Telegram bot: the nearest free N95 mask points from the saved HazeMaskGoWhere list, with a link for live
// stock. Locations and postal codes are used for this reply only: never stored, and never written to logs.
import { MASK_SITES, MASK_SITES_AS_AT } from "../public/mask-sites.js";
import { MASK_FINDER_URL, MASK_KINDS, MASK_SHORT_URL } from "../public/masks.js";
import { directionsUrl, formatDistance, nearest } from "../public/geo.js";
import { singaporeTime } from "../public/psi.js";
import { nearbyCommand } from "./nearby.js";

const COUNT = 3;
// NEA haze situation update, 14 October 2026.
const ELIGIBILITY = "Who can collect: Pioneer and Merdeka Generation, CHAS Blue and Orange cardholders, Medical Fee Exemption Card holders and ComCare recipients at a CC or vending machine. Pregnant women, children aged 7 to 16 and people with conditions such as asthma at CCs only. Bring the eligible person’s NRIC.";
const OFFICIAL_BUTTON = [{ text: "Open HazeMaskGoWhere ↗", url: MASK_FINDER_URL }];

// Free mask distribution is on while wrangler.jsonc vars set MASK_DISTRIBUTION to "on"; remove it when distribution ends.
export const maskDistribution = env => env.MASK_DISTRIBUTION === "on";

export function masksReply({ origin, label, appUrl }) {
  const closest = nearest(origin, MASK_SITES, COUNT);
  const text = [
    closest[0].km > 30
      ? `The nearest free N95 mask point is ${formatDistance(closest[0].km)} from ${label}. These points are in Singapore only.`
      : `Nearest free N95 mask points to ${label}`,
    "",
    ...closest.flatMap((site, i) => [
      `${i + 1}. ${site.name} — ${formatDistance(site.km)}`,
      MASK_KINDS[site.kind],
      site.postal ? `${site.address}, Singapore ${site.postal}` : site.address,
      ...[site.spot, site.hours].filter(Boolean),
      ""
    ]),
    ELIGIBILITY,
    `Locations from HazeMaskGoWhere as at ${singaporeTime(MASK_SITES_AS_AT)} SGT. Stock changes through the day; check live stock before you go: ${MASK_SHORT_URL}`
  ].join("\n");
  const rows = closest.map(site => [{ text: `Directions: ${site.name}`, url: directionsUrl(site) }]);
  if (appUrl) rows.push([{ text: "Open the mask finder ↗", url: new URL("#masks", appUrl).href }]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

// Resolves to { text, reply_markup? } for /masks, or for a location shared after plain /masks.
export async function masksCommand({ location, argument, isPrivate, active, appUrl }) {
  if (!active) {
    return { text: `Free N95 mask distribution isn’t running right now. HazeMaskGoWhere has the latest: ${MASK_FINDER_URL}`,
      reply_markup: { inline_keyboard: [OFFICIAL_BUTTON] } };
  }
  return nearbyCommand({ command: "masks", things: "free N95 mask points", short: "mask points", count: COUNT, location, argument, isPrivate,
    reply: (origin, label) => masksReply({ origin, label, appUrl }) });
}
