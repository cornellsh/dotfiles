---
name: hubstaff
description: Query and correct Hubstaff time tracking. Two tools — the `hubstaff` CLI (NetsoftHoldings/hubstaff-cli) for fast read/query and API writes against the Hubstaff v2 API, and agent-browser (CDP) for surgical timesheet edits the API can't do. Use when the user wants to review their Hubstaff timesheet, query projects/members/activities, find time tracked with no screenshots / no activity (e.g. a timer that "accidentally ran"), delete/edit/split time entries, or reconcile worked hours against the screenshot grid. ALWAYS show what will be deleted and get explicit confirmation before any destructive edit.
---

# Hubstaff

Two complementary tools:

1. **`hubstaff` CLI** — the [NetsoftHoldings/hubstaff-cli](https://github.com/NetsoftHoldings/hubstaff-cli)
   Rust tool that talks to the Hubstaff **v2 public API**. Use it first for anything
   read-only (whoami, projects, members, activities, tracked totals) and for API-backed
   writes. Fast, scriptable, no browser needed.
2. **agent-browser (CDP)** — drive the user's already-logged-in browser for surgical
   timesheet edits the public API does NOT expose (sub-range **Delete time** / **Split
   time entry**). See [Browser automation](#browser-automation-surgical-timesheet-edits).

## The `hubstaff` CLI

Installed binary: `~/.cargo/bin/hubstaff` (v0.4.0+; `~/.cargo/bin` is on PATH via
`~/.cargo/env` sourced in `~/.zshrc`). Reinstall/upgrade:

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/NetsoftHoldings/hubstaff-cli/releases/latest/download/hubstaff-installer.sh | sh
```

> Do NOT install to `~/.local/bin` — that already holds a **directory** named `hubstaff`
> (the old proprietary Hubstaff desktop CLI, `HubstaffCLI.bin.x86_64`). The two are
> unrelated; keep the new Rust CLI in `~/.cargo/bin`.

### Authentication — one unified token

There is **one** Hubstaff Personal Access Token for everything (the CLI *and* the
DankMaterialShell HubstaffTimer widget). It lives in **`~/.zsh_secrets`**:

```sh
export HUBSTAFF_PAT="eyJ0eXAiOiJKV1Q..."   # PAT / refresh token, scope: hubstaff:read+write tasks:read+write
export HUBSTAFF_ORG_ID="190607"
export HUBSTAFF_USER_ID="4214424"
```

The CLI stores its own exchanged access/refresh tokens under
`~/.config/hubstaff/config.toml` after a one-time:

```sh
hubstaff config set-pat "$HUBSTAFF_PAT"     # exchanges PAT -> access+refresh, auto-refreshes after
hubstaff config set organization "$HUBSTAFF_ORG_ID"
```

The **same** PAT is also written to the widget at
`~/.config/DankMaterialShell/plugin_settings.json` → `hubstaffTimer.apiToken`. If the
token is ever rotated, update **all three**: `~/.zsh_secrets`, `hubstaff config set-pat`,
and the widget's `apiToken` (then clear any persisted `refreshToken` plugin state — the
widget self-heals via its PAT-retry path, but clearing avoids one failed refresh).

### Common commands

```sh
hubstaff check                 # 8-point health check (auth, token validity, API reach, org access)
hubstaff users me              # whoami
hubstaff list                  # every available API command, grouped by resource
hubstaff projects list
hubstaff -p projects list       # pretty/colorized JSON
hubstaff -j projects list | jq  # minified JSON for piping
hubstaff -o 190607 projects list  # per-invocation org override
```

Exit codes: `0` success · `1` API error · `2` auth error · `3` config/usage · `4` network.
Org `190607`, user `4214424`. Run `hubstaff <group> --help` for flags.

> **CLI vs browser:** the public v2 API (and thus the CLI) can read activities/screenshots
> metadata and do standard CRUD, but it can NOT punch a hole in a running time entry
> (sub-range delete / split). For that specific "timer left running, no screenshots"
> correction, use the browser flow below.

---

# Browser automation (surgical timesheet edits)

Review and surgically correct Hubstaff time tracking by driving the user's
already-logged-in browser with `agent-browser` over the Chrome DevTools Protocol.

The canonical task: a Hubstaff timer was left running so the timesheet contains
"fake" hours with **no screenshots / no activity**. Identify those windows from the
authoritative screenshot grid, confirm the amount with the user, then delete exactly
that time using the entry's **Delete time** sub-range tool.

## Golden rules

- **This is destructive and operates on real time records.** Treat it like a
  production database edit.
- **Only the user's own account.** The pattern below assumes correcting one's own
  accidentally-tracked time. Do not use it to alter other people's billable records.
- **Always confirm first.** Compute the exact range(s) and total duration, present
  them, and wait for an explicit "yes" before clicking Save.
- **Verify after.** Re-read the timesheet total and confirm it dropped by exactly the
  expected amount.

## Prerequisites: attach to the logged-in session

Hubstaff requires login, so reuse the user's existing browser profile. The user is
usually in Chrome/Chromium/Vivaldi. Use a debug port **other than 9222** if a headless
agent Chrome is already squatting on 9222 (common) — this playbook uses **9223** for the
user's real browser.

If the user's browser is running **without** a debug port (the common case), restart it
with the same profile so cookies/login survive. Example for Vivaldi on Linux:

```bash
# 1. Find the main process and quit gracefully (preserves session/tabs)
pgrep -a vivaldi-bin
kill -TERM "$(pgrep -o -x vivaldi-bin)"   # wait until pgrep -x vivaldi-bin is empty

# 2. Relaunch with the debug port on the SAME profile
rm -f ~/.config/vivaldi/Singleton*    # clear stale lock
nohup /opt/vivaldi/vivaldi-bin --remote-debugging-port=9223 \
      --user-data-dir="$HOME/.config/vivaldi" >/tmp/vivaldi-debug.log 2>&1 &

# 3. Confirm the REAL browser answers on the port
curl -s http://localhost:9223/json/version
```

Chrome equivalent: `google-chrome --remote-debugging-port=9223 --user-data-dir=<profile>`.

Tell the user you restarted their browser (tabs restore normally) and that a
debug port is now open; they should fully quit + reopen when done to close it.

### ⚠️ CRITICAL: make sure agent-browser drives the REAL browser, not its own

This is the single biggest time-sink. `agent-browser` runs a **managed headless Chrome**
of its own and will happily ignore your `--cdp <port>` if it already has a running
session — or silently **re-spawn its own browser after its idle timeout**
(`AGENT_BROWSER_IDLE_TIMEOUT_MS`, default 10 min). Symptoms: it keeps showing the
Hubstaff **login page** even though the user is clearly logged in, and
`agent-browser tab list` shows tabs (e.g. `localhost:3000`, `account.hubstaff.com/login`)
that **don't exist** in the user's browser.

**Always verify attachment by cross-checking the two views — they must agree:**

```bash
agent-browser --cdp 9223 tab list                 # agent-browser's view
curl -s http://localhost:9223/json | python3 -c "import sys,json;[print(t['url']) for t in json.load(sys.stdin) if t['type']=='page']"
```

If they disagree (or you see a private `/tmp/agent-browser-chrome-*` profile in
`ps aux | grep agent-browser-chrome`), **reset agent-browser and re-attach**:

```bash
agent-browser close --all                          # kills its managed session
pkill -f agent-browser-chrome                      # kill any lingering own-chrome
export AGENT_BROWSER_CDP=9223                       # pin the port for every call
agent-browser --cdp 9223 tab list                  # must now show the real Hubstaff tab
```

Then keep `AGENT_BROWSER_CDP=9223` exported and pass `--cdp 9223` on **every** call.
Because of the 10-min idle timeout, if the user goes away mid-task, re-run the
close-all + re-attach block before continuing — do NOT trust that you're still on their
browser. A fresh navigation redirecting to `account.hubstaff.com/login` is the tell that
you've drifted onto agent-browser's own logged-out Chrome (not necessarily a real session
expiry).

> Prefer `agent-browser` over the older `browser-tools` eval scripts here. Hubstaff's
> Vue components ignore synthetic `.value` assignments — agent-browser's real
> keystrokes (`fill`) are what actually update the time-range slider model.

## Step 1 — Open the daily timesheet

URL shape (substitute org id and user id):

```
https://app.hubstaff.com/organizations/<ORG>/time_entries/daily?date=<YYYY-MM-DD>&date_end=<YYYY-MM-DD>&filters%5Buser%5D=<USER>
```

```bash
agent-browser --cdp 9223 open "<daily url>"
agent-browser --cdp 9223 snapshot -i        # rows show Project/Activity/Idle/Duration/Time + per-row "Actions"
```

Each row = one time entry: `Duration` and a `12:00 am - 9:36 am` style span. The header
shows `Today: HH:MM:SS` (the live total — it keeps growing if the timer is still running).

## Step 2 — Get the authoritative screenshot grid

The daily view's `Activity —` / `0%` is NOT proof of missing screenshots. Use the
Screenshots ("Every 10 min") page — nav link **Screenshots** points to `/organizations/<ORG>/activities`:

```
https://app.hubstaff.com/organizations/<ORG>/activities?date=<YYYY-MM-DD>&date_end=<YYYY-MM-DD>&filters%5Buser%5D=<USER>
```

```bash
agent-browser --cdp 9223 open "<activities url>"
# Robust parse of every 10-min slot as one line per slot:
agent-browser --cdp 9223 get text body | tr '\n' '|' \
  | grep -oE "(View screens\|[0-9]+ screens\|[0-9:apm -]+|No screenshot\|[0-9:apm -]+|No activity\|[0-9:apm -]+)" \
  | sed -E 's/View screens\|[0-9]+ screens\|//; s/No screenshot\|/NOSCREEN /; s/No activity\|/NOACT /'
```

The daily view's `Today: HH:MM:SS` equals the sum of the entry durations — if they match
exactly, the desktop timer is NOT currently running; if `Today:` exceeds the sum (and the
last entry's end time keeps advancing between snapshots), the timer is still live.

Each 10-minute slot reads either `View screens | N screens` (real) or **`No screenshot`**
(or `No activity`). Walk the day and record contiguous `No screenshot` runs — those are
the windows to remove. Note the exact start/end boundaries (e.g. last real slot
`2:20–2:30 am`, first real slot after the gap `9:30–9:40 am` ⇒ delete `2:30–9:30 am`).

## Step 3 — Map gaps to entries, compute totals, CONFIRM

A no-screenshot run usually sits inside one entry (often a long overnight entry).
Compute the total to delete and the resulting new daily total, then present a table:

```
Delete 2:30 am – 9:30 am = 7:00:00
Entry 12:00 am–9:36 am splits into 12:00–2:30 am (kept) and 9:30–9:36 am (kept)
New daily total: 18:45:11 → 11:45:11
```

**Wait for explicit confirmation.**

## Step 4 — Delete the range (surgical, preserves screenshotted edges)

A time entry is one continuous span, so you cannot punch a hole with plain "Edit".
Open the entry's **Actions → Split time entry**, which opens a "Split time" modal with two
tabs: **REASSIGN TIME** (default) and **DELETE TIME**. The DELETE TIME tab deletes a
sub-range and auto-splits the entry, keeping the screenshotted segments on both sides.

```bash
# Open the row's Actions dropdown for the RIGHT entry, then Split time entry.
# snapshot -i first to get the per-row Actions button @ref (e.g. @e72 for row 1).
agent-browser --cdp 9223 snapshot -i | grep -iE "Today:|am -|Actions|ref=e"
agent-browser --cdp 9223 click @<actions_ref>              # opens the dropdown
agent-browser --cdp 9223 snapshot -i | grep -iE "Split time entry|Delete time entry|Edit time"
agent-browser --cdp 9223 click @<split_time_entry_ref>     # link "Split time entry"
```

**Switching to the DELETE TIME tab is the fiddly part.** The tab is an `li.nav-item`
whose visible label "DELETE TIME" is CSS-uppercased (DOM text is "Delete time"). Both
`find text "DELETE TIME" click` (wrong case) and `find text "Delete time" click` fail —
the latter reports the element is **covered by `div.modal-backdrop.loader`**. Coordinate
clicks (`click <x> <y>`) also error. The reliable method is a JS click via `eval`:

```bash
agent-browser --cdp 9223 eval "(() => {
  const t = [...document.querySelectorAll('li.nav-item, a, button, div, span')]
    .find(e => e.textContent.trim().toLowerCase() === 'delete time' && e.offsetParent !== null);
  if (!t) return 'NOT FOUND';
  t.click();
  return 'clicked ' + t.tagName + '.' + t.className;
})()"
agent-browser --cdp 9223 screenshot /tmp/hs_delete_tab.png   # confirm DELETE TIME is now active (underlined)
```

Now set the range and save:

```bash
agent-browser --cdp 9223 snapshot -i | grep -iE "textbox|Why are|Save"   # FROM/TO/Reason/Save refs

# FROM = first textbox (e.g. @e77, shows "12:00"), TO = second (@e79, shows "11:49:16").
# Enter H:MM:SS WITHOUT the am/pm (am/pm is a separate toggle, already correct for a morning gap).
agent-browser --cdp 9223 fill @<from_ref> "4:50:00"
agent-browser --cdp 9223 press Tab
agent-browser --cdp 9223 fill @<to_ref>   "11:40:00"
agent-browser --cdp 9223 press Tab

# VERIFY before saving: screenshot and check the RED bar spans only the gap,
# green on both edges, and the duration tooltip equals your expected total (e.g. 6:50:00).
agent-browser --cdp 9223 screenshot /tmp/hs_verify.png

# Reason is required, then Save (the reason textbox @ref, then the Save button @ref)
agent-browser --cdp 9223 fill @<reason_ref> "Timer accidentally left running; no screenshots/activity captured in this window; removing untracked time."
agent-browser --cdp 9223 click @<save_ref>
```

The red bar = the slice being deleted; green = kept. The popover under the slider shows
the deleted duration — it MUST equal your confirmed total before you click Save. If the
red bar still starts at the entry's start after editing FROM, re-`fill` the FROM field
(real keystrokes) — that is the step that moves the lower slider handle.

For multiple separate gaps, repeat Step 4 per gap.

> Note: the older `Split time → DELETE TIME` wording is the same flow — the modal is
> titled "Split time" and the sub-range delete lives on its DELETE TIME tab.

## Step 5 — Verify

```bash
agent-browser --cdp 9223 open "<daily url>"
agent-browser --cdp 9223 snapshot -i | grep -iE "Today:|am -|pm"   # total + split rows
```

Confirm the split rows are present (e.g. `12:00 am - 4:50 am` and `11:40 am - 11:49 am`
kept, the middle gone) and `Today:` dropped by exactly the deleted amount.

Confirm the daily total dropped by exactly the deleted amount and the entry split as
expected. If the live timer is still running, the total will be (old − deleted + new
elapsed); call that out and offer to note it.

## Gotchas

- **Live timer keeps accruing.** The last entry / `Today:` total grows during the
  session. Account for it when reconciling, and remind the user to stop the desktop
  timer if the day is done.
- **`Activity —` ≠ no screenshots.** Always confirm against the 10-min grid.
- **Vue inputs ignore `el.value = ...`.** Use `agent-browser fill` (real keys). This was
  the single biggest failure mode.
- **Refs go stale** after every click/modal change — re-`snapshot -i`.
- **agent-browser drives its OWN headless Chrome** unless you force-attach, and it
  re-spawns one after a ~10-min idle timeout. If it keeps showing the login page while
  the user is logged in, you're on the wrong browser: `agent-browser close --all` +
  `pkill -f agent-browser-chrome`, then re-attach with `--cdp <port>`. Cross-check
  `agent-browser tab list` against `curl http://localhost:<port>/json`.
- **DELETE TIME tab won't click** via `find text` (CSS-uppercased label; covered by
  `div.modal-backdrop.loader`) or coordinates. Use `agent-browser eval` with a JS
  `.click()` on the `li.nav-item` whose lowercased text is `delete time`.
- **The "Split time entry" modal IS the delete tool** — its DELETE TIME tab removes a
  sub-range. FROM/TO take `H:MM:SS` without am/pm (am/pm is a separate toggle).
- **Edit vs Split:** "Edit time entry" only changes one entry's start/end (can't remove a
  middle). "Split time entry → DELETE TIME" removes a sub-range. "Delete time entry"
  removes a whole entry.
- **Reason is mandatory** on edits/splits; saving fails silently-ish without it.
- Other useful columns/menus: `Reassign time` (move a sub-range to another project),
  CSV/PDF export links on the daily page for an audit trail before editing.
