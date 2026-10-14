import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// One-time account onboarding. Reuses Wrangler's OAuth credential in memory only.
async function main() {
  const name = process.argv[2];
  if (!name || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new Error("Supply a valid workers.dev subdomain name.");
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  if (!/^[a-f0-9]{32}$/.test(config.account_id)) throw new Error("Set the Cloudflare account_id in wrangler.jsonc first.");
  const base = process.env.XDG_CONFIG_HOME || (process.platform === "darwin" ? join(homedir(), "Library/Preferences") : join(homedir(), ".config"));
  const credentials = await readFile(join(base, ".wrangler/config/default.toml"), "utf8");
  const token = credentials.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  if (!token) throw new Error("Run wrangler login first.");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/subdomain`;
  const get = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  const existing = await get.json();
  if (existing.success) { console.log(`Account subdomain: ${existing.result.subdomain}.workers.dev (preserved)`); return; }
  if (!existing.errors?.some(error => error.code === 10007)) throw new Error(`Cloudflare subdomain lookup failed (${get.status}).`);
  const put = await fetch(endpoint, {
    method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subdomain: name }), signal: AbortSignal.timeout(15_000)
  });
  const created = await put.json();
  if (!created.success) throw new Error(`Cloudflare could not register ${name} (${put.status}; codes ${created.errors?.map(e => e.code).join(",")}).`);
  console.log(`Registered account subdomain: ${created.result.subdomain}.workers.dev`);
}

main().catch(() => { console.error("Subdomain registration failed. Check Cloudflare onboarding and name availability; credentials were not printed."); process.exitCode = 1; });
