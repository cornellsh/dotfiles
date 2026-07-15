#!/usr/bin/env bash
# ~/dotfiles/macos/defaults.sh — sane macOS defaults for a Linux power user.
# Re-runnable and reversible. Verified on Sequoia 15.7.
set -euo pipefail

echo "Applying macOS defaults..."

# --- Keyboard: fast repeat, no accent popup ---
defaults write -g InitialKeyRepeat -int 15      # delay before repeat (lower = faster)
defaults write -g KeyRepeat -int 2              # repeat rate (lower = faster)
defaults write -g ApplePressAndHoldEnabled -bool false

# --- Finder ---
defaults write NSGlobalDomain AppleShowAllExtensions -bool true
defaults write com.apple.finder AppleShowAllFiles -bool true
defaults write com.apple.finder ShowPathbar -bool true
defaults write com.apple.finder ShowStatusBar -bool true
defaults write com.apple.finder FXPreferredViewStyle -string "Nlsv"   # list view
defaults write com.apple.finder _FXSortFoldersFirst -bool true

# --- Screenshots: PNG, dedicated folder ---
mkdir -p "$HOME/Screenshots"
defaults write com.apple.screencapture location "$HOME/Screenshots"
defaults write com.apple.screencapture type png
defaults write com.apple.screencapture disable-shadow -bool true

# --- No .DS_Store on network/USB volumes ---
defaults write com.apple.desktopservices DSDontWriteNetworkStores -bool true
defaults write com.apple.desktopservices DSDontWriteUSBStores -bool true

# --- Dock: fast autohide ---
defaults write com.apple.dock autohide -bool true
defaults write com.apple.dock autohide-time-modifier -float 0.15
defaults write com.apple.dock autohide-delay -float 0
defaults write com.apple.dock show-recents -bool false

# --- Misc quality of life ---
defaults write NSGlobalDomain NSAutomaticSpellingCorrectionEnabled -bool false
defaults write NSGlobalDomain NSAutomaticCapitalizationEnabled -bool false
defaults write NSGlobalDomain AppleShowScrollBars -string "Always"

killall Dock Finder SystemUIServer 2>/dev/null || true
echo "Done. Log out/in for key-repeat settings to fully apply."
