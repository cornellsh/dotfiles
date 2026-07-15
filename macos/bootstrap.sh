#!/usr/bin/env bash
# ~/dotfiles/macos/bootstrap.sh — idempotent macOS setup. Run after Homebrew is installed.
set -euo pipefail
# Resolve this script's own dir so it works regardless of clone location.
DOTFILES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ensure Homebrew is on PATH even in a non-login shell
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi

link() { ln -sfn "$1" "$2"; echo "linked $2 -> $1"; }

echo "==> Installing Brewfile packages"
brew bundle --file="$DOTFILES/Brewfile"

echo "==> Symlinking configs"
link "$DOTFILES/zsh/.zshrc" "$HOME/.zshrc"
link "$DOTFILES/git/gitconfig" "$HOME/.gitconfig"
link "$DOTFILES/git/gitignore_global" "$HOME/.gitignore_global"
link "$DOTFILES/starship.toml" "$HOME/.config/starship.toml"
mkdir -p "$HOME/.config/mise"
link "$DOTFILES/mise/config.toml" "$HOME/.config/mise/config.toml"
mkdir -p "$HOME/.config/ghostty"
link "$DOTFILES/ghostty/config" "$HOME/.config/ghostty/config"
mkdir -p "$HOME/.config/karabiner"
link "$DOTFILES/karabiner/karabiner.json" "$HOME/.config/karabiner/karabiner.json"
mkdir -p "$HOME/Library/Application Support/Code/User"
link "$DOTFILES/vscode/settings.json" "$HOME/Library/Application Support/Code/User/settings.json"

echo "==> Applying macOS defaults"
bash "$DOTFILES/defaults.sh"

echo "==> Global runtimes via mise (edit to taste)"
mise use -g node@lts go@latest rust@stable || true

echo
echo "Done. Remaining manual steps:"
echo "  - Grant Karabiner-Elements permissions (System Settings > Privacy & Security)"
echo "  - Launch Raycast, AltTab, Rectangle, Maccy once and grant Accessibility"
echo "  - Caps Lock -> Control: System Settings > Keyboard > Modifier Keys"
