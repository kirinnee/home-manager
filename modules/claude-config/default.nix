{ config, lib, pkgs, ... }:

let
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
in

let
  baseConfig = {
    model = "opus";
    inherit hooks;
    alwaysThinkingEnabled = true;
    attribution = {
      commit = "Co-authored by Claude Code";
      pr = "Co-authored by Claude Code";
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
  };
in
{
  # Personal Claude config (~/.claude)
  home.file.".claude/settings.json".text = builtins.toJSON (lib.recursiveUpdate baseConfig {
    env = {
      ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
      API_TIMEOUT_MS = "3000000";
    };
  });

  home.file.".claude/CLAUDE.md".source = ./CLAUDE.md;

  # Work Claude config (~/.claude-work)
  home.file.".claude-work/settings.json".text = builtins.toJSON (lib.recursiveUpdate baseConfig { });
  home.file.".claude-work/CLAUDE.md".source = ./CLAUDE.md;
}
