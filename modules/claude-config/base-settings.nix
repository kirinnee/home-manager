# Base Claude Code settings for multi-account configuration
# Import this and use lib.recursiveUpdate to add account-specific settings

{
  model = "opus";
  theme = "dark";
  alwaysThinkingEnabled = true;
  includeCoAuthoredBy = false;

  hooks = {
    Notification = [
      {
        matcher = "";
        hooks = [
          {
            type = "command";
            command = "speak 'Claude is waiting for you'";
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
            command = "speak 'Task complete'";
          }
        ];
      }
    ];
  };

  enabledPlugins = {
    "ralph-wiggum@tuannvm" = true;
  };

  extraKnownMarketplaces = {
    tuannvm = {
      source = {
        source = "github";
        repo = "tuannvm/plugins";
      };
    };
  };
}
