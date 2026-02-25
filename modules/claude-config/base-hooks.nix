# Base Claude Code settings for multi-account configuration
# Telegram notifications for when Claude needs your attention
{
  Notification = [
    # Permission prompts - Claude needs approval for a tool
    {
      matcher = "permission_prompt";
      hooks = [
        {
          type = "command";
          command = "$HOME/.config/home-manager/modules/claude-config/telegram-notify.sh permission";
        }
      ];
    }
    # Idle prompts - Claude has been waiting 60+ seconds
    {
      matcher = "idle_prompt";
      hooks = [
        {
          type = "command";
          command = "$HOME/.config/home-manager/modules/claude-config/telegram-notify.sh idle";
        }
      ];
    }
    # MCP tool elicitation - tool needs user input
    {
      matcher = "elicitation_dialog";
      hooks = [
        {
          type = "command";
          command = "$HOME/.config/home-manager/modules/claude-config/telegram-notify.sh elicitation";
        }
      ];
    }
    # Auth success - authentication completed
    {
      matcher = "auth_success";
      hooks = [
        {
          type = "command";
          command = "$HOME/.config/home-manager/modules/claude-config/telegram-notify.sh auth";
        }
      ];
    }
    # Generic notification fallback (empty matcher catches all)
    {
      matcher = "";
      hooks = [
        {
          type = "command";
          command = "$HOME/.config/home-manager/modules/claude-config/telegram-notify.sh notification";
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
      ];
    }
  ];
}
