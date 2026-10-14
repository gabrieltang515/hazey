# Hazey handover

Updated: 14 October 2026, about 18:15 Singapore time.

## Requested outcome and current status

The owner, GitHub account `gabrieltang515`, requested a web app and Telegram bot showing the latest regional Singapore PSI from NEA/data.gov.sg, using Cloudflare Free storage, plus a private GitHub repository with this handover. On 14 October 2026 they also asked for PM2.5 levels.

- **Web app: deployed and working** at https://hazey.gabrieltang515.workers.dev, now with 24-hour PSI **and** NEA 1-hour PM2.5 for all five regions.
- **Storage: provisioned and initialized** in Cloudflare D1. Migrations `0001_init.sql` and `0002_pm25.sql` are applied to production and local.
- **Telegram bot: activated as [@hazey_sg_bot](https://t.me/hazey_sg_bot).** The owner created it in BotFather and ran the hidden-prompt setup helper, which installed `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, registered the webhook, set the command menu, and redeployed. Production logs show four real Telegram updates at 17:59–18:00 SGT, each answered `200`; the Worker returns `200` only after Telegram's `sendMessage` succeeds. The owner had not yet described the reply text at the time of writing.
- **GitHub: private repository** at https://github.com/gabrieltang515/hazey, branch `main`. Reuse it; do not run the repository-creation helper again.

## Remaining steps

1. **Add a data.gov.sg API key (owner action, recommended).** The 18:00 SGT scheduled refresh on 14 October was rejected by NEA with HTTP `429` (rate limited). Unauthenticated requests from Cloudflare's shared egress are throttled; saved readings were preserved and the next refresh succeeded, but refreshes can be skipped. Each refresh now makes two NEA calls (PSI and PM2.5). The owner should create a free API key on data.gov.sg, then in a terminal in this repo run `sh scripts/hazey.sh secret put NEA_API_KEY` and paste it at Wrangler's hidden prompt. The Worker already sends it as `x-api-key`, matching the spec. Never paste it into chat.
2. **Optional: show `/pm25` in the bot's command menu.** `/pm25` already works, but Telegram's menu was set before it existed. Rerunning `sh scripts/hazey.sh telegram https://hazey.gabrieltang515.workers.dev` with the BotFather token refreshes the menu (it also rotates the webhook secret and redeploys current source; run `sh scripts/hazey.sh test` first).
3. Ask the owner to confirm the bot's reply text for `/psi`, `/psi west`, and `/pm25` matches `/api/psi`.

## Existing Cloudflare resources

| Resource | Value |
| --- | --- |
| Account ID | `ce0cad81ccf18f3ac233cbf57b655270` |
| Worker | `hazey` |
| Account subdomain | `gabrieltang515.workers.dev` |
| Public URL | `https://hazey.gabrieltang515.workers.dev` |
| D1 database | `hazey-psi` |
| D1 database ID | `99e28f2e-26d1-4a44-8718-30a3b8b3bce2` |
| D1 binding | `PSI_DB` |
| Assets binding | `ASSETS` |
| Scheduled trigger | `*/5 * * * *` (every five minutes; cron is UTC) |
| Telegram bot | `@hazey_sg_bot` (username in `wrangler.jsonc` vars; token and webhook secret are Worker secrets) |
| Current deployment version | `04dec9dd-9485-4b07-9655-5809c7806b5e` (PM2.5 release, 14 Oct 2026 ~18:07 SGT) |

Cloudflare sign-in was completed successfully through Wrangler OAuth. The account originally had no Workers or D1 databases. The global `hazey.workers.dev` name was unavailable, so `gabrieltang515.workers.dev` was registered for this account. No paid plan or paid service was enabled. Keep the existing resources and Free requirement.

The public account/database IDs in source are resource identifiers, not credentials. Credentials remain in Wrangler's local config and Git's configured credential helper; do not print or copy them into the repo.

## Architecture and important behavior

- `src/worker.js` serves the same-origin `/api/psi` (PSI plus a nested `pm25` object or `null`), the authenticated `POST /telegram/webhook`, static assets, and the scheduled refresh.
- `src/psi.js` validates and normalizes both NEA responses. PSI requires valid 24-hour PSI values for all five regions and tolerates missing optional 24-hour pollutant fields. PM2.5 requires a non-negative `pm25_one_hourly` concentration for all five regions. Both choose the most recent observation.
- `public/psi.js` shares PSI category boundaries, NEA 1-hour PM2.5 bands (I Normal 0–55, II Elevated 56–150, III High 151–250, IV Very high ≥251), and SGT formatting between the browser and bot.
- `public/index.html`, `public/styles.css`, and `public/app.js` implement the responsive dashboard: 24-hour PSI and category, a 1-hour PM2.5 row with its band on each region card, separate PSI and PM2.5 reading times, optional 24-hour PM2.5/PM10 details, PSI and PM2.5 band legends, refresh, and delayed-data states for each dataset. The Telegram panel stays hidden until a bot username and both Worker secrets are configured.
- `migrations/0001_init.sql` creates a singleton PSI snapshot, a refresh lease, and Telegram update records. `migrations/0002_pm25.sql` adds a separate singleton PM2.5 snapshot. Refresh leases are atomic. Older observations and older revisions of the same observation cannot overwrite newer data in either table.
- One refresh fetches PSI and PM2.5 in parallel. Each saves independently: a PM2.5 failure is logged and never blocks or discards a PSI update, and saved PM2.5 survives later PM2.5 failures. The overdue-cache check uses the PSI snapshot age.
- Snapshot refreshes run every five minutes, including while the page is closed. Browser checks run every minute. Requests also refresh an overdue cache; browser requests return saved data while refreshing, while bot commands can await the refresh.
- Data is marked stale when the saved fetch is more than 15 minutes old or the observation is more than two hours old. Those are application freshness thresholds, not promises about NEA publication frequency.
- Telegram commands are `/start`, `/help`, `/psi` and `/psi <region>` (24-hour PSI section plus a separate 1-hour PM2.5 section), and `/pm25` and `/pm25 <region>` (PM2.5 only). Supported regions are north, south, east, west, central. Command names may contain digits. Mentions addressed to another configured bot are ignored.
- The webhook requires `X-Telegram-Bot-Api-Secret-Token`. Successful duplicate updates are ignored; processing updates are retried; failed sends release the record for retry. Deduplication records are pruned after seven days.
- Telegram `sendMessage` has no idempotency key: an ambiguous network failure after Telegram accepts a message can still produce a duplicate on retry. This limit is documented rather than claiming guaranteed exactly-once delivery.

## NEA API contract

Spec retained from the owner's latest relevant Downloads file: `docs/PollutantStandardsIndexPSI.json`.

Dataset: https://data.gov.sg/datasets/d_fe37906a0182569d891506e815e819b7/view

Latest endpoint: `https://api-open.data.gov.sg/v2/real-time/api/psi`, without a date filter.

The actual response was fetched and matched the v2 shape: `code`, `data.items`, `timestamp`, `updatedTimestamp`, and `readings.psi_twenty_four_hourly`. Current live responses omit `psi_three_hourly`, despite that field appearing in the downloaded spec. Do not invent three-hour values or substitute PM2.5. Actual timestamps include `+08:00`; parse their offsets and format with Asia/Singapore.

PM2.5 endpoint: `https://api-open.data.gov.sg/v2/real-time/api/pm25`. No spec file was supplied for it; the live response was fetched on 14 October 2026 and has `code`, `data.regionMetadata`, and `data.items[]` with `timestamp`, `updatedTimestamp` (`+08:00`), and `readings.pm25_one_hourly` for all five regions. It is a concentration in µg/m³, never PSI.

No NEA API key is strictly required, but unauthenticated calls from Cloudflare received HTTP `429` at least once (see Remaining steps). Add a key as the Worker secret `NEA_API_KEY`; the spec's `ApiKeyAuth` scheme sends it as the `x-api-key` header.

## Verification completed

Initial build (earlier on 14 October 2026):

- Wrangler deployment dry run, local and production D1 migration, local workerd fetch of real NEA readings, and production deployment with the five-minute trigger all succeeded.
- Headless Chrome checked the deployed app at 1440px and 390px; screenshots were inspected.

Telegram activation and PM2.5 release (17:55–18:15 SGT, 14 October 2026):

- Setup helper completed for `@hazey_sg_bot`; `wrangler secret list` shows both Telegram secrets; `/api/psi` reports `botUsername: "hazey_sg_bot"`; the dashboard shows the "Open the bot" panel (screenshots inspected).
- `wrangler tail` showed four `POST /telegram/webhook` updates from Telegram answered `200`.
- `wrangler tail` showed the five-minute cron firing (17:55 refresh succeeded; 18:00 got NEA `429`, saved readings preserved). After the PM2.5 deploy, the 18:10 refresh stored the first production PM2.5 snapshot.
- **22 Node tests pass**, adding PM2.5 band boundaries, PM2.5 validation, PM2.5 failure isolation from PSI, saved PM2.5 surviving failures, `/pm25` routing with digits, and labelled PSI/PM2.5 bot sections.
- Local `wrangler dev` against real NEA returned PSI and PM2.5 for all five regions.
- `0002_pm25.sql` applied to local and production D1; version `04dec9dd-9485-4b07-9655-5809c7806b5e` deployed.
- Browser check (now also asserting five PM2.5 values and the PM2.5 SGT time) passed locally and against production at desktop and mobile widths; screenshots inspected.

## Development and deployment commands

On a usual Node/npm installation:

```sh
npm ci
npm test
npm run db:local
npm run dev
npm run deploy
```

On the current Mac, `node` and `npm` are not in the default shell PATH. Cursor supplies Node at:

`/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node`

The checked-in wrapper locates that fallback automatically:

```sh
sh scripts/hazey.sh test
sh scripts/hazey.sh d1 migrations apply PSI_DB --local
sh scripts/hazey.sh d1 migrations apply PSI_DB --remote   # apply before deploying code that needs a new table
sh scripts/hazey.sh dev
sh scripts/hazey.sh deploy --dry-run
sh scripts/hazey.sh deploy
sh scripts/hazey.sh browser https://hazey.gabrieltang515.workers.dev
```

Wrangler is installed locally and pinned by `package-lock.json` (version 4.151.0 at handover). The dependency installation used a temporary npm CLI at `/private/tmp/hazey-npm-cli/package/bin/npm-cli.js`; that is a convenience for this session, not a permanent system installation. Fresh environments should install Node/npm and run `npm ci`.

Browser verification uses installed Chrome and Node's native DevTools/WebSocket support, with no browser test dependency. Set `CHROME_BIN` for non-macOS installations. Screenshots are saved in the system temporary directory, not the repository. The browser profile is temporary and removed after checks.

The local development DB is disposable and separate from production. Production is initialized with both migrations; do not drop or recreate its database. Apply any new migration to production **before** deploying code that queries it.

The Telegram setup helper rewrites `wrangler.jsonc` with `JSON.stringify` formatting; after rerunning it, restore the original formatting so the diff shows only intended changes.

Git remote: `https://github.com/gabrieltang515/hazey.git`, branch `main`, visibility **private**. The saved GitHub credential was verified as `gabrieltang515`. Local commit identity uses Gabriel Tang's GitHub noreply address. Do not read credential-helper output into logs. Ignore `node_modules`, `.wrangler`, `.dev.vars`, and `.env`.

Before ending subsequent work, update this file with the deployed version, verification results, and remaining tasks, and push the source to the existing repository.
