# dotfiles

Reproducible macOS dev setup (Apple Silicon / Sequoia).

## Fresh machine
```bash
xcode-select --install                       # if not already present
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
git clone <this-repo> ~/dotfiles
~/dotfiles/bootstrap.sh
```

## Layout
- `Brewfile` — all CLI + GUI packages. Regenerate: `brew bundle dump --force --describe --file=~/dotfiles/Brewfile`
- `zsh/.zshrc` — shell config (starship, mise, zoxide, fzf, modern CLI aliases)
- `macos/defaults.sh` — system tweaks (key repeat, Finder, screenshots, Dock)
- `karabiner/karabiner.json` — PrtSc → region screenshot to clipboard
- `bootstrap.sh` — installs, symlinks, applies defaults

## Runtimes
- **mise** owns node/go/rust/etc. — `mise use -g node@lts`
- **uv** owns Python — `uv python install 3.13`, `uv venv`, `uv add ...`

## Screenshot to clipboard
Native: `⌘⇧⌃4` → drag region → release → in clipboard.
Karabiner maps **PrtSc** (and **F13**) to that shortcut. If your keyboard's
PrtSc sends neither, open Karabiner-Elements > EventViewer to see its key_code
and edit `karabiner/karabiner.json`.
