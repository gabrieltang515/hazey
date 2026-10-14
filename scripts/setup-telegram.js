import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const configPath = new URL("../wrangler.jsonc", import.meta.url);
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

function secretPrompt() {
  if (process.env.TELEGRAM_BOT_TOKEN) return Promise.resolve(process.env.TELEGRAM_BOT_TOKEN.trim());
  if (!process.stdin.isTTY) throw new Error("Run this in an interactive terminal, or supply TELEGRAM_BOT_TOKEN through the environment.");
  process.stdout.write("Paste the BotFather token (input is hidden): ");
  return new Promise((resolve, reject) => {
    let value = "";
    const previousRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = chunk => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") { cleanup(); reject(new Error("Cancelled")); return; }
        if (char === "\r" || char === "\n") { cleanup(); resolve(value.trim()); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

function wrangler(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerPath, ...args], { cwd: root, stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Wrangler ${args[0]} failed (${code})`)));
    child.stdin.on("error", () => {});
    child.stdin.end(input ? `${input}\n` : undefined);
  });
}

async function api(token, method, body = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000)
    });
  } catch { throw new Error(`Telegram ${method} could not connect`); }
  let result;
  try { result = await response.json(); } catch { throw new Error(`Telegram ${method} returned an invalid response`); }
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed (${response.status}); check the bot token and Worker URL`);
  return result.result;
}

async function main() {
  const rawUrl = process.argv[2];
  if (!rawUrl) throw new Error("Usage: npm run telegram:setup -- https://hazey.YOUR-SUBDOMAIN.workers.dev");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Supply the public HTTPS Worker origin, with no path, query, or credentials.");
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.d1_databases[0].database_id === "00000000-0000-0000-0000-000000000000") {
    throw new Error("Create the Cloudflare D1 database and set its database_id in wrangler.jsonc first.");
  }
  await readFile(wranglerPath);
  const token = await secretPrompt();
  if (!/^\d+:[a-z0-9_-]+$/i.test(token)) throw new Error("That does not look like a BotFather token.");
  const bot = await api(token, "getMe");
  if (!bot.is_bot || !bot.username) throw new Error("Telegram did not return a bot account.");
  const webhookSecret = randomBytes(32).toString("hex");
  config.vars = { ...config.vars, TELEGRAM_BOT_USERNAME: bot.username, PUBLIC_APP_URL: url.origin };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Configuring @${bot.username}. The bot token stays out of source files and command arguments.`);
  await wrangler(["secret", "put", "TELEGRAM_BOT_TOKEN"], token);
  await wrangler(["secret", "put", "TELEGRAM_WEBHOOK_SECRET"], webhookSecret);
  await wrangler(["deploy"]);
  await api(token, "setMyCommands", { commands: [
    { command: "psi", description: "Latest PSI and PM2.5; add a region, e.g. /psi west" },
    { command: "pm25", description: "Latest 1-hour PM2.5 only; add a region, e.g. /pm25 west" },
    { command: "help", description: "How to use Hazey" },
    { command: "start", description: "Welcome and available commands" }
  ] });
  await api(token, "setWebhook", {
    url: `${url.origin}/telegram/webhook`, secret_token: webhookSecret, allowed_updates: ["message"]
  });
  const webhook = await api(token, "getWebhookInfo");
  if (webhook.url !== `${url.origin}/telegram/webhook`) throw new Error("Telegram did not confirm the expected webhook URL.");
  console.log(`Ready: https://t.me/${bot.username}\nDashboard: ${url.origin}\nSend /psi to the bot.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
