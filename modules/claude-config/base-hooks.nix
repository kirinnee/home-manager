# Base Claude Code settings for multi-account configuration
{
  Notification = [
    {
      matcher = "";
      hooks = [
        {
          type = "command";
          command = "$HOME/.config/home-manager/modules/claude-config/speak-dir.sh 'Claude is waiting for you in'";
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
          command = "$HOME/.config/home-manager/modules/claude-config/speak-dir.sh 'Task complete in'";
        }
      ];
    }
  ];
}
