# dotfiles

Cross-platform dotfiles. Two self-contained setups sharing one repo:

| Platform | Path | What it is |
|----------|------|-----------|
| **macOS** | [`macos/`](macos/) | Apple Silicon / Sequoia dev setup — Homebrew, zsh + starship, Ghostty, Karabiner, VS Code, mise/uv toolchain. |
| **Arch Linux** | [`arch/`](arch/) | Wayland desktop — niri, waybar, DankMaterialShell, tmux, p10k. |

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
