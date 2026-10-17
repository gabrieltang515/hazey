// Shared input handling for /shelter and /masks: a location shared in a private chat, or a postal code.
// Locations and postal codes are used for the reply only: never stored, and never written to logs.
import { lookupPostal, validPostalCode } from "./postal.js";

export const LOCATION_KEYBOARD = { keyboard: [[{ text: "📍 Share my location", request_location: true }]], one_time_keyboard: true, resize_keyboard: true };

// `things` names the results in prompts ("haze shelters") and `short` in the privacy line ("shelters").
// `reply(origin, label)` builds the answer once the place is known. Resolves to { text, reply_markup? }.
export async function nearbyCommand({ command, things, short, count, location, argument, isPrivate, reply }) {
  const example = `/${command} 530572`;
  if (location) return reply(location, "your location");
  const code = argument.replace(/\s/g, "");
  if (!code) {
    return isPrivate
      ? { text: `Share your location to find the ${count} nearest ${things}, or send a postal code, e.g. ${example}.\n\nYour location is only used to find ${short} and isn’t stored.`, reply_markup: LOCATION_KEYBOARD }
      : { text: `Send /${command} with a postal code, e.g. ${example}. To use your location, message me privately.` };
  }
  if (!validPostalCode(code)) return { text: `Postal codes have six digits, e.g. ${example}.` };
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
  return reply(place, `postal code ${code}`);
}
