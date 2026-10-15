// /shelter for the Telegram bot: the nearest community haze shelters to a shared location or a postal code.
// Locations and postal codes are used for this reply only: never stored, and never written to logs.
import { SHELTERS, SHELTERS_AS_AT } from "../public/shelters.js";
import { SHELTER_KINDS, directionsUrl, formatDistance, nearest } from "../public/geo.js";
import { regionList, shelterNotice } from "../public/psi.js";
import { lookupPostal, validPostalCode } from "./postal.js";

const COUNT = 3;
const POSTAL_EXAMPLE = "/shelter 530572";
const LOCATION_KEYBOARD = { keyboard: [[{ text: "📍 Share my location", request_location: true }]], one_time_keyboard: true, resize_keyboard: true };

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
export async function shelterCommand({ location, argument, isPrivate, regions, appUrl }) {
  if (location) return shelterReply({ origin: location, label: "your location", regions, appUrl });
  const code = argument.replace(/\s/g, "");
  if (!code) {
    return isPrivate
      ? { text: `Share your location to find the ${COUNT} nearest haze shelters, or send a postal code, e.g. ${POSTAL_EXAMPLE}.\n\nYour location is only used to find shelters and isn’t stored.`, reply_markup: LOCATION_KEYBOARD }
      : { text: `Send /shelter with a postal code, e.g. ${POSTAL_EXAMPLE}. To use your location, message me privately.` };
  }
  if (!validPostalCode(code)) return { text: `Postal codes have six digits, e.g. ${POSTAL_EXAMPLE}.` };
  let place;
  try {
    place = await lookupPostal(code);
  } catch (error) {
    console.error("Postal code lookup failed:", error.message);
    return isPrivate
      ? { text: "Postal code lookup is unavailable right now. Share your location instead, or try again shortly.", reply_markup: LOCATION_KEYBOARD }
      : { text: "Postal code lookup is unavailable right now. Please try again shortly." };
  }
  if (!place) return { text: `Couldn’t find postal code ${code}. Check the number and try again.` };
  return shelterReply({ origin: place, label: `postal code ${code}`, regions, appUrl });
}
