# Free N95 mask finder — design

Date: 17 October 2026 (Singapore time). Approved by the owner in chat on 17 October 2026.

## Goal

Link Singapore's free N95 mask distribution sites from Hazey. While the government is distributing masks, visitors, bot users and channel subscribers can find the nearest collection points that still have stock.

## Source data

The government's locator is HazeMaskGoWhere (https://www.gowhere.gov.sg/hazemask, short link `go.gov.sg/hazemask`), which NEA's 14 October 2026 haze update names as the place for collection points and live vending-machine availability. Its page loads two public JSON files from the same site:

| File | Contents (16 Oct 2026) | Updated |
| --- | --- | --- |
| `https://www.gowhere.gov.sg/hazemask/data/data.csv.json` | 113 CC counters, `Monday to Sunday, 10am to 6pm` (12 open 2pm to 6pm) | `Last-Modified` 21:36 SGT 16 Oct |
| `https://www.gowhere.gov.sg/hazemask/data/data.webhook.json` | 37 vending machines at bus interchanges, MRT stations, SSOs and PA venues, mostly 24 hours | `Last-Modified` 22:52 SGT 16 Oct (live stock) |

Both have the shape `{ lastUpdated: "16 Oct 2026", data: [...] }`. Each entry has `name`, `address`, `postalCode`, `contactNumber`, `description` (where to find a machine, e.g. "Near Boarding Berth B6", often `null`), `operatingHoursFreeText`, `LAT`, `LON`, and `filters`, a list of `{ category, options: [{ name, flag }] }`. Hazey uses three categories:

- `collectionOption`: `ccCounter` or `vendingMachine`
- `stock`: `stocksAvailable`, `limitedStocksAvailable`, `outOfStock` (or none flagged)
- `machine`: `available`, `notAvailable` (vending machines only)

The official app concatenates these two files. A third file, `data.json`, is a 2025 fallback that the official app reads only when both are missing. Hazey ignores it.

These files are not a published open dataset. They are what the official page loads. They send no CORS headers, so the browser cannot read them and the Worker must relay them. The format may change without notice, so every failure falls back to a plain link to HazeMaskGoWhere. The site's terms of use render only in a browser and were not reviewed; the owner will check them. Hazey credits and links the source wherever the data appears.

## Data path: scheduled relay into D1

- **Module:** `src/masks.js` owns fetching, validation, normalization, storage and the shared reply/notice text helpers.
- **Fetching:** the existing `*/5 * * * *` scheduled job fetches both files in parallel with an 8-second timeout. This runs alongside the PSI refresh and is independent of it: a mask failure is logged (`Mask site refresh failed (cc|vending): …`) and never blocks or delays PSI, and a PSI failure never blocks masks. The two files are also independent of each other.
- **Storage:** migration `0005_mask_sites.sql` adds `mask_sources (source TEXT PRIMARY KEY CHECK (source IN ('cc', 'vending')), payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, source_modified_at INTEGER NOT NULL)`. Each successful fetch upserts its row. A response whose `Last-Modified` is older than the saved one does not replace it (the same rule as PSI snapshots). A failed fetch leaves the saved row alone.
- **Validation:** a response must be JSON with a `data` array. Each entry needs a non-empty `name` and `address`, and `LAT`/`LON` inside Singapore's bounding box (the same box as `src/postal.js`). Invalid entries are dropped, and the number dropped is logged. An empty `data` array is valid and means no sites are listed. A response that isn't JSON or has no `data` array is a failed fetch.
- **Normalized site:** `{ name, kind: "cc" | "vending", address, postal, lat, lng, hours, spot, stock }`.
  - `kind` comes from `collectionOption`, falling back to the source file.
  - `spot` is `description` or `null`.
  - `hours` is `operatingHoursFreeText` with whitespace collapsed.
  - `stock` is `"in"`, `"limited"`, `"out"`, `"offline"` (vending machine `notAvailable`) or `"unknown"`. `offline` takes precedence over the stock flags.
  - Contact numbers are not kept.
- **Stock time:** the response's `Last-Modified` header. If it is missing or can't be parsed, the fetch time is used instead.

### `GET /api/masks`

Responds `{ sites: [...], sources: { cc: { fetchedAt, updatedAt, stale } | null, vending: { … } | null }, active }`, with `Cache-Control: no-store` like the other API routes.

- **Stale:** a source is stale when it was last fetched more than 30 minutes ago.
- **Active:** `active` is true when at least one non-stale source has a site with `stock` of `in` or `limited`. It means "distribution is running" and drives the hero link and the channel block.
- **Payload size:** about 150 sites, roughly 35 KB raw and under 10 KB gzipped.
- **No saved data:** if no source has ever been saved, the response is `{ sites: [], sources: { cc: null, vending: null }, active: false }` with status 200.

When the government ends distribution, the files will likely be emptied or removed. Either way, `active` turns false within 30 minutes and the hero link and channel block disappear on their own.

## Dashboard

### New section: "Free N95 masks near you" (`#masks`, after `#shelters`)

- **Meta line:** "`N` community club counters and `M` vending machines, from HazeMaskGoWhere". Below it: "Stock updated `h:mm am/pm`" (from the vending source, which carries the live stock, or the CC source if vending has never been saved), formatted in Asia/Singapore.
- **Finder:** the same "Use my location" button and postal-code form as the shelter finder. The shelter finder code is generalized so both sections share one implementation. One search updates both lists: searching in either section fills the shelter list and the mask list. Location stays in the browser; postal codes still go through `/api/postal`.
- **Results:** the five nearest sites whose stock is `in`, `limited` or `unknown`. Each item shows:
  - name
  - type: "CC counter" or "Vending machine"
  - stock badge: "In stock", "Limited stock" or "Stock unknown", with a text label and not only colour
  - address and postal code
  - spot description, if any
  - hours, as listed
  - straight-line distance
  - a Google Maps Directions link

  A note under the list says "Out-of-stock points and vending machines that are out of service are left out." If every site is out, the list is empty and the message says so, with a link to HazeMaskGoWhere.
- **Eligibility:** a short summary as announced by NEA on 14 October 2026:
  - At a CC counter or a vending machine: Pioneer and Merdeka Generation; CHAS Blue and Orange cardholders; Medical Fee Exemption Card holders; ComCare recipients.
  - At CC counters only: pregnant women; children aged 7 to 16; people with medical conditions such as asthma.
  - Bring the eligible person's NRIC. Someone else can collect on their behalf. Each pack has two masks.

  It ends with a link to the official FAQ (`https://www.gowhere.gov.sg/hazemask/faq`).
- **Source line:** "Check live stock on HazeMaskGoWhere ↗".
- **States:**
  - Loading.
  - No saved data: "Couldn't load the mask list" plus the HazeMaskGoWhere link.
  - Stale: "Stock may be out of date (last checked `time`)". The saved list is still shown.
  - Empty list from the source: "No collection points are listed right now."
- **Footer:** a credit, "Mask collection points and stock from HazeMaskGoWhere, Government of Singapore."

### Hero link

"Find free N95 masks near you" (`#mask-jump`, linking to `#masks`) appears next to the existing shelter link while `active` is true.

### Loading

The page fetches `/api/masks` on load and again every 5 minutes, independently of `/api/psi`. A mask failure never affects the PSI view.

## Telegram bot: `/masks`

- **Commands:** `/masks <postal code>`, which works in private and group chats, and `/mask` as an unlisted alias.
- **Plain `/masks`:** in a private chat, it replies with the one-time "📍 Share my location" keyboard. In a group, it gives the postal-code hint, as `/shelter` does.
- **Which list a shared location gets:** a location message doesn't say which command prompted it. When plain `/masks` shows the keyboard in a private chat, the Worker records that chat in `bot_location_requests (chat_id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('masks')), expires_at INTEGER NOT NULL)` for 10 minutes. This table is in migration `0005`.
  - A location shared in that chat before expiry is answered with mask sites, and the row is deleted.
  - Without a live row, a shared location gets shelters, as today.
  - Plain `/shelter` deletes any pending row for the chat, so the latest request wins.
  - Expired rows are pruned by the scheduled job.
  - Only the chat ID and the request type are kept, never the location.
- **Reply:** "Nearest free N95 mask points to `label`", then the three nearest sites that are not out of stock or out of service (the dashboard filter). Each site shows its name, distance, type, stock, address with spot, and hours. After the list come:
  - one line on eligibility: "PG/MG, CHAS Blue/Orange, MFEC and ComCare: CC or vending machine. Pregnant women, children 7–16 and people with conditions such as asthma: CC only. Bring the eligible person's NRIC."
  - "Stock from HazeMaskGoWhere, updated `time`"
  - a stale warning when needed
  - "Live stock: go.gov.sg/hazemask"

  Inline buttons: Directions for each site, then "Open the mask finder ↗" (`<dashboard>/#masks`).
- **No usable data:** the reply links to HazeMaskGoWhere instead. Postal lookup failures behave as they do for `/shelter`.
- **Menu and help:** `BOT_COMMANDS` gains `masks` ("Nearest free N95 mask points; share your location or add a postal code"), and `HELP` gains matching lines. The hourly `setMyCommands` sync pushes the menu, so the setup helper does not need to be rerun.

## Telegram channel

When `active` is true, `channelMessage` adds this block:

> Free N95 masks:
> Eligible groups can collect free N95 masks at `a` CC counters and `b` vending machines with stock now.
> Find one: `<dashboard>/#masks` or send /masks to @hazey_sg_bot. Official list: go.gov.sg/hazemask

Here `a` and `b` count non-stale sites with stock `in` or `limited`. The post also gets a "Find free N95 masks" button. The block is independent of PSI level and doesn't affect post timing or episode logic. When `active` is false, posts are unchanged.

## Error handling summary

- **Upstream failure:** the last good copy is kept, the source is marked stale after 30 minutes, the dashboard and bot say so, and the hero and channel stop promoting masks.
- **Format change:** if no entry validates, the result is an empty but valid list, logged as `0 valid of N`. If the top-level shape breaks, the fetch fails and the saved copy is kept.
- **Logs:** no tokens, locations or postal codes are ever logged.

## Testing

- **Node tests (`tests/masks.test.js`, plus additions to `worker.test.js`):**
  - **Normalization:** stock mapping including `offline` precedence, the kind fallback, dropping entries with bad coordinates or a missing name, and whitespace in hours.
  - **Refresh:** saving each source independently; an older `Last-Modified` not replacing a newer one; a mask failure leaving PSI untouched and the saved copy intact; a PSI failure not blocking masks.
  - **`/api/masks`:** response shape, `stale` at 30 minutes, `active` rules, and the no-data response.
  - **`/masks`:** by postal code (three nearest with stock, buttons, eligibility line); a group hint; plain `/masks` creating a pending row; a location answered with masks and the row deleted; an expired row falling back to shelters; `/shelter` clearing the row; no data; OneMap failure. Nothing is logged that contains codes or coordinates.
  - **Channel:** the block and button only when `active`, with counts, at any PSI level.
  - **Bot menu:** `BOT_COMMANDS` includes `masks`.
- **Browser check (`scripts/check-browser.js`):** the `#masks` section loads; the emulated location fills both the shelter and mask lists; a postal search fills both; stock badges and the eligibility box render; no overflow at 1440px and 390px; dark theme.
- **Before deploying:** a Wrangler dry run.

## Deployment

Apply `0005_mask_sites.sql` to production D1 before deploying the code. Deploy with the existing Worker, D1 binding and trigger; there are no new secrets, no paid services and no CSP change, because the browser only calls same-origin `/api/masks`. After deploying, confirm the first scheduled run saved both sources, then confirm `/api/masks` and the browser check against production. A real `/masks` reply needs the owner's Telegram account to confirm.

## Out of scope

- An "open now" state parsed from the free-text hours.
- A filter between CC counters and vending machines.
- Showing contact numbers.
- Any use of the 2025 `data.json` fallback.

## Revision, 17 October 2026: saved list instead of live stock

After deploying version `9aa6fd22`, every production refresh got HTTP 403. HazeMaskGoWhere's CloudFront answers requests from Cloudflare's network with a "forbidden" page whatever the headers; the same requests succeed from an ordinary connection. This is a deliberate block on GovTech's side, and Hazey will not route around it. The owner chose this replacement design:

- **Data:** `scripts/build-mask-sites.js`, run from an ordinary connection, fetches both files, normalizes them with `scripts/mask-data.js` (moved from `src/`, now without stock) and writes `public/mask-sites.js`: `MASK_SITES` (`{ name, kind, address, postal, lat, lng, hours, spot }`) and `MASK_SITES_AS_AT` (ISO time of generation). No stock is stored. Rerun it when HazeMaskGoWhere changes its sites, then redeploy.
- **Removed:** the five-minute HazeMaskGoWhere fetch, `GET /api/masks`, stock badges and all staleness logic. Migration `0006_drop_mask_sources.sql` drops the unused `mask_sources` table; it is applied after the code that stops using it is deployed. `bot_location_requests` stays.
- **On/off switch:** `MASK_DISTRIBUTION: "on"` in `wrangler.jsonc` vars. Any other value or no value means off. To end it, remove it and redeploy. `/api/psi` reports it as `masksActive`.
  - **On:** the dashboard shows `#masks` and the hero link; `/masks` answers from the saved list; channel posts carry the mask block and button.
  - **Off:** `#masks` and the hero link are hidden; `/masks` (and a location shared after it) says distribution isn't running and links HazeMaskGoWhere; channel posts are unchanged.
- **Wording:** lists say where they come from and when: "Locations from HazeMaskGoWhere as at `date, time` SGT". Stock is replaced with a prompt to check live stock on HazeMaskGoWhere before going. The channel line drops "with stock now" and ends "Live stock: go.gov.sg/hazemask".
- **Unchanged:** the shared search, the eligibility box, `/mask`, the 10-minute pending location request, directions, and the HazeMaskGoWhere credit.
