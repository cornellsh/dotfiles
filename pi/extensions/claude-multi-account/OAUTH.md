# OAuth token lifecycle — edge cases & handling

OAuth **refresh tokens rotate**: every successful refresh returns a *new* refresh
token and invalidates the previous one. So the failure modes here are not just
"token expired" — a lost write or a second refresher **permanently kills an
account** (requires re-login). This is the highest-risk area; here's the full map.

## How pi itself handles the `auth.json` account (verified in `pi-ai/auth/resolve.js`)

- Per request, pi resolves the anthropic OAuth credential. `expires` already has a
  **5-minute early skew** baked in, so pi refreshes ~5 min before true expiry.
- On expiry it takes a lock, refreshes once, and **persists the rotated token to
  `auth.json`** (double-checked so concurrent requests/processes refresh once).
- If the refresh throws, pi throws and **aborts the request before our fetch patch
  runs** — we cannot rescue the `auth.json` account's token ourselves.
- The incoming request's `Authorization: Bearer …` is therefore always pi's
  freshly-resolved `auth.json` access token.

## The conflict this creates, and the fix

The seeded `default` account is a **copy** of `auth.json`'s refresh token. pi and
our extension both rotating that one token = guaranteed divergence → death.

**Fix — "external" accounts.** The `auth.json`-backed account is flagged
`external: true`. For it we:

- **never refresh it ourselves** (pi owns its rotation);
- **use pi's live token** — the incoming request bearer, which pi just resolved and
  keeps fresh — instead of our stored copy;
- still track its quota by name and rotate to/from it normally.

Our dedicated accounts (added via `claude-accounts login`/`import`) each have their
**own** refresh token, so we are their sole owner — no conflict.

The seeded/migrated `default` account is auto-marked external (on seed, and on load
when an un-flagged account's refresh token matches `auth.json`).

## Edge cases and how each is handled

| Case | Handling |
|------|----------|
| Access token **expiring soon** (dedicated) | Opportunistic background refresh; a **proactive timer** refreshes any dedicated token expiring within 10 min so it's never caught expired. |
| Access token **hard-expired** at selection | `selectFresh*` blocks on a refresh before returning, so we never inject a dead token. |
| **401** despite a fresh-looking token | Force-refresh + retry once (dedicated). Still 401 with a new token ⇒ mark errored + rotate. External account ⇒ can't refresh (pi owns it), rotate away + surface. |
| **Transient** refresh failure (network/5xx/timeout) | Token kept, account stays **active** (NOT errored); retried next time. A blip never sidelines a healthy account. |
| **Genuine** auth rejection (refresh returns 400/401/403) | Account marked `error` (dropped from rotation until re-login/`enable`). |
| Refresh token **rotated** on success | New token persisted immediately via a serialized, re-read-and-merge write queue so concurrent refreshes can't clobber each other. |
| Refresh sees a **400** because another process/machine rotated first | Re-reads the accounts file once and retries with the newer token before giving up. |
| Refresh response **omits** a new refresh token | Keeps the existing one (`data.refresh_token || old`). |
| `expires_at` in **seconds vs ms** | Normalized (`normalizeExpiresAt`). |
| Concurrent refreshes for one account | Coalesced into a single in-flight `_refreshPromise`. |
| **Idle** account's token going stale from disuse | The proactive timer refreshes dedicated accounts before expiry, exercising the refresh token so it stays valid indefinitely. |
| Process **exits** mid-refresh | The new token is persisted synchronously on success before use; a crash before persist falls back to the previous token (still valid until pi/we rotate again for external; for dedicated, re-login only if that exact token had already rotated server-side — rare). |

## Multi-machine caveat (important for the studio sync)

Two machines actively refreshing the **same** account (same refresh token) will
rotate it out from under each other → one dies. OAuth refresh-token rotation makes
a single account inherently single-owner. So across machines:

- **Give each machine its own dedicated accounts** (`claude-accounts login` on each),
  **or** partition the account list per host — do **not** copy one account's tokens
  to a second machine that will also be running pi.
- The `external` (`auth.json`) account is naturally per-machine (each host logs into
  pi separately), so it never conflicts across machines.
- The re-read-before-refresh + retry-on-400 logic self-heals a *shared filesystem*
  case, but independent copies on two boxes cannot both refresh the same token.
