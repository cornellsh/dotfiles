# arch-dotfiles

```bash
git clone https://github.com/cornellsh/arch-dotfiles.git
cd arch-dotfiles
./install.sh                 # interactive checklist
./install.sh all             # everything, no prompts
./install.sh shell pi tmux   # just these
```

## Components

| | Installs |
|---|---|
| **Shell** | `.zshrc` · `.bashrc` · `.profile` · `.gitconfig` · `.p10k.zsh`; oh-my-zsh, zsh-autosuggestions, powerlevel10k if missing |
| **Config** | everything in `config/` → `~/.config` (niri, waybar, DankMaterialShell, ghostty) |
| **Systemd** | user services from `systemd/user/` |
| **Scripts** | `~/scripts` · `~/.local/bin` (incl. `wt`, the worktree manager) |
| **VS Code** | extensions only (from `vscode/extensions-list.txt`); config not managed |
| **Pi** | config, extensions, themes, prompts, packages, skills (shared, from `../pi`) |
| **Tmux** | `.tmux.conf` (+ XDG mirror; restarts a stale server) |

**Worktrees** — `wt` (`local-bin/wt`): `wt new|fan|go|ls|rm|clean`. Worktrees at
`~/worktrees/<repo>/<branch>/`, repos scanned under `~/work`. Needs only `git`.

## Pi — `~/.pi/agent`

- **settings.json** — theme, model, compaction, and the pinned package set
  (installed automatically on `install.sh pi`).
- **extensions/** — `plan-mode`, `notify`, `git-checkpoint`, `permission-gate`,
  `protected-paths`, `custom-footer`, `hide-oauth-status`, `clarity`,
  `claude-oauth-worker-fix`, `search` (web-search-hub config). Subagent/todo are
  now packages (`@gotgenes/pi-subagents`, `@juicesharp/rpiv-todo`).
- **themes/** — `cornell.sh`.
- **prompts/** — `commit`, `explain`, `review`, `test`.
- **skills/** — `clarity` (Microsoft Clarity analytics tools).
- **packages** — `pi-claude-oauth-adapter`, `pi-web-access`, `pi-idle-time`,
  `pi-hypa`, `rpiv-todo`, `pi-lens`, `pi-simplify`, `pi-fff`, `pi-subagents`,
  `rpiv-btw`, `pi-dynamic-workflows`, `pi-search-hub`.

**Secrets** (never tracked; scaffolded from `*.example.json` on install):
`~/.pi/web-search.json` (search API keys) and
`extensions/clarity/config.json` (Clarity token). Fill them in after install.

Skills live in `~/.agents/skills` (shared, from `../agents`): `agent-browser`,
`copy-that-sells`, `cro`, `customer-research`, `hubstaff`, `imagegen-cli`,
`telegram-tools`.

**telegram-tools** — `tg` CLI (Telethon via `uv`): `tg me · chats · read ·
search · send · reply`. Credentials from the environment or `~/.zsh_secrets`.

## Requirements

`git` · `zsh` · `tmux` · `node`/`npm` · `uv` (telegram-tools) · `jq` (pi package
install / search keys) · `code` CLI (VS Code extensions) · Chrome/Chromium
(agent-browser, optional).
