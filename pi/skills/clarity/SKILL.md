---
name: clarity
description: Access Microsoft Clarity behavior-analytics data — traffic, users, devices, geography, pages, referrers, smart events, scroll/click behavior, Core Web Vitals, JavaScript errors, and session recordings. Use when the user asks about their Clarity project, website analytics, "how many sessions/users," "top browsers/pages/countries," "session recordings," "rage clicks / dead clicks," "why are users leaving," heatmap-adjacent behavior, conversion/smart events, JS errors, page performance, or wants to pull Clarity data. Also use for Microsoft Clarity setup/how-to/troubleshooting documentation questions.
metadata:
  version: 1.0.0
---

# Microsoft Clarity

Query a Microsoft Clarity project's analytics, session recordings, and documentation via three native tools (backed by the Clarity Data Export API). The API token is configured globally in the `clarity` extension.

## Tools

### `clarity_query_analytics` — dashboard metrics (natural language)

The **authoritative source for aggregated metrics**. Send SIMPLE, SINGLE-PURPOSE queries with an explicit time range.

- `query` (required): natural-language, one metric/trend, with a time range.
- `timezone` (optional): IANA tz (e.g. `Europe/Zurich`). Defaults to UTC.

Covers: unique/returning users, sessions, device types, browsers, OS, countries/regions, traffic sources/referrers/channels/campaigns, popular pages, smart events (Purchase, ContactUs, SubmitForm, AddToCart, SignUp…), scroll depth, click patterns, JavaScript errors, URL performance, Core Web Vitals (LCP, FID, CLS), quick backs, dead clicks, rage clicks, session duration.

**Good queries**

- "Page views count for the last 7 days"
- "Top browsers last 3 days"
- "Top pages for mobile in the last 3 days"
- "Distinct users who visited <https://example.com/pricing> last month"
- "Average session duration for desktop users this week"
- "Top JavaScript errors for PC in the last 7 days"

**Avoid**: combining multiple unrelated metrics, vague asks ("analyze user behavior"), missing time range, "get all metrics." Break complex requests into several calls.

> Note: server-side NL processing means these calls can take ~30-40s. That's normal.

### `clarity_list_recordings` — session recordings (structured filters)

Returns recording metadata: session link, duration, interaction timeline.

- `filters` (object): put the **required** date range inside it.
- `sortBy`: `SessionStart_DESC` (default), `SessionStart_ASC`, `SessionDuration_ASC/DESC`, `SessionClickCount_ASC/DESC`, `PageCount_ASC/DESC`.
- `count`: 1-250 (default 100).

If no `filters.date` is given, the tool defaults to the last ~2 days.

**Filter keys** (all optional except `date` when you want a specific window):

- `date`: `{ "start": "2024-01-01T00:00:00.000Z", "end": "2024-01-31T23:59:59.999Z" }` — UTC ISO 8601 with ms.
- Segments: `userType` (NewUser|ReturningUser), `sessionIntent` (Low/Medium/High Intention).
- Device/tech: `deviceType` [Mobile|Tablet|PC|Email|Other], `browser` [Chrome|Edge|Safari|Firefox|Samsung|Opera|…], `os` [Windows|MacOS|iOS|Android|Linux|ChromeOS|…].
- Geo: `country` [], `state` [], `city` [] (name arrays).
- URLs: `visitedUrls`, `entryUrls`, `exitUrls` — arrays of `{ "url": "...", "operator": "contains|startsWith|endsWith|excludes|isExactly|isExactlyNot|matchesRegex|excludesRegex" }`. `referringUrl` (string).
- Marketing: `source` [], `medium` [], `campaign` [], `channel` [OrganicSearch|Direct|Email|Social|PaidSearch|Referral|…].
- Behavior: `smartEvents` [], `javascriptErrors` [] (use `""` to match any), `clickErrors` [], `clickedText`, `rageClickPresent`, `deadClickPresent`, `quickbackClickPresent`, `excessiveScrollPresent`, `enteredTextPresent`, `selectedTextPresent`, `cursorMovement`, `resizeEventPresent` (booleans).
- Ranges (`{ "min": n, "max": n }`, null to ignore): `sessionDuration`, `pageDuration`, `visiblePageDuration`, `hiddenPageDuration`, `scrollDepth` (0-100), `pagesCount`, `sessionClickEventCount`, `pageClickEventCount`, `performanceScore` (0-100), `largestContentfulPaint`, `cumulativeLayoutShift`, `firstInputDelay`.
- E-commerce: `productName`, `productBrand` [], `productPrice`, `productRating`, `productRatingsCount`, `productPurchases` (bool), `productAvailability` (bool), `checkoutAbandonmentStep` [].

**Examples**

- 10 newest sessions: `{ "count": 10, "sortBy": "SessionStart_DESC" }`
- 20 longest sessions in Jan 2024: `{ "filters": { "date": { "start": "2024-01-01T00:00:00.000Z", "end": "2024-01-31T23:59:59.999Z" } }, "sortBy": "SessionDuration_DESC", "count": 20 }`
- 15 mobile sessions with most clicks: `{ "filters": { "deviceType": ["Mobile"] }, "sortBy": "SessionClickCount_DESC", "count": 15 }`
- Sessions with rage clicks on pricing: `{ "filters": { "rageClickPresent": true, "visitedUrls": [{ "url": "/pricing", "operator": "contains" }] } }`
- Sessions that hit any JS error: `{ "filters": { "javascriptErrors": [""] } }`

### `clarity_query_docs` — documentation

Ask ONE focused Clarity how-to/setup/troubleshooting/API question.

- `query` (required): e.g. "How to track custom events in Clarity?", "How do I set up Clarity on Shopify?"

## Workflow tips

- Reach for `clarity_query_analytics` first for any "how many / top / average / trend" question.
- Use `clarity_list_recordings` when the user wants to watch/inspect specific sessions or filter by fine-grained behavior.
- Always resolve relative time phrases into explicit ranges when the user is precise; otherwise pass them through naturally ("last 7 days").
- Present numbers cleanly and cite the exact time range the API echoed back.

## Configuration

- Token file: `~/.pi/agent/extensions/clarity/config.json` (`{ "apiToken": "..." }`, chmod 600). Env `CLARITY_API_TOKEN` overrides it.
- Generate a token in Clarity: Settings → Data Export → Generate new API token.
