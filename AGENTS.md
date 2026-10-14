# Working on Hazey

Read `HANDOVER.md` first. The project is deployed to Cloudflare and has its own private GitHub repository. The neighboring `mobile-app` and `telegram-poc` folders are unrelated.

- Preserve the user's Cloudflare Free requirement. Use the existing Worker and D1 binding in `wrangler.jsonc`; do not create duplicate resources or enable paid services.
- Use the downloaded NEA OpenAPI spec in `docs/PollutantStandardsIndexPSI.json`. Main PSI is `readings.psi_twenty_four_hourly`, an index for all five regions. Optional pollutant concentrations are not PSI. The live response can omit `psi_three_hourly`.
- Keep display times in Asia/Singapore. Show a clear stale-data state and preserve saved readings during upstream failures.
- Keep tokens out of source, commits, chat, and logs. Use Wrangler secrets and the hidden Telegram setup prompt. `.dev.vars`, `.env`, and `.wrangler` are ignored.
- Telegram bot creation through BotFather requires the owner's Telegram account. Do not claim the bot is live until a real token, webhook, and `/psi` reply have been verified.
- Source uses plain ESM and buildless HTML/CSS/JS. `npm test` runs meaningful API, SQL, and webhook checks. Use the browser smoke check for UI changes. Avoid adding framework dependencies without a concrete need.
- On this Mac, `sh scripts/hazey.sh test`, `sh scripts/hazey.sh deploy`, and `sh scripts/hazey.sh telegram <url>` work with Cursor's Node even when `node`/`npm` are absent from PATH.
- Before ending a work session, update `HANDOVER.md` with the actual deployed state, verification, and remaining steps. Keep the repository pushed and report any deployment or activation blockers accurately.
