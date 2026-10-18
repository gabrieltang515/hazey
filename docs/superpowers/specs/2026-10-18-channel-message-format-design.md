# Channel message format — design

Date: 18 October 2026 (Singapore time). Approved by the owner in chat on 18 October 2026, with change-since-last-hour arrows included and notification behaviour left as it is.

## Goal

Make `@hazey_sg` posts readable at a glance. The first line, which Telegram shows in notifications and the chat list, should say how bad the air is. The post should be shorter, use bold and colour to pick out the numbers, and stop repeating links that the buttons already carry.

## Scope

- **Changes:** `channelMessage` and the `sendMessage` payload in `src/broadcast.js`, plus the channel tests.
- **Unchanged:** bot replies (`/psi`, `/pm25`, `/shelter`, `/masks`, `/help`), the dashboard, and the shared copy helpers (`shelterNotice` and the others in `public/psi.js`). Also unchanged are when posts are sent (breach, hourly and regular rules), the D1 lease and state, and notifications: every post still notifies as it does today, so there is no `disable_notification`.

## Formatting

- Posts are sent with `parse_mode: "HTML"`. They use only `<b>`, `<i>` and `<a href="…">`.
- Every piece of dynamic text is HTML-escaped (`&`, `<`, `>`, and `"` inside `href`), even though today's values are numbers, region names and our own copy. A parse error would make Telegram reject the post and stall the channel.
- Link previews stay disabled.
- **Band dots** use the dashboard's band colours:

  | Band | Dot |
  | --- | --- |
  | Good | 🟢 |
  | Moderate | 🟡 |
  | Unhealthy | 🟠 |
  | Very unhealthy | 🔴 |
  | Hazardous | 🟣 |
  | Unavailable | ⚪ |

- **Time format:** `18 Oct, 11:00 am`, in Asia/Singapore and followed by `SGT` where shown. The date stays so that forwarded posts still make sense. The year is dropped.

## Message layout

Blank lines separate the blocks, in this order.

1. **Headline** (bold):
   - `breach`: `⚠️ <b>Haze alert: PSI {high} in {where}</b>`. `where` is `regionList` of the regions at the highest PSI, e.g. "the West region" or "the West and Central regions".
   - `hourly`: `{dot of high} <b>Hourly haze update: PSI {low}–{high}</b>`
   - `regular`: `{dot of high} <b>Air quality update: PSI {low}–{high}</b>`
   - When every region has the same PSI, the range is a single value, e.g. `PSI 60`.
2. **Bands and time:** `{dot} {band}` when every region is in the same band, otherwise `{dot of low} {low band} to {dot of high} {high band}`. This is followed by ` · {PSI reading time} SGT`.
3. **Region rows**, in NEA order: `{dot} {Region} <b>{psi}</b>{trend} · PM2.5 {value}`.
   - The dot is the region's own PSI band.
   - When PM2.5 is missing for a region: `· PM2.5 n/a`.
   - When there is no PM2.5 snapshot (or it is dated in the future), the `· PM2.5 …` part is dropped from every row.
4. **Key line** (italic), for example `<i>24-hour PSI (↑↓ since 10:00 am) · 1-hour PM2.5 in µg/m³</i>`:
   - `(↑↓ since {previous hour})` appears only when at least one row has a trend.
   - When the PM2.5 reading time differs from the PSI reading time, the PM2.5 part reads `1-hour PM2.5 at {time} in µg/m³`.
   - With no PM2.5 snapshot, the PM2.5 part reads `PM2.5 unavailable`.
5. **Stale PM2.5** (only when `isStale(pm25)`): `⚠️ PM2.5 is delayed; showing the {pm25 time} readings.`
6. **Health advice:**
   - Highest PSI ≤ 100: one line, `🩺 <b>Health advice:</b> normal activities can continue for all groups.`
   - Otherwise:
     - Heading: `🩺 <b>Health advice</b> · for PSI {high}`
     - The `healthAdvice(high)` lines, each prefixed `• ` (wording unchanged).
     - Then `If you feel unwell, seek medical attention, especially if you are in a vulnerable group.`
7. **Haze shelters** (only when highest PSI > 200):
   - Heading: `🏠 <b>Haze shelters</b>`
   - Paragraph, built from three parts:
     - Highest PSI 201–300: `NEA opens haze shelters when the 24-hour PSI is above 200.`
     - Highest PSI > 300: `The 24-hour PSI is Hazardous in {where}. NEA says haze shelters at community clubs stay open until 10 pm.`
     - Always: `Call the centre before you go to confirm the room and its opening hours.`
     - With a bot username: ` Nearest: send /shelter to @{bot}`
8. **Free N95 masks** (only while `MASK_DISTRIBUTION` is on):
   - Heading: `😷 <b>Free N95 masks</b>`
   - Paragraph: `Eligible groups can collect them at {maskPlaces}.` then, with a bot username, ` Nearest: send /masks to @{bot} ·`, then ` Live stock: go.gov.sg/hazemask`.
9. **Footer** links: `<a href="{appUrl}">Hazey dashboard</a> · <a href="{NEA managing haze}">MOH advice via NEA</a> · Data: <a href="{SOURCE_URL}">NEA via data.gov.sg</a>`. The dashboard link is left out when there is no `https:` app URL.

Raw URLs are no longer written out for the dashboard, `#shelters`, `#masks` or the NEA page. The "More readings and trends" line is removed.

## Trend arrows

- **Source:** the saved PSI history row at exactly one hour before the current PSI reading: `SELECT readings FROM reading_history WHERE dataset = 'psi' AND reading_at = ?`, bound to `readingAt − 1 hour`. It is read in `broadcastChannel` after the snapshot is re-read under the lease, and passed to `channelMessage` as `previous` (a `{ north, … }` object, or `null`).
- **Per region:** `↑{n}` when PSI rose, `↓{n}` when it fell, `±0` when unchanged. There is no arrow when the row is missing, unreadable, or the region's previous value isn't a non-negative integer.
- **Applies to:** all three post types.
- **PSI only:** there are no arrows on PM2.5, which is a 1-hour value and swings too much to be useful.

## Buttons

There are still no buttons without an `https:` app URL.

- Row 1: `📊 Hazey dashboard` → app URL.
- Row 2, only when there is something to show:
  - `🏠 Nearest shelter` → `#shelters`, when highest PSI > 200
  - `😷 Free N95 masks` → `#masks`, while masks are on

## Testing

- Update the existing channel tests in `tests/worker.test.js` to the new wording. The behaviour they cover stays the same: advice boundaries, the shelter block at 200/201 and 300/301, masks on/off, missing or delayed PM2.5, and the breach/hourly/regular rules.
- Add tests for:
  - **Request settings:** `parse_mode: "HTML"` is set.
  - **Safe HTML:** the text uses only the allowed tags, every tag is closed, and every `&` is an entity.
  - **Escaping:** a region name or bot username containing `<` or `&` comes out escaped.
  - **Headline:** one test per post type.
  - **Band line:** the single-band and two-band forms.
  - **Arrows:** up, down, `±0`, a missing previous hour (no arrows and no `↑↓` in the key line), and one region missing from the previous row.
  - **Buttons:** the row layout at PSI 150 and 250, with masks on and off.
- Print sample posts from the real code (breach, hourly Hazardous, regular, delayed PM2.5) and read them before deploying.

## Release and verification

- Build on branch `channel-format`, run `npm test` and do a Wrangler dry run, then deploy only with the owner's go-ahead. Posts go to the public channel.
- No migration or new secrets are needed. The change uses the existing Worker, D1 binding and vars.
- **After deploying:** watch `wrangler tail` for the next `Channel broadcast sent (…)` line, read the post back from `t.me/s/hazey_sg` to confirm Telegram rendered the HTML, and have the owner check it on their phone. A `Telegram sendMessage failed (400)` log would mean Telegram rejected the HTML. If that happens, roll back to the previous version straight away.
- Update `HANDOVER.md` with the deployed version and what was verified.
