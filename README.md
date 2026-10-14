# Hazey

A responsive Singapore PSI and PM2.5 dashboard and Telegram bot hosted together on a Cloudflare Worker. NEA data comes from two data.gov.sg real-time APIs:

- `https://api-open.data.gov.sg/v2/real-time/api/psi`, described in the downloaded `PollutantStandardsIndexPSI.json` spec
- `https://api-open.data.gov.sg/v2/real-time/api/pm25`, NEA’s 1-hour PM2.5 readings

**Live dashboard:** https://hazey.gabrieltang515.workers.dev

**Private repository:** https://github.com/gabrieltang515/hazey

The Cloudflare Worker and D1 database are already provisioned for `gabrieltang515`. **Do not recreate the existing database.** Start with [HANDOVER.md](HANDOVER.md) for the deployed state and remaining steps.

The app displays `psi_twenty_four_hourly` for **north, south, east, west, and central**. It never substitutes pollutant concentrations or invented readings for PSI. The current live response omits the spec’s `psi_three_hourly` field, so the app does not depend on it. All displayed times use Asia/Singapore.

PM2.5 is shown separately as a **1-hour concentration in µg/m³** (`pm25_one_hourly`), with NEA’s 1-hour bands: Band I Normal (0–55), Band II Elevated (56–150), Band III High (151–250), Band IV Very high (251 and above). It is never labelled or used as PSI. PM2.5 has its own snapshot and timestamps, so a PM2.5 outage never blocks or replaces PSI readings.

## What is included

- Responsive dashboard with 24-hour PSI categories, 1-hour PM2.5 bands on every region, optional 24-hour PM2.5 and PM10 details, manual refresh, and automatic checks every minute.
- Cloudflare D1 stores one latest PSI snapshot and one latest PM2.5 snapshot. A five minute scheduled Worker job refreshes both; requests also refresh an overdue cache.
- Atomic database leases prevent concurrent source refreshes. An older reading cannot replace a newer observation.
- Saved readings remain available during NEA outages, with an explicit delayed-data label. Cold-start failures display an error instead of sample values.
- Telegram `/start`, `/help`, `/psi` (PSI and PM2.5), `/psi west`, `/pm25`, and `/pm25 west` commands. The webhook requires Telegram’s secret header and records handled update IDs for retry deduplication.
- Private setup script configures Worker secrets, Telegram commands, the webhook, and dashboard links. Tokens are never stored in source files.

## Cloudflare Free setup

Use a Cloudflare **Free** account with Workers and D1; these services have free quotas, not unlimited capacity. No paid plan or additional server is needed for ordinary usage. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) for current quotas.

Install Node.js 22.13 or newer, then in this folder:

```sh
npm install
npx wrangler login
npx wrangler d1 create hazey-psi
```

Those provisioning steps are for a **new account/deployment**. This checkout already contains the current account and database IDs. For the existing deployment, install dependencies with `npm ci`, reuse the database, and run `npm run deploy`. A new account needs its own `account_id`, `database_id`, and workers.dev subdomain.

Copy the returned `database_id` into `wrangler.jsonc`, replacing the all-zero placeholder. Keep the binding name `PSI_DB`.

Apply the database migrations and deploy:

```sh
npm run db:remote
npm run deploy
```

Wrangler prints your `https://hazey.YOUR-SUBDOMAIN.workers.dev` URL. This is both the dashboard and the bot’s server. The first dashboard request fetches and stores the initial reading; the cron keeps refreshing it while the page is closed.

## Create and activate the Telegram bot

Bot creation requires your own Telegram account:

1. Open the verified [@BotFather](https://t.me/BotFather) account in Telegram.
2. Send `/newbot` and choose **Hazey** as the display name.
3. Choose an available username ending in `bot`, for example `hazey_psi_bot`. `hazey` alone is not a valid bot username.
4. Keep the token BotFather returns private.

After the Worker is deployed, run:

```sh
npm run telegram:setup -- https://hazey.YOUR-SUBDOMAIN.workers.dev
```

Paste the BotFather token into the hidden terminal prompt. The script confirms the bot identity, generates a webhook secret, stores both secrets in Cloudflare, saves the public bot username and dashboard URL in `wrangler.jsonc`, redeploys, sets the bot commands, and verifies the registered webhook. Open the printed bot link and send `/psi`.

On the current Mac, Node is supplied by Cursor and `npm` is not on the normal shell path. The equivalent activation command uses the included wrapper:

```sh
sh scripts/hazey.sh telegram https://hazey.gabrieltang515.workers.dev
```

The Telegram panel stays hidden until the bot’s username and Worker secrets are configured.

The bot responds to commands when requested; it does not subscribe users or send unsolicited alerts. Successful duplicate updates are ignored. If Telegram returns an ambiguous network failure after accepting a message, a retry can still duplicate a reply because Telegram’s `sendMessage` endpoint has no idempotency key.

## Local development

```sh
npm run db:local
npm run dev
```

Wrangler supplies the static assets and local D1 binding. Local data stays separate from the production database. The NEA API is public, but unauthenticated requests from Cloudflare are sometimes rejected with HTTP 429. Store a free data.gov.sg API key with `npx wrangler secret put NEA_API_KEY` (sent as the `x-api-key` header) for reliable scheduled refreshes.

For local webhook work, put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` in an ignored `.dev.vars` file. Telegram requires a publicly accessible HTTPS webhook; `localhost` cannot receive its updates.

## Verification

```sh
npm test
npx wrangler deploy --dry-run
```

With Chrome installed, `npm run check:browser -- https://hazey.gabrieltang515.workers.dev` checks the live page at desktop and mobile widths, including five populated cards with PSI and 1-hour PM2.5, SGT times, horizontal overflow, details, and refresh. Screenshots are written to the system temporary directory. Set `CHROME_BIN` on systems where Chrome is not at its default macOS path.

The tests cover PSI category and PM2.5 band boundaries, API validation for both datasets, PM2.5 failures that must not block PSI, missing optional fields, SGT formatting, stale readings, real SQL cache writes and leases, snapshot ordering, webhook authentication, command routing, duplicate updates, failed replies, and HTTP methods. Tests use Node’s built-in SQLite against the actual migrations, plus mocked external APIs. The live Cloudflare deployment and Telegram webhook delivery have been verified; see [HANDOVER.md](HANDOVER.md).

## Source

[NEA PSI dataset on data.gov.sg](https://data.gov.sg/datasets/d_fe37906a0182569d891506e815e819b7/view). The supplied OpenAPI spec is retained in `docs/PollutantStandardsIndexPSI.json`. PM2.5 uses NEA’s real-time endpoint `https://api-open.data.gov.sg/v2/real-time/api/pm25`; its live response was checked and has `data.items[].readings.pm25_one_hourly` for all five regions.
