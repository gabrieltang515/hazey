# Hazey handover

Updated: 15 October 2026, Singapore time. Telegram channel broadcasts are **live** in [@hazey_sg](https://t.me/hazey_sg). A PM2.5 24-hour overview and a nearest haze shelter finder are **live** since 18:46 SGT (version `19bbb6bc-fbcb-4813-af44-5ce157db6ba3`, from branch `shelters-and-pm25-overview`).

## PM2.5 overview and haze shelter finder — live since 15 October 2026, 18:46 SGT

The owner asked for the nearest haze shelters and an overview of 1-hour PM2.5 over the last 24 hours, reviewed the local build, and approved deployment. It was built on branch `shelters-and-pm25-overview` (based on `activate-channel-broadcasts`); both branches were fast-forwarded into `main` on 15 October 2026, so `main` matches the deployed version `19bbb6bc`.

- **PM2.5 overview** (`#overview`, `renderOverview` in `public/app.js`): an HTML table, five regions by 25 hourly columns, from the existing `/api/history` PM2.5 series (no new data source). Cells use NEA's PM2.5 band tones at stepped tints (`--heat-1`…`--heat-4` in `styles.css`; OKLab lightness gaps ≥ 0.07 between bands, ink ≥ 4.6:1 on every step in both themes) with the value printed in each cell on wide screens. Hover, tap or arrow keys show a readout; a summary line gives the peak and how many hours reached High or above. The table is the accessible twin.
- **Shelter finder** (`#shelters`): the five nearest of 341 community haze shelters from the People's Association list (as at September 2026), by device location or postal code, with straight-line distance and a Google Maps directions link. Location is used only in the browser (`public/geo.js`); `Permissions-Policy` now allows `geolocation=(self)`. Postal codes go through the new `GET /api/postal?code=NNNNNN` (`src/postal.js`), which calls OneMap's free search API and never stores or logs the code (400 bad input, 404 unknown, 502 OneMap failure). The CSP is unchanged.
- **Shelter status**: the section states NEA's rule (shelters open when the 24-hour PSI is above 200; CC shelters open until 10 pm when Hazardous) against the current highest regional PSI. Above 200, a "Find a haze shelter near you" link appears in the hero.
- **Data**: `docs/haze-shelters-2026-09.csv` is the PDF transcribed with pdfplumber (five-digit postal codes restored to six digits). `scripts/build-shelters.js` geocodes it via OneMap and writes `public/shelters.js` (46 KB, 11 KB gzipped); it applies three documented corrections where the PDF's address and postal code disagree (Bukit Batok Zone 1 RN, Fernvale Zone K RN, Fernvale Zone H RN) and fails if any entry is unresolved or far from its district. Fernvale Zone K's address and postal code are 0.5 km apart; the street address was trusted. A full run takes about 8 minutes because of OneMap's rate limit.
- **Verification (local)**: 46/46 Node tests (6 new: shelter data integrity against the CSV, distance maths and formatting, postal endpoint success/validation/404/outage/no-logging, headers), Wrangler dry run, and the browser check against local `wrangler dev` with 25 hours of backfilled history at 1440px and 390px, light and dark. The browser check now also asserts the 5×25 overview and its keyboard readout, the emulated-location search (first result Ang Mo Kio-Hougang Pinetree RN, under 100 m), the postal search (089774 → Tanjong Pagar CC) and the invalid-input message; it now emulates a light system theme so the theme-toggle check passes on a Mac in dark mode. A Hazardous reading (West 305, local DB only) was checked visually for the hero link and shelter status. Screenshots were inspected; band tints were strengthened after the first review.
- **Deployment (18:46 SGT)**: `npm test` 46/46, then `npx wrangler deploy` produced version **`19bbb6bc-fbcb-4813-af44-5ce157db6ba3`** (no migration; existing secrets, vars, D1 and the `*/5 * * * *` trigger unchanged). Production checks afterwards: `/api/postal` returned OneMap coordinates for 089774 and 530572 from Cloudflare, 404 for 999999 and 400 for 12345; `Permissions-Policy` serves `geolocation=(self)` and the CSP is unchanged; `/`, `/api/psi`, `/api/history`, `/shelters.js`, `/geo.js` and `/app.js` return 200; unauthenticated `POST /telegram/webhook` returns 401. The browser check passed against production at 1440px and 390px (overview 5×25, location and postal shelter searches, bad input, dark theme, no overflow) and the production screenshot was inspected. `wrangler tail` showed the 18:50 scheduled run `ok` with no errors.
- **Watch**: OneMap rate-limits by IP (HTTP 429 was seen locally while the generator ran). Cloudflare egress worked at deployment; if lookups start failing, `wrangler tail` shows `Postal code lookup failed: OneMap search failed (429)` and the page asks visitors to use their location instead.

## Channel broadcasts — live since 15 October 2026

The owner created the public channel [@hazey_sg](https://t.me/hazey_sg) and confirmed that `@hazey_sg_bot` is an administrator with Post Messages enabled. The channel code was written on 14 October in a checkout without Cloudflare access, then activated by the owner on 15 October (see the activation record below).

- `TELEGRAM_CHANNEL_ID` is `@hazey_sg` in `wrangler.jsonc` vars. The existing command bot and dashboard are preserved.
- Regular slots: 02:00, 06:00, 10:00, 14:00, 18:00 and 22:00 SGT. Upper end of NEA's overall 24-hour PSI range >200 sends immediately when detected by the five-minute cron, then on clock hours. An existing episode holds at exactly 200 and clears strictly below 200, silently. No recovery post; only one post for overlapping slots.
- Overall PSI is the minimum–maximum range of NEA's five regional readings. Broadcasts include all five regions' PSI and separate 1-hour PM2.5 readings/timestamps, the website, and PSI-based precautions paraphrased from the MOH advisory on NEA's Managing Haze page (checked 14 October 2026).
- `migrations/0004_channel_broadcasts.sql` persists observed alert mode independently of delivery, a pending first alert, successful reporting slots, the processed observation/revision and an atomic channel lease. Failed delivery can retry; recovery cancels pending alerts. Older observations cannot move the mode backwards. Telegram still cannot guarantee exactly-once delivery after ambiguous network failure.
- Scheduled reports wait for the current hour's observation. Stale or future PSI, or a failed refresh, never sends or clears the episode. Missing PM2.5 is labelled; delayed saved PM2.5 remains labelled and does not block PSI.
- Future PSI and PM2.5 observations are rejected before cache writes, so they cannot block subsequent valid readings. A stale source response cannot trigger a post from a retained fresh cache.
- Pre-activation verification (14 October): 40 Node tests (26 existing + 14 channel/regression tests using real SQLite), Wrangler dry run, and a clean dependency audit. An independent review found three delivery/freshness/ordering issues; all were fixed with regression tests and re-verified.

### Activation record — 15 October 2026

Performed by the owner's agent on the Mac checkout, from `main` at `658a04f`:

- `npm ci` (0 vulnerabilities), `npm test` **40/40 pass**, `wrangler deploy --dry-run` passed, and local migrations 0001–0004 applied cleanly.
- `npx wrangler login` with the owner's account (`ce0cad81…`). The remote migration list showed only `0004_channel_broadcasts.sql` pending; it was applied to production `hazey-psi` at 07:08 SGT, **before** deploying.
- `npx wrangler deploy` at 07:09 SGT produced version **`374e97dd-c9a6-4bd3-86ea-8013dde66e78`** (100% of traffic, `*/5 * * * *` trigger). Existing secrets `NEA_API_KEY`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` were reused; the bot setup helper was not rerun and no secret was rotated.
- The 7 am reading had West at PSI 206, so the first cron after deploy (07:10, `Ok`) logged `Channel broadcast sent (breach)` and posted [t.me/hazey_sg/2](https://t.me/hazey_sg/2) at 07:10:48 SGT: "⚠️ Hazey • PSI alert", overall 124–206 (Unhealthy to Very unhealthy), all five regions' PSI and PM2.5 for 7:00 am SGT, the PSI 201–300 precautions, the MOH/NEA link, and the dashboard button. The public post was read back from `t.me/s/hazey_sg` and matches the format above.
- Production `channel_broadcasts` afterwards: `alert_active=1`, `pending_breach=0`, `last_slot` 07:00 SGT, lease released. The 07:15 cron (logged as two scheduled invocations, 07:15:40 and 07:15:55, both `Ok`) posted nothing further: the channel still had exactly one alert and one `Channel broadcast sent` log line.
- Post-deploy smoke: `/`, `/api/psi`, `/api/history` and assets return 200; an unauthenticated `POST /telegram/webhook` returns 401; a Telegram webhook update at 07:09 SGT was answered `Ok`.

What to expect next: while the episode is active, one hourly update posts per clock hour once NEA publishes that hour's reading (`Channel broadcast sent (hourly)`). When the highest regional PSI falls strictly below 200 the episode ends silently and the four-hourly regular slots resume (`… (regular)`).

To disable broadcasts, remove `TELEGRAM_CHANNEL_ID` from `wrangler.jsonc` vars and redeploy; the additive D1 table can remain. Telegram errors and upstream failures are logged without tokens, and failed sends retry on later checks. Never recreate the existing D1 database or rotate secrets unnecessarily, and do not rerun the bot setup helper just to touch the channel (it rotates the webhook secret).

The completion statements below were written for the dashboard/command-bot release; the status list, resources table and commands have been updated for the channel release.

## Requested outcome and current status

The owner, GitHub account `gabrieltang515`, requested a web app and Telegram bot showing the latest regional Singapore PSI from NEA/data.gov.sg, using Cloudflare Free storage, plus a private GitHub repository with this handover. On 14 October 2026 they also asked for PM2.5 levels and then a sleeker frontend (buildless, shadcn-style, with 24-hour trend charts, dark mode, a region map, and live relative times), which they approved from screenshots before it was deployed.

- **Web app: redesigned, deployed and working** at https://hazey.gabrieltang515.workers.dev, with 24-hour PSI **and** NEA 1-hour PM2.5 for all five regions, a banded region map, 24-hour trends, and light/dark themes.
- **Storage: provisioned and initialized** in Cloudflare D1. Migrations `0001_init.sql`, `0002_pm25.sql`, `0003_history.sql`, and `0004_channel_broadcasts.sql` are applied to production and local.
- **NEA API key: installed** by the owner as the Worker secret `NEA_API_KEY` at ~18:15 SGT. Before it, the 18:00 scheduled refresh got HTTP `429`; afterwards every observed five-minute refresh (18:20, 18:35, 18:40, 18:45, 18:50) saved on schedule.
- **Telegram bot: activated as [@hazey_sg_bot](https://t.me/hazey_sg_bot).** The owner created it in BotFather and ran the hidden-prompt setup helper, which installed `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, registered the webhook, set the command menu, and redeployed. Production logs show four real Telegram updates at 17:59–18:00 SGT, each answered `200`; the Worker returns `200` only after Telegram's `sendMessage` succeeds. The owner then confirmed the replies looked right.
- **Telegram channel: live as [@hazey_sg](https://t.me/hazey_sg)** since 15 October 2026, 07:10 SGT. The first post was an automatic breach alert ([t.me/hazey_sg/2](https://t.me/hazey_sg/2)); see the activation record above.
- **GitHub: private repository** at https://github.com/gabrieltang515/hazey, branch `main`. Reuse it; do not run the repository-creation helper again.

## Remaining steps

1. **Refresh the shelter list** when the People's Association publishes a new one: transcribe it to a new CSV in `docs/`, update `SOURCE_CSV`, `LIST_AS_AT` and `LIST_URL` in `scripts/build-shelters.js`, rerun it, review its warnings, and update the footer link in `public/index.html`.

Optional:

1. **Spot-check the first regular slot.** After this haze episode ends (highest regional PSI strictly below 200), confirm the next 02/06/10/14/18/22 SGT post and its `Channel broadcast sent (regular)` log line. Only the breach path has been observed in production so far.
2. **Show `/pm25` in the bot's command menu.** `/pm25` works, but Telegram's menu was set before it existed. Rerunning `sh scripts/hazey.sh telegram https://hazey.gabrieltang515.workers.dev` with the BotFather token refreshes the menu. It also rotates the webhook secret and redeploys current source, so run `sh scripts/hazey.sh test` first, and restore `wrangler.jsonc` formatting afterwards.
3. **Map data refresh.** `public/map-data.js` uses URA Master Plan 2019; a 2025 edition exists (`d_4ce0038f7ac689652350bb91b7fb92ed`) with more Changi East land. Regenerate rather than hand-edit if the coastline should change.

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
| Telegram channel | `@hazey_sg` (`TELEGRAM_CHANNEL_ID` in `wrangler.jsonc` vars; the bot is a channel admin with Post Messages) |
| D1 migrations applied (production) | `0001`–`0004` |
| Current deployment version | `19bbb6bc-fbcb-4813-af44-5ce157db6ba3` (PM2.5 overview and shelter finder, 15 Oct 2026 18:46 SGT); previous `374e97dd-c9a6-4bd3-86ea-8013dde66e78` (channel release) |
| Worker secrets | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `NEA_API_KEY` |

Cloudflare sign-in was completed successfully through Wrangler OAuth. On 15 October the Mac's Wrangler login had expired and was renewed with `npx wrangler login`; approve the browser page while that command is still waiting, because it times out after about two minutes (approving the Cloudflare dashboard alone does not log Wrangler in). The account originally had no Workers or D1 databases. The global `hazey.workers.dev` name was unavailable, so `gabrieltang515.workers.dev` was registered for this account. No paid plan or paid service was enabled. Keep the existing resources and Free requirement.

The public account/database IDs in source are resource identifiers, not credentials. Credentials remain in Wrangler's local config and Git's configured credential helper; do not print or copy them into the repo.

## Architecture and important behavior

- `src/worker.js` serves the same-origin `/api/psi` (PSI plus a nested `pm25` object or `null`), `/api/postal?code=` (OneMap postal code to `{ postal, lat, lng }` for the shelter finder, via `src/postal.js`), `/api/history` (`{ psi: [...], pm25: [...] }`, each item `{ at, north, south, east, west, central }`, ascending, last 25 hours), the authenticated `POST /telegram/webhook`, static assets, and the scheduled refresh.
- `src/psi.js` validates and normalizes both NEA responses. PSI requires valid 24-hour PSI values for all five regions and tolerates missing optional 24-hour pollutant fields. PM2.5 requires a non-negative `pm25_one_hourly` concentration for all five regions. Both choose the most recent observation.
- `public/psi.js` shares PSI category boundaries, NEA 1-hour PM2.5 bands (I Normal 0–55, II Elevated 56–150, III High 151–250, IV Very high ≥251), and SGT formatting between the browser and bot.
- `public/index.html`, `public/styles.css`, and `public/app.js` implement the buildless dashboard (no framework; shadcn-style design language by hand):
  - Hero: headline, plain-language verdict (e.g. "Unhealthy across Singapore"), a PSI / 1-hour PM2.5 radio switch (saved in `localStorage`), and an SVG map built from `public/map-data.js`. Regions are tinted by the selected metric's band, labelled with values, keyboard-focusable, and jump to their card. The legend under the map lists the selected metric's bands with ranges.
  - Region cards: the selected metric as the big number with its band badge, "Up/Down N in 24 hours", a 24-hour trend line on a scale shared by all five regions (pointer and arrow-key readouts), the other metric with its badge, and 24-hour PM2.5/PM10 averages. A table view lists the same hourly data. Phones use a compact card with the trend beside the number.
  - Masthead: live status pill ("6:00 pm reading, checked N min ago"; "New" cue when NEA publishes; delayed/offline states) and a light/dark toggle. `public/theme.js` applies a saved theme before first paint; otherwise the system setting applies.
  - Tokens are defined once for light and redefined for dark; text and band colours were contrast-checked (text ≥ 5:1, band marks ≥ 5:1 on cards in both themes). One orchestrated motion moment (map regions tint in on first load); `prefers-reduced-motion` disables motion.
  - Fonts: Newsreader (display, optical-size axis) and Public Sans (UI and data), latin subsets, self-hosted with OFL licence files in `public/fonts`, cached for a year.
  - The Telegram panel stays hidden until a bot username and both Worker secrets are configured.
- `public/map-data.js` is generated data: URA Master Plan 2019 land dissolved to one outline (main island, Jurong Island, Sentosa, Ubin, Tekong; causeways removed; simplified), equirectangular projection documented in its header, and Voronoi cells around NEA's `regionMetadata` label points. The Singapore Open Data Licence attribution is in the file header and the page footer.
- `migrations/0001_init.sql` creates a singleton PSI snapshot, a refresh lease, and Telegram update records. `migrations/0002_pm25.sql` adds a separate singleton PM2.5 snapshot. Refresh leases are atomic. Older observations and older revisions of the same observation cannot overwrite newer data in either table.
- `src/broadcast.js` posts to the Telegram channel from the scheduled refresh only (`refreshPsi(env, { broadcast: true })`); it decides breach/hourly/regular posts under a D1 lease in `channel_broadcasts` (`migrations/0004_channel_broadcasts.sql`). Requests and bot commands never broadcast.
- `migrations/0003_history.sql` adds `reading_history (dataset, reading_at, source_updated_at, readings)`. Each successful snapshot save also upserts that hour (newer revisions only). The scheduled job backfills today and yesterday (Singapore dates) from `?date=` responses at minute 10 each hour, or every 15 minutes while fewer than 40 rows cover the window, skipping incomplete hours; rows older than ~50 hours are pruned.
- One refresh fetches PSI and PM2.5 in parallel. Each saves independently: a PM2.5 failure is logged and never blocks or discards a PSI update, and saved PM2.5 survives later PM2.5 failures. The overdue-cache check uses the PSI snapshot age.
- Snapshot refreshes run every five minutes, including while the page is closed. Browser checks run every minute. Requests also refresh an overdue cache; browser requests return saved data while refreshing, while bot commands can await the refresh.
- Data is marked stale when the saved fetch is more than 15 minutes old or the observation is more than two hours old. Those are application freshness thresholds, not promises about NEA publication frequency.
- Telegram commands are `/start`, `/help`, `/psi` and `/psi <region>` (24-hour PSI only), and `/pm25` and `/pm25 <region>` (1-hour PM2.5 only). The owner asked that `/psi` not include PM2.5, and that `/help` list the region form of `/pm25` on its own line. Supported regions are north, south, east, west, central. Command names may contain digits. Mentions addressed to another configured bot are ignored.
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

Redesign release (19:30–19:50 SGT, 14 October 2026):

- **26 Node tests pass**, adding history append and `/api/history` shape, backfill of today/yesterday with skipped incomplete hours and window filtering, newer-revision protection, scheduled hourly backfill and pruning, and `historyPoints` parsing.
- Local `wrangler dev` with a dispatched scheduled run backfilled 25 real hourly points per dataset from NEA.
- The browser check (now asserting the banded map, PSI/PM2.5 switch, five trend charts with table rows, and the dark theme) passed locally at desktop and mobile widths; light, dark, PSI, and PM2.5 screenshots were inspected and revised (logo spacing, label wrapping, chart clutter, map transition timing, compact phone cards) before the owner approved them.
- `0003_history.sql` applied to production before deploying version `5372661b-ac41-4f53-915f-724d2dec1b38`. Production serves every asset, fonts with year-long caching, other assets with `max-age=0, must-revalidate` plus ETags, and the existing CSP unchanged (all scripts, styles, and fonts are same-origin).
- Production `/api/history` was empty after deploy (19:35) and the 19:45 scheduled run backfilled 25 hourly points per dataset (7 pm 13 Oct to 7 pm 14 Oct SGT). The browser check then passed against production at desktop and mobile widths (five trend charts, 25 table rows, map, switch, dark theme, Telegram panel); the production screenshot was inspected.

Channel release (07:00–07:20 SGT, 15 October 2026):

- 40/40 Node tests, dry run, `0004_channel_broadcasts.sql` applied to production before deploying version `374e97dd-c9a6-4bd3-86ea-8013dde66e78`, a real breach alert in `@hazey_sg` with the matching `Channel broadcast sent (breach)` log line, persisted D1 episode state, and no duplicate on the next cron. Details are in the activation record at the top.

## Development and deployment commands

On a usual Node/npm installation:

```sh
npm ci
npm test
npm run db:local
npm run dev
npm run deploy
```

On the current Mac, Node 22.15 and npm are now on PATH (installed through Herd's nvm), so the `npm`/`npx` commands above work directly; they were used for the 15 October channel release. If `node` is ever missing, Cursor supplies Node at:

`/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node`

The checked-in wrapper uses `node` from PATH and falls back to Cursor's automatically:

```sh
sh scripts/hazey.sh test
sh scripts/hazey.sh d1 migrations apply PSI_DB --local
sh scripts/hazey.sh d1 migrations apply PSI_DB --remote   # apply before deploying code that needs a new table
sh scripts/hazey.sh dev                      # add --test-scheduled to trigger the cron locally
sh scripts/hazey.sh deploy --dry-run
sh scripts/hazey.sh deploy
sh scripts/hazey.sh browser https://hazey.gabrieltang515.workers.dev
```

Wrangler is installed locally and pinned by `package-lock.json` (version 4.151.0 at handover). The dependency installation used a temporary npm CLI at `/private/tmp/hazey-npm-cli/package/bin/npm-cli.js`; that is a convenience for this session, not a permanent system installation. Fresh environments should install Node/npm and run `npm ci`.

Browser verification uses installed Chrome and Node's native DevTools/WebSocket support, with no browser test dependency. Set `CHROME_BIN` for non-macOS installations. Screenshots are saved in the system temporary directory, not the repository. The browser profile is temporary and removed after checks.

The local development DB is disposable and separate from production. Production has migrations 0001–0004 applied; do not drop or recreate its database. Apply any new migration to production **before** deploying code that queries it.

To run the scheduled handler locally at a chosen time (for example minute 10, which backfills history), start dev with `--test-scheduled` and POST `{"cron":"*/5 * * * *","scheduled_time":<epoch ms>}` to `/cdn-cgi/local/explorer/api/local/scheduled?worker=hazey`. The `/__scheduled?time=` query is ignored by this Wrangler version.

The Telegram setup helper rewrites `wrangler.jsonc` with `JSON.stringify` formatting; after rerunning it, restore the original formatting so the diff shows only intended changes.

Claude Code: Anthropic's `frontend-design` plugin is enabled at project scope in `.claude/settings.json` (installed with `claude plugin install frontend-design@claude-plugins-official --scope project`). The redesign followed it and the data-visualisation rules (shared scales, neutral trend lines, status colours paired with labels, table view, contrast checks).

Git remote: `https://github.com/gabrieltang515/hazey.git`, branch `main`, visibility **private**. The saved GitHub credential was verified as `gabrieltang515`. Local commit identity uses Gabriel Tang's GitHub noreply address. Do not read credential-helper output into logs. Ignore `node_modules`, `.wrangler`, `.dev.vars`, and `.env`.

Before ending subsequent work, update this file with the deployed version, verification results, and remaining tasks, and push the source to the existing repository.
