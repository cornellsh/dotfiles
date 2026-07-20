# claude-multi-account

Multi-account Claude OAuth rotation for **pi**, inline in-process — teamclaude's
core idea without a separate proxy, MITM CA, or extra port.

pi injects a single account's OAuth token (from `~/.pi/agent/auth.json`). This
extension patches global `fetch` so every `api.anthropic.com/v1/messages` request
is routed to the best of N configured accounts:

- swaps the `Authorization` bearer to the chosen account's token (refreshing it
  synchronously if expired, opportunistically if expiring soon);
- learns each account's **5h / weekly / Fable** quota from the response's
  `anthropic-ratelimit-unified-*` headers and persists it;
- **rotates** at a threshold (default 98%), preferring lower `priority` then the
  account whose weekly quota resets soonest (spend the closest-to-refresh first);
- on a **quota-reject 429** transparently fails over to the next eligible
  account (classified per-bucket via `-5h/-7d/-7d_oi-status: rejected`, so a
  Fable-only rejection rotates only for Fable);
- on a **rate-limit 429** (no bucket rejected) does **not** rotate — it pauses
  the account and absorbs the `retry-after` inline on the same account (rotating
  would just move the burst and discard its prompt cache);
- on a **401** force-refreshes the token and retries once, else marks the
  account errored and rotates;
- **storm control**: a burst of subagents failing over onto a fresh account is
  paced with a ramp so it isn't instantly throttled;
- per-model-family weekly buckets: a spent Fable bucket only bars Fable requests.

See `ANALYSIS.md` for the full edge-case review and `test.ts` /
`test-integration.ts` for the covering tests (`bun test.ts && bun
test-integration.ts`, 44 assertions).

### Reliability notes

- **Reload-safe**: the manager, patched `fetch`, and write queue live on
  `globalThis`, so `/reload` reuses the one instance instead of spawning a second
  that double-writes state. (Patch *code* changes still need a full restart.)
- **Verified against pi's source**: the Anthropic SDK client — and the `fetch` it
  binds — is constructed per request, so this once-installed patch covers every
  request including worker/subagent sessions (which run with extensions
  disabled). pi sets `maxRetries: 0`, so this failover is the only retry layer.
- **Concurrency-safe**: token write-backs are serialized (re-read + merge) so
  simultaneous refreshes can't clobber each other; quota state is flushed on
  `session_shutdown` and process exit.

It coexists with `claude-oauth-worker-fix.ts` — that patch fixes the billing
header, this one swaps the token. The two `fetch` wrappers stack and are
independent regardless of load order.

## Files

- `index.ts` — extension: fetch patch, wiring, `/claude-accounts` command.
- `manager.ts` — account selection + quota tracking (ported from teamclaude).
- `oauth.ts` — token refresh, import, browser login (PKCE), usage probe.
- `cli.ts` — management CLI (run via the `claude-accounts` launcher).
- `ANALYSIS.md` / `OAUTH.md` — edge-case reviews; `test.ts` / `test-integration.ts`.

## Token lifecycle & caching (see `OAUTH.md`)

- **External (`auth.json`) account**: the seeded `default` is flagged `external` —
  pi owns its OAuth rotation, so we never refresh it (that would rotate pi's
  shared refresh token and kill the account); we ride on pi's live incoming
  token. Dedicated accounts (`login`/`import`) are refreshed by us.
- **Proactive refresh**: a background timer refreshes dedicated tokens before
  expiry so one is never caught expired mid-request and the refresh token stays
  exercised (valid despite disuse). Transient failures never sideline an account;
  only a genuine 400/401/403 errors it. A 400 from a rotated token triggers a
  re-read + retry.
- **Cache affinity**: Anthropic prompt caching is per-account, so a session
  sticks to one account (keyed on its cached prefix) to keep the cache warm —
  rotating only on exhaustion. Avoids re-reading the whole context at cache-write
  pricing when subagents/workflows run concurrently.

## Config

- Accounts: `~/.pi/agent/claude-accounts.json`
- Persisted quota: `~/.pi/agent/claude-accounts-state.json`

On first run, if no accounts file exists, one account is **seeded** from
`~/.pi/agent/auth.json` so nothing breaks. Add more accounts with the CLI.

```json
{
  "switchThreshold": 0.98,
  "probeOnStart": true,
  "accounts": [
    { "name": "personal", "accessToken": "...", "refreshToken": "...", "expiresAt": 1700000000000, "priority": 0 },
    { "name": "work",     "accessToken": "...", "refreshToken": "...", "expiresAt": 1700000000000, "priority": 1 }
  ]
}
```

## CLI

```bash
claude-accounts list                 # accounts + quota
claude-accounts import               # from ~/.claude/.credentials.json
claude-accounts import --from PATH --name alias
claude-accounts login                # browser OAuth for a new account
claude-accounts disable <name>       # keep but skip
claude-accounts enable  <name>
claude-accounts remove  <name>
claude-accounts priority <name> <n>  # lower = preferred
claude-accounts probe                # refresh quota now (no message spend)
```

Adding accounts: run `claude /login` in another account then `claude-accounts
import`, or `claude-accounts login` directly. Changes are picked up on the next
pi session (or `/reload`).

## In pi

`/claude-accounts` shows live rotation status (current account, quota bars).

## Deploy to another machine

The extension deploys automatically via the dotfiles bootstrap (`macos/bootstrap.sh`
copies `pi/extensions/.` → `~/.pi/agent/extensions/` and symlinks the
`claude-accounts` launcher; `arch/install.sh` copies both). It needs **bun** on
the target (pi already requires it).

**Do NOT copy `claude-accounts.json` to a second live machine.** OAuth refresh
tokens are single-owner — two machines refreshing the same account rotate the
token out from under each other and one dies. Instead, on the new machine:

1. `pi` → `/login` the main account → the `external` (`auth.json`) account seeds
   itself and is owned by that machine's pi (no conflict).
2. `claude-accounts login --name <alias>` for each **dedicated** account you want
   there — fresh logins mint that machine its own refresh tokens. Or partition
   your accounts so each is used on only one machine.

## Env

- `PI_CLAUDE_ROTATOR_DEBUG=1` — log rotation decisions to stderr.
- `PI_CLAUDE_ROTATOR_LOG=/path` — append logs to a file.
- `PI_CLAUDE_ACCOUNTS_FILE`, `PI_CLAUDE_ACCOUNTS_STATE_FILE` — override paths.
- `PI_CLAUDE_RL_ABSORB_MAX` — max seconds to absorb a rate-limit 429 inline on
  the same account before surfacing it (default 15).
- `PI_CLAUDE_REFRESH_TIMEOUT_MS` — per-attempt OAuth refresh timeout (default 30000).
- `PI_CLAUDE_REFRESH_INTERVAL_MS` — proactive token-refresh interval (default 60000).

Config keys: `cacheAffinity` (default true), `pinTtlMs` (default 300000), and
per-account `external: true` (pi/auth.json-owned; also set via
`claude-accounts external <name>`).

Credit: selection/quota logic adapted from
[KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude) (MIT).
