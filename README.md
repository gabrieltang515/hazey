# Hazey

A responsive Singapore PSI and PM2.5 dashboard (region map, 24-hour trends, light and dark themes) and Telegram bot hosted together on a Cloudflare Worker. NEA data comes from two data.gov.sg real-time APIs:

- `https://api-open.data.gov.sg/v2/real-time/api/psi`, described in the downloaded `PollutantStandardsIndexPSI.json` spec
- `https://api-open.data.gov.sg/v2/real-time/api/pm25`, NEA’s 1-hour PM2.5 readings

**Live dashboard:** https://hazey.gabrieltang515.workers.dev

**Private repository:** https://github.com/gabrieltang515/hazey

The Cloudflare Worker and D1 database are already provisioned for `gabrieltang515`. **Do not recreate the existing database.** Start with [HANDOVER.md](HANDOVER.md) for the deployed state and remaining steps.

The app displays `psi_twenty_four_hourly` for **north, south, east, west, and central**. It never substitutes pollutant concentrations or invented readings for PSI. The current live response omits the spec’s `psi_three_hourly` field, so the app does not depend on it. All displayed times use Asia/Singapore.

PM2.5 is shown separately as a **1-hour concentration in µg/m³** (`pm25_one_hourly`), with NEA’s 1-hour bands: Band I Normal (0–55), Band II Elevated (56–150), Band III High (151–250), Band IV Very high (251 and above). It is never labelled or used as PSI. PM2.5 has its own snapshot and timestamps, so a PM2.5 outage never blocks or replaces PSI readings.

## What is included

- Responsive, buildless dashboard: a map of the five NEA regions tinted by band, a 24-hour PSI / 1-hour PM2.5 switch, a plain-language summary, region cards with a 24-hour trend line (hover and keyboard readouts, plus a table view), optional 24-hour PM2.5 and PM10 details, a live status pill, manual refresh, and automatic checks every minute.
- Light and dark themes follow the device setting, with a saved toggle. Fonts (Newsreader, Public Sans; SIL OFL) are self-hosted in `public/fonts`.
- `GET /api/history` serves the last 25 hourly readings per dataset from D1. Each refresh appends the latest hour, and the scheduled job backfills gaps from NEA's date-filtered responses (hourly, or every 15 minutes while the window is incomplete).
- Cloudflare D1 stores one latest PSI snapshot, one latest PM2.5 snapshot, and about two days of hourly history. A five minute scheduled Worker job refreshes both snapshots; requests also refresh an overdue cache.
- Atomic database leases prevent concurrent source refreshes. An older reading cannot replace a newer observation.
- Saved readings remain available during NEA outages, with an explicit delayed-data label. Cold-start failures display an error instead of sample values.
- Telegram `/start`, `/help`, `/psi` and `/psi west` (24-hour PSI only), and `/pm25` and `/pm25 west` (1-hour PM2.5 only) commands. The webhook requires Telegram’s secret header and records handled update IDs for retry deduplication.
- Private setup script configures Worker secrets, Telegram commands, the webhook, and dashboard links. Tokens are never stored in source files.
- Automated Telegram broadcasts to [@hazey_sg](https://t.me/hazey_sg): four-hour summaries from 6am SGT, immediate PSI >200 alerts, and hourly updates during an alert episode. Apply migration `0004_channel_broadcasts.sql` before deploying this feature.

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

The bot responds to commands when requested. People receive automated broadcasts by joining the configured Telegram channel; there are no individual subscriptions. Successful duplicate command updates are ignored. If Telegram returns an ambiguous network failure after accepting a message, a retry can still duplicate a reply or broadcast because Telegram’s `sendMessage` endpoint has no idempotency key.

## Automated channel reports

Create a public Telegram channel and add `@hazey_sg_bot` as an administrator with **Post Messages** enabled. This checkout targets `@hazey_sg`, configured with `TELEGRAM_CHANNEL_ID` in `wrangler.jsonc`; the bot uses the existing `TELEGRAM_BOT_TOKEN` Worker secret. Broadcasts have been live since 15 October 2026; see [HANDOVER.md](HANDOVER.md) for the deployed state. Changing the channel requires the same administrator setup. Remove `TELEGRAM_CHANNEL_ID` and redeploy to disable broadcasts.

- Regular reports use fixed Singapore-time slots: **02:00, 06:00, 10:00, 14:00, 18:00, 22:00**.
- Overall Singapore 24-hour PSI is NEA's regional minimum–maximum range, computed from the five official regional readings supplied by the API. It is not an average or a separate invented national reading.
- An upper bound **above 200** starts an alert episode and sends immediately on detection. Thereafter, reports use full clock hours; a breach found at 15:20 sends then, followed by 16:00, 17:00, etc.
- Exactly 200 keeps an existing episode active but does not start one. Below 200 clears the episode silently and resumes the fixed four-hour schedule, without a recovery message. Overlapping regular and hourly slots produce one report.
- Each report includes all five regional PSI and **1-hour PM2.5 (µg/m³)** readings, and precautions for the greatest regional PSI. PM2.5 concentrations do not trigger the PSI alert.
  - **Format:** reports use Telegram's HTML formatting (`<b>`, `<i>` and `<a>` only, with every inserted value escaped). The first line says how bad the air is, for example "⚠️ Haze alert: PSI 206 in the West region". Each region has a band-coloured dot.
  - **Trend arrows:** each PSI shows its change since the reading saved an hour earlier (`↑4`, `↓3`, `±0`). The arrow is left out when that hour wasn't saved.
  - **Times:** the PM2.5 time is shown only when it differs from the PSI time.
  - **Links:** the dashboard, the MOH advice and data.gov.sg appear as text links. The dashboard, shelter and mask finders are also buttons.
- Advice paraphrases the [MOH health advisory published by NEA](https://www.nea.gov.sg/our-services/pollution-control/air-pollution/managing-haze), checked 14 October 2026. Normal activities are permitted at PSI ≤100; restrictions on outdoor exertion/activity increase for 101–200, 201–300 and above 300, with separate guidance for vulnerable groups.

The existing five-minute cron checks for breaches, so “immediate” means on the first successful scheduled detection. Scheduled reports wait for NEA's observation for the current hour and retry during that hour if publication is late. Missed historical reports are not sent in a burst. Stale/future PSI or a failed source refresh do not generate reports or clear the saved alert state. Missing PM2.5 never blocks a PSI report, and delayed saved PM2.5 is labelled explicitly.

Migration `0004_channel_broadcasts.sql` adds durable per-channel reporting state and an atomic lease. Observed alert mode is saved independently of delivery, with a pending first alert for retries, and older observations/revisions cannot reverse newer state. Overlapping cron runs cannot normally double-post; only successful sends consume the reporting slot. Failed sends are retried on subsequent checks, and recovery cancels a pending alert. Future upstream observations are rejected before cache writes. The Telegram ambiguous-delivery limitation described above still applies.

For the existing deployment, run `npm run db:remote` before `npm run deploy`. Verify a real broadcast and the cron's `Channel broadcast sent` log before claiming activation.

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

With Chrome installed, `npm run check:browser -- https://hazey.gabrieltang515.workers.dev` checks the live page at desktop and mobile widths, including five populated cards with PSI and 1-hour PM2.5, the banded map, the PSI/PM2.5 switch, trend charts, the dark theme, SGT times, horizontal overflow, details, and refresh. Screenshots are written to the system temporary directory. Set `CHROME_BIN` on systems where Chrome is not at its default macOS path.

The tests cover PSI category and PM2.5 band boundaries, API validation for both datasets, PM2.5 failures that must not block PSI, missing optional fields, SGT formatting, stale readings, real SQL cache writes and leases, snapshot ordering, webhook authentication, command routing, duplicate updates, failed replies, and HTTP methods. Tests use Node’s built-in SQLite against the actual migrations, plus mocked external APIs. The live Cloudflare deployment and Telegram webhook delivery have been verified; see [HANDOVER.md](HANDOVER.md).

## Source

[NEA PSI dataset on data.gov.sg](https://data.gov.sg/datasets/d_fe37906a0182569d891506e815e819b7/view). The supplied OpenAPI spec is retained in `docs/PollutantStandardsIndexPSI.json`. PM2.5 uses NEA’s real-time endpoint `https://api-open.data.gov.sg/v2/real-time/api/pm25`; its live response was checked and has `data.items[].readings.pm25_one_hourly` for all five regions. Adding `?date=YYYY-MM-DD` to either endpoint returns that Singapore day's hourly items, which the history backfill uses.

The map land outline in `public/map-data.js` contains information from [URA Master Plan 2019 Region Boundary (No Sea)](https://data.gov.sg/datasets/d_bf4d24df9129d5a8ff8cf82e20959ee0/view), accessed 14 October 2026 from data.gov.sg under the [Singapore Open Data Licence v1.0](https://data.gov.sg/open-data-licence). Region boundaries on the map are approximate Voronoi cells around NEA's published regional reference points; NEA does not publish region polygons. The page footer carries the required attribution.
