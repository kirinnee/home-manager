# Base Claude Code settings for multi-account configuration
# Import this and use lib.recursiveUpdate to add account-specific settings

{
  model = "opus";
  theme = "dark";
  alwaysThinkingEnabled = true;
  includeCoAuthoredBy = false;

  # Statusline configuration - shows model, duration, and estimated cost
  # Inspired by p10k: model | dir git | duration | cost
  statusLine = {
    type = "command";
    command = "/bin/zsh ~/.config/claude-statusline.zsh";
  };
}
