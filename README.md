# dotfiles

Cross-platform dotfiles. Two platform setups plus shared, OS-agnostic config:

| Path | What it is |
|------|-----------|
| [`macos/`](macos/) | Apple Silicon / Sequoia dev setup — Homebrew, zsh + starship, Ghostty, Karabiner, VS Code, mise/uv toolchain. |
| [`arch/`](arch/) | Wayland desktop — niri, waybar, DankMaterialShell, tmux, p10k. |
| [`pi/`](pi/) | **Shared** — [pi](https://github.com/earendil-works) agent config: settings, extensions, themes, prompts, skills, packages. Installed by both platforms into `~/.pi/agent`. |
| [`agents/`](agents/) | **Shared** — agent skills (`~/.agents/skills`, used by pi + OpenCode): agent-browser, copy-that-sells, cro, customer-research, hubstaff, imagegen-cli, telegram-tools. |

Secrets are never tracked. `pi/` ships `*.example.json` templates; the installers
scaffold `~/.pi/web-search.json` and `~/.pi/agent/extensions/clarity/config.json`
on first run for you to fill in.

## macOS

```bash
xcode-select --install                       # if not already present
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
git clone https://github.com/cornellsh/dotfiles ~/dotfiles
~/dotfiles/macos/bootstrap.sh
```

Layout:

- `macos/Brewfile` — all CLI + GUI packages. Regenerate: `brew bundle dump --force --describe --file=~/dotfiles/macos/Brewfile`
- `macos/zsh/.zshrc` — shell config (starship, mise, zoxide, fzf, modern CLI aliases)
- `macos/git/` — gitconfig + global gitignore
- `macos/defaults.sh` — system tweaks (key repeat, Finder, screenshots, Dock)
- `macos/karabiner/karabiner.json` — PrtSc → region screenshot to clipboard; Super-key launchers; Linux-style copy/paste
- `macos/bootstrap.sh` — installs, symlinks, applies defaults (idempotent)

Runtimes: **mise** owns node/go/rust (`mise use -g node@lts`); **uv** owns Python (`uv python install 3.13`).

## Arch Linux

```bash
git clone https://github.com/cornellsh/dotfiles ~/dotfiles
cd ~/dotfiles/arch && ./install.sh
```

niri compositor + waybar + DankMaterialShell. See [`arch/`](arch/) for details.
