# Edge-case analysis & hardening

Grounding facts verified against pi's source (`@earendil-works/pi-ai`, `@anthropic-ai/sdk`)
and teamclaude's `server.js` / `account-manager.js`.

## Confirmed architecture facts

1. **Our fetch patch is picked up per request.** `anthropic-messages.js` calls
   `createClient()` → `new Anthropic()` → `getDefaultFetch()` **inside the
   per-request stream function** (line ~356). The SDK reads the *current*
   `globalThis.fetch` each time, so a once-installed patch applies to every
   subsequent request, including worker/subagent sessions (which run with
   extensions disabled — this is exactly why a fetch patch, not an event hook,
   is required).
2. **Request shape:** `this.fetch.call(undefined, url, fetchOptions)` — `(urlString,
   init)` with a JSON **string** body and `stream: true`. Streamed responses
   still expose `res.headers` immediately, so quota headers are readable.
3. **OAuth auth:** SDK sends `Authorization: Bearer <sk-ant-oat…>`. We swap it.
4. **`maxRetries: 0`** at the SDK level — pi does not auto-retry, so our
   transparent failover is the only retry layer that exists.
5. **429 classification (from teamclaude):** per-bucket status headers
   `anthropic-ratelimit-unified-5h-status`, `-7d-status`, `-7d_oi-status`
   (`= "rejected"` when spent). General reject ⇒ rotate; Fable-only reject ⇒
   rotate for Fable only. A 429 **without** any `rejected` is a per-minute
   rate-limit: **do not rotate** (that just moves the burst and discards the
   account's prompt cache) — wait `retry-after` inline and retry the same account.

## Issues found in v1 and the fix

| # | Sev | Issue | Fix |
|---|-----|-------|-----|
| 1 | P1 | **`/reload` spawns a 2nd AccountManager.** The patched `fetch` closure lives on `globalThis` and survives module reload, but a reloaded module re-runs `ensureManager()` → a second manager reading/writing the same state files (divergent state, double writes). | Store the manager + install flag on `globalThis`; every path resolves the one singleton. |
| 2 | P1 | **Fragile model parse.** A regex over the first 4 KB can match a `"model":"…"` nested in message content and route on the wrong family. | Byte-exact top-level JSON field finder (`parse.ts`, ported from teamclaude) — only matches `model` at depth 1 of the root object. |
| 3 | P1 | **Quota-reject over-poisons the account.** v1 forced `unified5h = 1`, marking the whole account dead even when only the *weekly* or *Fable* bucket was spent. | Classify via per-bucket `-status` headers; mark only the rejected bucket. Fable-only reject bars only Fable. |
| 4 | P1 | **No 401 handling.** An expired/rotated token returns 401 straight to pi. | On 401, force-refresh the account's token and retry once; a second 401 marks the account `error` and rotates. |
| 5 | P1 | **Unsafe retry fall-through.** If a retry threw, the outer catch re-sent a third time with pi's *original* (unswapped) token. | Retries are self-contained; on exhaustion the last real response/error is returned, never an unswapped resend. |
| 6 | P2 | **No storm control.** Dozens of subagents failing over at once all hit one fresh account and cascade-throttle the fleet. | Port `admit()`/`release()` + ramp (startConc 1, +1 / 250 ms, 30 s window); requests pace onto a just-switched account. |
| 7 | P2 | **Rate-limit 429 wrongly rotated.** v1 marked any 429 as throttled → rotated away on a per-minute limit, wasting the account's cache. | Distinguish; on a non-reject 429 `pauseAccount()` (still selectable) and wait+retry the same account for short `retry-after`, else surface 429. |
| 8 | P2 | **Token write-back race.** Concurrent refreshes read-modify-write the accounts file → last writer drops the other's new token. | Serialize file writes through a promise queue that re-reads and merges before each write. |
| 9 | P2 | **Debounced state lost on exit.** The 3 s unref'd timer may never fire before pi exits. | Flush on `session_shutdown` and `process.on("exit"/"beforeExit"/SIGINT/SIGTERM)`. |
| 10 | P3 | Abort handling — a client that goes away mid-wait should stop us waiting. | `admit()` and inline waits honor `init.signal`. |
| 11 | P3 | Config validation / clearer `/claude-accounts` (throttle + reset countdown). | Validate on load; richer status line. |

## Deliberately out of scope (documented, not bugs)

- Advisor-model routing (Claude Code-specific; pi doesn't send advisor tools).
- sx.org residential-proxy failover and MITM CA (proxy-only concerns).
- Cross-process coordination (multiple pi processes share the files but not the
  in-memory manager; each learns quota independently — acceptable, converges).
