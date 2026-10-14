# Hazey handover

Updated: 14 October 2026, Singapore time.

## Requested outcome and current status

The owner, GitHub account `gabrieltang515`, requested a web app and Telegram bot showing the latest regional Singapore PSI from NEA/data.gov.sg, using Cloudflare Free storage. They also requested a new GitHub repository containing the code and this handover before the current agent stops.

- **Web app: deployed and working** at https://hazey.gabrieltang515.workers.dev.
- **Storage: provisioned and initialized** in Cloudflare D1; production fetches persist the latest snapshot.
- **Telegram backend: implemented and tested, activation pending.** The owner has not created the bot in BotFather. No bot token or webhook secret has been configured, and no actual Telegram delivery has been verified.
- **GitHub: private repository created** at https://github.com/gabrieltang515/hazey. Reuse this repository; do not run the repository-creation helper again. The handover and all source are included in the initial push on `main`.

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
| Current deployment version | `cbf492d3-f831-4541-8d73-10e4bc7ab5ce` |

Cloudflare sign-in was completed successfully through Wrangler OAuth. The account originally had no Workers or D1 databases. The global `hazey.workers.dev` name was unavailable, so `gabrieltang515.workers.dev` was registered for this account. No paid plan or paid service was enabled. Keep the existing resources and Free requirement.

The public account/database IDs in source are resource identifiers, not credentials. Credentials remain in Wrangler's local config and Git's configured credential helper; do not print or copy them into the repo.

## Architecture and important behavior

- `src/worker.js` serves the same-origin `/api/psi`, the authenticated `POST /telegram/webhook`, static assets, and the scheduled refresh.
- `src/psi.js` validates the NEA response and normalizes it. It requires valid 24-hour PSI values for all five regions, chooses the most recent observation, and tolerates missing optional pollutant fields.
- `public/psi.js` shares PSI category boundaries and SGT formatting between the browser and bot.
- `public/index.html`, `public/styles.css`, and `public/app.js` implement the responsive dashboard. They show 24-hour PSI, each category, reading/update timestamps, optional PM2.5/PM10 concentrations, refresh, and delayed-data states. The Telegram panel stays hidden until a bot username and both Worker secrets are configured.
- `migrations/0001_init.sql` creates a singleton PSI snapshot, a refresh lease, and Telegram update records. Refresh leases are atomic. Older observations and older revisions of the same observation cannot overwrite newer data.
- Snapshot refreshes run every five minutes, including while the page is closed. Browser checks run every minute. Requests also refresh an overdue cache; browser requests return saved data while refreshing, while bot commands can await the refresh.
- Data is marked stale when the saved fetch is more than 15 minutes old or the observation is more than two hours old. Those are application freshness thresholds, not promises about NEA publication frequency.
- Telegram commands are `/start`, `/help`, `/psi`, and `/psi <region>`. Supported regions are north, south, east, west, central. Mentions addressed to another configured bot are ignored.
- The webhook requires `X-Telegram-Bot-Api-Secret-Token`. Successful duplicate updates are ignored; processing updates are retried; failed sends release the record for retry. Deduplication records are pruned after seven days.
- Telegram `sendMessage` has no idempotency key: an ambiguous network failure after Telegram accepts a message can still produce a duplicate on retry. This limit is documented rather than claiming guaranteed exactly-once delivery.

## NEA API contract

Spec retained from the owner's latest relevant Downloads file: `docs/PollutantStandardsIndexPSI.json`.

Dataset: https://data.gov.sg/datasets/d_fe37906a0182569d891506e815e819b7/view

Latest endpoint: `https://api-open.data.gov.sg/v2/real-time/api/psi`, without a date filter.

The actual response was fetched and matched the v2 shape: `code`, `data.items`, `timestamp`, `updatedTimestamp`, and `readings.psi_twenty_four_hourly`. Current live responses omit `psi_three_hourly`, despite that field appearing in the downloaded spec. Do not invent three-hour values or substitute PM2.5. Actual timestamps include `+08:00`; parse their offsets and format with Asia/Singapore.

No NEA API key is required for the current fetch schedule. A higher-rate-limit key can optionally be added as the Worker secret `NEA_API_KEY`.

## Verification completed

- **18 Node tests passed.** They cover PSI category boundaries, response validation, omitted optional fields, SGT, source/cache freshness, region filtering, group mentions, actual SQLite migration/query behavior, saved-data fallback, atomic refresh leases, prevention of snapshot/revision regression, webhook authentication, successful deduplication, interrupted update recovery, failed Telegram sends, routes/methods, and hiding unconfigured bot links.
- Wrangler **deployment dry run passed**.
- Local and production D1 **migration applied successfully**.
- Local Cloudflare workerd runtime fetched actual NEA readings for all five regions and stored them.
- Cloudflare **production deployment succeeded**, including the five-minute trigger.
- Headless Chrome tested the **deployed** app at **1440px desktop** and **390px mobile** widths: all five live region cards, SGT timestamps, no horizontal overflow, working pollutant details, and completed refresh actions. Screenshots were inspected. A small mobile copy-spacing issue found in the screenshot was corrected before the final publish.
- Actual Telegram bot creation, token installation, webhook registration, and end-to-end delivery are **not completed** because the owner has not yet created the bot.

## Next action: activate the Telegram bot

1. Have the owner open the verified https://t.me/BotFather account, send `/newbot`, choose **Hazey** as the display name, and choose an available username ending in `bot`, such as `hazey_psi_bot`. The suggested username has not been checked for availability. `hazey` alone is not a valid bot username.
2. Do not ask them to paste the token into chat. In a terminal opened in this repo, run:

   ```sh
   sh scripts/hazey.sh telegram https://hazey.gabrieltang515.workers.dev
   ```

3. The script's hidden prompt accepts the BotFather token. It calls `getMe`, generates a random webhook secret, installs both secrets with Wrangler, updates the bot username/public URL in config, redeploys, sets Telegram commands, registers the webhook, and checks `getWebhookInfo`.
4. Open the printed bot URL and verify `/start`, `/psi`, and `/psi west` in real Telegram. Confirm the region readings and timestamp match `/api/psi`; no values should be hardcoded.
5. Verify the Telegram panel appears on the web app, update this handover with the actual bot URL and delivery result, then commit and push changed config/docs. Never commit either secret.

The activation helper redeploys with current source. If the source has changed, run appropriate checks before running it. If the helper fails after installing secrets, repair and rerun it; do not claim activation succeeded based only on a deployed bot handler.

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
sh scripts/hazey.sh dev
sh scripts/hazey.sh deploy --dry-run
sh scripts/hazey.sh deploy
sh scripts/hazey.sh browser https://hazey.gabrieltang515.workers.dev
```

Wrangler is installed locally and pinned by `package-lock.json` (version 4.151.0 at handover). The dependency installation used a temporary npm CLI at `/private/tmp/hazey-npm-cli/package/bin/npm-cli.js`; that is a convenience for this session, not a permanent system installation. Fresh environments should install Node/npm and run `npm ci`.

Browser verification uses installed Chrome and Node's native DevTools/WebSocket support, with no browser test dependency. Set `CHROME_BIN` for non-macOS installations. Screenshots are saved in the system temporary directory, not the repository. The browser profile is temporary and removed after checks.

The local development DB created with the initial placeholder ID is disposable and separate from production. After the real database ID was written into config, apply `--local` migrations again before starting a fresh dev session. Production is already initialized; do not drop or recreate its database.

Git remote: `https://github.com/gabrieltang515/hazey.git`, branch `main`, visibility **private**. The saved GitHub credential was verified as `gabrieltang515`. Local commit identity uses Gabriel Tang's GitHub noreply address. Do not read credential-helper output into logs. Ignore `node_modules`, `.wrangler`, `.dev.vars`, and `.env`.

Before ending subsequent work, update this file with the deployed version, verification results, and remaining tasks, and push the source to the existing repository.
