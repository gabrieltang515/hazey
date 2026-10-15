// Never include the request URL or token in errors or logs.
export async function telegramApi(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed (${response.status})`);
  return result.result;
}

// The bot's command menu. The scheduled job and the setup helper both send this list.
export const BOT_COMMANDS = [
  { command: "psi", description: "Latest 24-hour PSI; add a region, e.g. /psi west" },
  { command: "pm25", description: "Latest 1-hour PM2.5; add a region, e.g. /pm25 west" },
  { command: "shelter", description: "Nearest haze shelters; share your location or add a postal code" },
  { command: "help", description: "How to use Hazey" },
  { command: "start", description: "Welcome and available commands" }
];
