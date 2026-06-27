# Base Claude Code settings for multi-account configuration
# Import this and use lib.recursiveUpdate to add account-specific settings

{
  model = "opus";
  defaultMode = "bypassPermissions";
  theme = "dark";
  alwaysThinkingEnabled = true;
  includeCoAuthoredBy = false;
  skipDangerousModePermissionPrompt = true;
  # Pin the terminal UI renderer ("default" = classic). Setting `tui` at all is
  # what suppresses the "try the new fullscreen renderer?" upsell prompt.
  tui = "default";

  # Statusline configuration - shows model, duration, and estimated cost
  # Inspired by p10k: model | dir git | duration | cost
  statusLine = {
    type = "command";
    command = "/bin/zsh ~/.config/claude-statusline.zsh";
  };
}
