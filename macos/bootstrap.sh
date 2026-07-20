#!/usr/bin/env bash
# ~/dotfiles/macos/bootstrap.sh — idempotent macOS setup. Run after Homebrew is installed.
set -euo pipefail
# Resolve this script's own dir so it works regardless of clone location.
DOTFILES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DOTFILES/.." && pwd)" # pi/ and agents/ are shared, not macos-only

# Ensure Homebrew is on PATH even in a non-login shell
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi

link() {
	ln -sfn "$1" "$2"
	echo "linked $2 -> $1"
}

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
mkdir -p "$HOME/.local/bin"
link "$DOTFILES/bin/clip-send" "$HOME/.local/bin/clip-send"
# SSH multiplexing (fast clip-send): drop-in conf + an Include if not present.
mkdir -p "$HOME/.ssh/sockets" "$HOME/.ssh/config.d"
chmod 700 "$HOME/.ssh" "$HOME/.ssh/sockets" "$HOME/.ssh/config.d"
link "$DOTFILES/ssh/tailnet.conf" "$HOME/.ssh/config.d/tailnet.conf"
touch "$HOME/.ssh/config"; chmod 600 "$HOME/.ssh/config"
if ! grep -q '^Include config.d/\*.conf' "$HOME/.ssh/config"; then
	printf 'Include config.d/*.conf\n\n%s' "$(cat "$HOME/.ssh/config")" >"$HOME/.ssh/config.tmp" \
		&& mv "$HOME/.ssh/config.tmp" "$HOME/.ssh/config"
	echo "prepended 'Include config.d/*.conf' to ~/.ssh/config"
fi
mkdir -p "$HOME/Library/Application Support/Code/User"
link "$DOTFILES/vscode/settings.json" "$HOME/Library/Application Support/Code/User/settings.json"

echo "==> Installing pi (shared config, extensions, skills)"
PI="$REPO/pi"
mkdir -p "$HOME/.pi/agent"/{themes,prompts,extensions,skills}
cp "$PI/settings.json" "$PI/AGENTS.md" "$HOME/.pi/agent/" # secrets never tracked
cp -R "$PI/themes/." "$HOME/.pi/agent/themes/"
cp -R "$PI/prompts/." "$HOME/.pi/agent/prompts/"
cp -R "$PI/extensions/." "$HOME/.pi/agent/extensions/"
cp -R "$PI/skills/." "$HOME/.pi/agent/skills/"
[ -f "$HOME/.pi/web-search.json" ] || cp "$PI/web-search.example.json" "$HOME/.pi/web-search.json"
[ -f "$HOME/.pi/agent/extensions/clarity/config.json" ] ||
	cp "$PI/extensions/clarity/config.example.json" "$HOME/.pi/agent/extensions/clarity/config.json"
mkdir -p "$HOME/.local/bin"
link "$PI/bin/claude-accounts" "$HOME/.local/bin/claude-accounts" # multi-account rotator CLI (needs bun)
if command -v pi >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
	while IFS= read -r pkg; do
		[ -n "$pkg" ] && pi install "$pkg" >/dev/null 2>&1 || true
	done < <(jq -r '.packages[]?' "$PI/settings.json")
fi

echo "==> Installing shared agent skills"
mkdir -p "$HOME/.agents/skills"
cp -R "$REPO/agents/skills/." "$HOME/.agents/skills/"
cp "$REPO/agents/.skill-lock.json" "$HOME/.agents/.skill-lock.json" 2>/dev/null || true
find "$HOME/.agents/skills" -name .git -type d -exec rm -rf {} + 2>/dev/null || true
chmod +x "$HOME/.agents/skills/telegram-tools/tg" 2>/dev/null || true

echo "==> Applying macOS defaults"
bash "$DOTFILES/defaults.sh"

echo "==> Global runtimes via mise (edit to taste)"
mise use -g node@lts go@latest rust@stable || true

echo
echo "Done. Remaining manual steps:"
echo "  - Grant Karabiner-Elements permissions (System Settings > Privacy & Security)"
echo "  - Launch Raycast, AltTab, Rectangle, Maccy once and grant Accessibility"
echo "  - Caps Lock -> Control: System Settings > Keyboard > Modifier Keys"
