// /shelter for the Telegram bot: the nearest community haze shelters to a shared location or a postal code.
// Locations and postal codes are used for this reply only: never stored, and never written to logs.
import { SHELTERS, SHELTERS_AS_AT } from "../public/shelters.js";
import { SHELTER_KINDS, directionsUrl, formatDistance, nearest } from "../public/geo.js";
import { regionList, shelterNotice } from "../public/psi.js";
import { nearbyCommand } from "./nearby.js";

const COUNT = 3;

// `regions` are the latest regional PSI readings, or null when no fresh reading is saved.
export function shelterReply({ origin, label, regions, appUrl }) {
  const closest = nearest(origin, SHELTERS, COUNT);
  const highest = regions?.length ? Math.max(...regions.map(region => region.psi)) : NaN;
  const where = Number.isFinite(highest) ? regionList(regions.filter(region => region.psi === highest).map(region => region.key)) : "";
  const text = [
    closest[0].km > 30
      ? `The nearest haze shelter is ${formatDistance(closest[0].km)} from ${label}. These shelters are in Singapore only.`
      : `Nearest haze shelters to ${label}`,
    "",
    ...closest.flatMap((shelter, i) => [
      `${i + 1}. ${shelter.name} — ${formatDistance(shelter.km)}`,
      `${shelter.address}, Singapore ${shelter.postal}`,
      SHELTER_KINDS[shelter.kind],
      ""
    ]),
    shelterNotice(highest, where),
    "Call the centre before you go to confirm the room and its opening hours. Distances are in a straight line.",
    `Shelter list: People’s Association, as at ${SHELTERS_AS_AT}.`
  ].join("\n");
  const rows = closest.map(shelter => [{ text: `Directions: ${shelter.name}`, url: directionsUrl(shelter) }]);
  if (appUrl) rows.push([{ text: "Open the shelter finder ↗", url: new URL("#shelters", appUrl).href }]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

// Resolves to { text, reply_markup? } for a /shelter command, or for a location shared in a private chat.
export function shelterCommand({ location, argument, isPrivate, regions, appUrl }) {
  return nearbyCommand({ command: "shelter", things: "haze shelters", short: "shelters", count: COUNT, location, argument, isPrivate,
    reply: (origin, label) => shelterReply({ origin, label, regions, appUrl }) });
}
