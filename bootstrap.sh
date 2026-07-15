#!/usr/bin/env bash
# ~/dotfiles/bootstrap.sh — idempotent setup. Run after Homebrew is installed.
set -euo pipefail
DOTFILES="$HOME/dotfiles"

# Ensure Homebrew is on PATH even in a non-login shell
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi

link() { ln -sfn "$1" "$2"; echo "linked $2 -> $1"; }

echo "==> Installing Brewfile packages"
brew bundle --file="$DOTFILES/Brewfile"

echo "==> Symlinking configs"
link "$DOTFILES/zsh/.zshrc" "$HOME/.zshrc"
link "$DOTFILES/starship.toml" "$HOME/.config/starship.toml"
mkdir -p "$HOME/.config/ghostty"
link "$DOTFILES/ghostty/config" "$HOME/.config/ghostty/config"
mkdir -p "$HOME/.config/karabiner"
link "$DOTFILES/karabiner/karabiner.json" "$HOME/.config/karabiner/karabiner.json"
mkdir -p "$HOME/Library/Application Support/Code/User"
link "$DOTFILES/vscode/settings.json" "$HOME/Library/Application Support/Code/User/settings.json"

echo "==> Applying macOS defaults"
bash "$DOTFILES/macos/defaults.sh"

echo "==> Global runtimes via mise (edit to taste)"
mise use -g node@lts go@latest rust@stable || true

echo
echo "Done. Remaining manual steps:"
echo "  - Grant Karabiner-Elements permissions (System Settings > Privacy & Security)"
echo "  - Launch Raycast, AltTab, Rectangle, Maccy once and grant Accessibility"
echo "  - Caps Lock -> Control: System Settings > Keyboard > Modifier Keys"
