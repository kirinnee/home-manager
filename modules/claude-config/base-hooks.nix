# Base Claude Code settings for multi-account configuration
# Telegram notifications for when Claude needs your attention
# See: https://docs.anthropic.com/en/docs/claude-code/hooks
{
  # Single catch-all Notification hook - reads notification_type from stdin JSON
  # Official notification types: permission_prompt, idle_prompt
  Notification = [
    {
      matcher = "";
      hooks = [
        {
          type = "command";
          command = "$HOME/.config/home-manager/modules/claude-config/telegram-notify.sh";
        }
      ];
    }
  ];
  Stop = [
    {
      matcher = "";
      hooks = [
        {
          type = "command";
          command = "$HOME/.config/home-manager/modules/claude-config/telegram-notify.sh complete";
        }
        {
          type = "command";
          command = "$HOME/.nix-profile/bin/ccc hook-stop";
        }
      ];
    }
  ];
  PreToolUse = [
    {
      matcher = "Bash";
      hooks = [
        {
          type = "command";
          command = "$HOME/.claude/hooks/rtk-rewrite.sh";
        }
      ];
    }
    {
      hooks = [
        {
          command = "$HOME/.nix-profile/bin/ccc hook-permission";
          timeout = 300000;
          type = "command";
        }
      ];
      matcher = "";
    }
  ];
}
