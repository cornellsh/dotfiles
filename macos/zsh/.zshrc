# ~/.zshrc — symlinked from ~/dotfiles/zsh/.zshrc

# --- Locale (SSH sessions often start with none → mangles UTF-8 glyphs like ❯) ---
export LANG="${LANG:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-en_US.UTF-8}"

# --- Homebrew (Apple Silicon) ---
eval "$(/opt/homebrew/bin/brew shellenv)"

# --- History ---
HISTFILE=~/.zsh_history
HISTSIZE=100000
SAVEHIST=100000
setopt SHARE_HISTORY HIST_IGNORE_ALL_DUPS HIST_REDUCE_BLANKS INC_APPEND_HISTORY

# --- Completion ---
autoload -Uz compinit && compinit
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'   # case-insensitive

# --- Aliases (modern replacements) ---
alias ls='eza --group-directories-first'
alias ll='eza -lah --group-directories-first --git'
alias tree='eza --tree'
alias cat='bat'
alias grep='rg'
alias find='fd'
alias cd='z'
alias g='git'

# --- Tool init ---
eval "$(starship init zsh)"
eval "$(zoxide init zsh)"
eval "$(mise activate zsh)"
source <(fzf --zsh)

# --- Plugins (order matters: syntax-highlighting last) ---
source "$(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
source "$(brew --prefix)/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"

# --- Secrets (untracked; see ~/.config/zsh/secrets.zsh) ---
[ -f "$HOME/.config/zsh/secrets.zsh" ] && source "$HOME/.config/zsh/secrets.zsh"

# --- Auto-attach tmux on SSH login ---
# When connecting in over the tailnet (or any SSH), drop straight into tmux so
# you see whatever is already running. Attaches to the most-recently-used
# existing session; if none exist, starts "main". Skipped if already in tmux.
if command -v tmux >/dev/null 2>&1 && [[ -n "$SSH_CONNECTION" && -z "$TMUX" && "$-" == *i* ]]; then
  if tmux has-session 2>/dev/null; then
    tmux attach
  else
    tmux new-session -s main
  fi
fi
