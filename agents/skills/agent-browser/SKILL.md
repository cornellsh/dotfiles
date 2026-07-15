---
name: agent-browser
description: Fast, token-efficient browser automation for AI agents. Drives real Chrome/Chromium over CDP with accessibility-tree snapshots and compact @eN refs (~200-400 tokens instead of raw HTML). Use whenever the user wants to interact with a website, fill a form, click something, log in, extract data, scrape, test a web app, or take a screenshot. Available as a CLI (`agent-browser`) and as an MCP server (tools prefixed `agent_browser_*`). Replaces the old lightpanda skill.
allowed-tools: Bash(agent-browser:*)
metadata:
  binary: /home/user/.local/bin/agent-browser
  engine: chrome (system chromium at /usr/bin/chromium)
  source: "https://www.npmjs.com/package/agent-browser"
---

# agent-browser

Fast browser automation CLI for AI agents. Chrome/Chromium via CDP — no Playwright/Puppeteer dependency. Accessibility-tree snapshots with compact `@eN` refs let you interact with pages in ~200-400 tokens instead of parsing raw HTML.

The built-in skills ship with the CLI and stay version-matched. Load them on demand:

```bash
agent-browser skills get core --full   # full command reference + templates
agent-browser skills list              # electron, slack, dogfood, vercel-sandbox, agentcore
```

## The core loop (do this)

```bash
agent-browser open <url>        # 1. Navigate
agent-browser snapshot -i       # 2. See interactive elements + @eN refs
agent-browser click @e3         # 3. Act on refs
agent-browser snapshot -i       # 4. Re-snapshot after ANY page change
```

Refs (`@e1`, `@e2`, …) are assigned fresh on every snapshot and go **stale the moment the page changes** — after navigations, submits, re-renders, dialogs. Always re-snapshot before the next ref interaction. The browser persists across commands via a daemon, so chaining with `&&` in one shell call feels like one session.

## Efficiency rules (keep token cost low)

- Prefer `snapshot -i` (interactive only) over full `snapshot`. Add `-c` (compact) and `-d 3` (cap depth) to trim further.
- Use `-s "#main"` to scope a snapshot to a region instead of dumping the whole tree.
- Reach for `find role/text/label` (below) to skip a snapshot entirely when you already know the target.
- Screenshots are configured as capped-width JPEG — only take one when a visual check is actually needed; snapshots are cheaper for reasoning.
- Extract precise data with `get text @e5` / `get attr @e10 href` rather than dumping HTML.

## Reading a page

```bash
agent-browser snapshot -i            # interactive elements only (preferred)
agent-browser snapshot -i -u         # include link hrefs
agent-browser snapshot -i --json     # machine-readable
agent-browser get text @e1           # visible text
agent-browser get attr @e1 href      # any attribute
agent-browser get value @e1          # input value
agent-browser get url                # current URL
agent-browser get count ".item"      # count matches
```

## Interacting

```bash
agent-browser click @e1
agent-browser fill @e2 "hello"        # clear then type
agent-browser type @e2 " world"       # type without clearing
agent-browser press Enter             # or Control+a etc.
agent-browser select @e4 "value"
agent-browser check @e3 / uncheck @e3
agent-browser upload @e5 file.pdf
agent-browser scroll down 500
```

### Semantic locators (no snapshot needed)

```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click --exact
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search" type "query"
agent-browser find testid "submit-btn" click
```

Rule of thumb: `snapshot` + `@eN` is fastest/most reliable; `find role/text/label` is next; raw CSS (`click "#submit"`) is the fallback.

## Waiting (most failures come from bad waits)

```bash
agent-browser wait @e1                      # until element appears
agent-browser wait --text "Success"         # until text appears
agent-browser wait --url "**/dashboard"     # until URL matches (glob)
agent-browser wait --load networkidle       # SPA navigation catch-all
agent-browser wait --fn "window.app.ready"  # until JS condition
```

Avoid bare `agent-browser wait 2000` except when debugging. After any page-changing action, wait for a specific element/text/url instead.

## JavaScript extraction

Use a heredoc for anything with quotes:

```bash
cat <<'EOF' | agent-browser eval --stdin
const rows = document.querySelectorAll("table tbody tr");
Array.from(rows).map(r => ({ name: r.cells[0].innerText, price: r.cells[1].innerText }));
EOF
```

## Persistent login / state (intelligent reuse)

```bash
agent-browser state save ./auth.json                       # after logging in once
agent-browser --state ./auth.json open https://app.example.com   # start logged in
# or auto save/restore:
AGENT_BROWSER_SESSION_NAME=my-app agent-browser open https://app.example.com
```

For credentials, avoid shell history — use the auth vault:

```bash
agent-browser auth save my-app --url https://app/login --username user@x.com --password-stdin
agent-browser auth login my-app
```

## Parallel sessions & tabs

```bash
agent-browser --session a open https://app   # isolated browser (own cookies/refs)
agent-browser --session b open https://app
agent-browser tab                            # list tabs (stable tabId)
agent-browser tab new https://docs...        # open + switch
```

## MCP server

This machine runs agent-browser as an MCP server (tools `agent_browser_*`). It launches with the lean `core,tabs,state` profile for a small, capable context. To run more manually:

```bash
agent-browser mcp                       # core profile (smallest)
agent-browser mcp --tools core,network,react
agent-browser mcp --tools all           # full CLI parity (large surface)
```

Profiles: `core`, `network`, `state`, `debug`, `tabs`, `react`, `mobile`, `all`.

## Config on this machine (layered)

Precedence: `config.json` → env vars → CLI flags. Settings live in three places and apply to **both** the CLI and the MCP server:

1. **`~/.agent-browser/config.json`** — durable, tool-wide defaults:
   `executablePath: /usr/bin/chromium`, `screenshotFormat: jpeg`, `screenshotQuality: 70`,
   `maxOutput: 40000` (hard token cap on page output), `defaultTimeout: 20000`.
2. **`~/.config/environment.d/agent-browser.conf`** — resource hardening (do not remove):
   `AGENT_BROWSER_IDLE_TIMEOUT_MS=600000` (auto-close idle browser after 10 min) and
   `AGENT_BROWSER_ARGS=--disable-gpu,--disable-software-rasterizer,--disable-dev-shm-usage,--js-flags=--max-old-space-size=512`
   (kills the headless software-GPU CPU runaway + caps V8 heap). Loaded into the user session.
3. **opencode MCP** — launches `agent-browser mcp --tools core,tabs,state` (lean profile);
   inherits the two above, so no per-server env duplication needed.

More knobs worth knowing: `--profile <name|dir>` / `state save` (reuse logins), `AGENT_BROWSER_ALLOWED_DOMAINS` + `--action-policy` (scope/guardrails), `--enable react-devtools` (React apps), `AGENT_BROWSER_ENCRYPTION_KEY` (encrypt saved state), `AGENT_BROWSER_CONTENT_BOUNDARIES` (marker-wrapped output). Run `agent-browser doctor` to diagnose the install.

- Binary: `/home/user/.local/bin/agent-browser` (wraps `~/.npm-global/bin/agent-browser`).
- Cleanup: `agent-browser close` (or `close --all`) when finished; idle sessions also auto-close after 10 min.

## When to load another skill

- Electron desktop apps (VS Code, Slack, Discord) → `agent-browser skills get electron`
- Slack workspace automation → `agent-browser skills get slack`
- Systematic app exploration / bug hunting → `agent-browser skills get dogfood`
- Cloud browsers (Vercel Sandbox / AWS AgentCore) → `vercel-sandbox` / `agentcore`
